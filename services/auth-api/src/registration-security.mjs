import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

export const REGISTRATION_POLICY = Object.freeze({
  ttlSeconds: 300, cooldownSeconds: 60, maxAttempts: 5,
  attemptWindowSeconds: 3600, emailHourly: 5, emailDaily: 10,
  globalHourly: 100, globalDaily: 500, mailConcurrency: 2,
  mailLeaseSeconds: 60, maxChallenges: 5000,
});

export function createRegistrationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function registrationDigest({ challengeId, email, code, purpose = "registration" }, key) {
  return createHmac("sha256", key).update(JSON.stringify([purpose, challengeId, email, code])).digest("hex");
}

function equalDigest(a, b) {
  return /^[a-f0-9]{64}$/u.test(a ?? "") && /^[a-f0-9]{64}$/u.test(b ?? "") &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// The caller holds this lock through reserving the send and creating a challenge.
// SMTP runs outside the transaction; only a successfully delivered challenge is usable.
export async function reserveMail(client, recipientDigest, policy) {
  await client.query("SELECT pg_advisory_xact_lock(711011, 1)");
  await client.query("DELETE FROM security_mail_sends WHERE requested_at < clock_timestamp() - interval '1 day'");
  const budgets = await client.query(`SELECT
    count(*) FILTER (WHERE recipient_digest=$1 AND requested_at > clock_timestamp()-interval '1 hour')::int AS email_hour,
    count(*) FILTER (WHERE recipient_digest=$1)::int AS email_day,
    count(*) FILTER (WHERE requested_at > clock_timestamp()-interval '1 hour')::int AS global_hour,
    count(*)::int AS global_day,
    count(*) FILTER (WHERE status='sending' AND lease_until > clock_timestamp())::int AS active,
    count(*) FILTER (WHERE recipient_digest=$1 AND requested_at > clock_timestamp()-$2*interval '1 second')::int AS recent
    FROM security_mail_sends`, [recipientDigest, policy.cooldownSeconds]);
  const b = budgets.rows[0];
  if (b.email_hour >= policy.emailHourly || b.email_day >= policy.emailDaily ||
      b.global_hour >= policy.globalHourly || b.global_day >= policy.globalDaily ||
      b.active >= policy.mailConcurrency || b.recent > 0) return null;
  const id = randomUUID();
  await client.query(`INSERT INTO security_mail_sends(id,recipient_digest,lease_until)
    VALUES($1,$2,clock_timestamp()+$3*interval '1 second')`, [id, recipientDigest, policy.mailLeaseSeconds]);
  return id;
}

export function createRegistrationStore(pool) {
  return {
    async cleanupSecurityState() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(711011, 1)");
        await client.query("DELETE FROM registration_challenges WHERE expires_at <= clock_timestamp()");
        await client.query(`DELETE FROM registration_email_attempts AS states WHERE reset_at <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM registration_challenges WHERE email_digest=states.email_digest)`);
        await client.query("DELETE FROM security_mail_sends WHERE requested_at < clock_timestamp()-interval '1 day'");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async reserveSecurityMail({ recipientDigest, policy = REGISTRATION_POLICY }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const id = await reserveMail(client, recipientDigest, policy);
        await client.query("COMMIT");
        return id;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async createRegistrationChallenge({ id, email, emailDigest, codeHash, browserHash, policy = REGISTRATION_POLICY }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const sendId = await reserveMail(client, emailDigest, policy);
        // Global budget bounds database growth even for suppressed/failed mail.
        await client.query("DELETE FROM registration_challenges WHERE expires_at <= clock_timestamp()");
        await client.query(`DELETE FROM registration_email_attempts AS states WHERE reset_at <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM registration_challenges WHERE email_digest=states.email_digest)`);
        const count = await client.query("SELECT count(*)::int AS count FROM registration_challenges");
        if (!sendId || count.rows[0].count >= policy.maxChallenges) {
          await client.query("COMMIT"); return null;
        }
        await client.query(`INSERT INTO registration_email_attempts(email_digest,reset_at)
          VALUES($1,clock_timestamp()+$2*interval '1 second') ON CONFLICT DO NOTHING`, [emailDigest, policy.attemptWindowSeconds]);
        await client.query("SELECT email_digest FROM registration_email_attempts WHERE email_digest=$1 FOR UPDATE", [emailDigest]);
        await client.query("UPDATE registration_challenges SET consumed_at=clock_timestamp() WHERE normalized_email=$1 AND consumed_at IS NULL", [email]);
        const existing = await client.query("SELECT 1 FROM app_users WHERE normalized_email=$1", [email]);
        const result = await client.query(`INSERT INTO registration_challenges(id,normalized_email,email_digest,code_hash,browser_hash,mail_send_id,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 second') RETURNING expires_at`,
          [id, email, emailDigest, codeHash, browserHash, sendId, policy.ttlSeconds]);
        await client.query("COMMIT");
        return { sendId, shouldSend: existing.rowCount === 0, expiresAt: new Date(result.rows[0].expires_at) };
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async finishSecurityMail({ sendId, challengeId = null, delivered }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const sent = await client.query(`UPDATE security_mail_sends SET status=$2
          WHERE id=$1 AND status='sending' AND lease_until>clock_timestamp() RETURNING id`, [sendId, delivered ? "sent" : "failed"]);
        if (challengeId && delivered && sent.rowCount) await client.query(`UPDATE registration_challenges SET delivered_at=clock_timestamp()
          WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, [challengeId]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
  };
}

// Runs inside the SAME transaction as user, password, device and session insertion.
// Failures are committed by the caller to retain the attempts; success is rolled
// back together with the user if any later database operation fails.
export async function consumeRegistrationProof(client, proof, email, policy = REGISTRATION_POLICY) {
  if (!proof) return false;
  const state = await client.query("SELECT * FROM registration_email_attempts WHERE email_digest=$1 FOR UPDATE", [proof.emailDigest]);
  if (!state.rowCount) return false;
  await client.query(`UPDATE registration_email_attempts SET attempts=0,reset_at=clock_timestamp()+$2*interval '1 second'
    WHERE email_digest=$1 AND reset_at<=clock_timestamp()`, [proof.emailDigest, policy.attemptWindowSeconds]);
  const budget = await client.query("SELECT attempts FROM registration_email_attempts WHERE email_digest=$1", [proof.emailDigest]);
  const result = await client.query(`SELECT * FROM registration_challenges
    WHERE id=$1 AND normalized_email=$2 AND email_digest=$3 AND purpose='registration'
    AND consumed_at IS NULL AND delivered_at IS NOT NULL AND expires_at>clock_timestamp() FOR UPDATE`,
    [proof.challengeId, email, proof.emailDigest]);
  const challenge = result.rows[0];
  const valid = budget.rows[0].attempts < policy.maxAttempts && challenge && challenge.attempts < policy.maxAttempts &&
    equalDigest(challenge.code_hash, proof.codeHash) && equalDigest(challenge.browser_hash, proof.browserHash);
  if (!valid) {
    await client.query("UPDATE registration_email_attempts SET attempts=LEAST(attempts+1,$2) WHERE email_digest=$1", [proof.emailDigest, policy.maxAttempts]);
    if (challenge) await client.query("UPDATE registration_challenges SET attempts=LEAST(attempts+1,$2) WHERE id=$1", [proof.challengeId, policy.maxAttempts]);
    return false;
  }
  await client.query("UPDATE registration_challenges SET consumed_at=clock_timestamp() WHERE id=$1", [proof.challengeId]);
  return true;
}
