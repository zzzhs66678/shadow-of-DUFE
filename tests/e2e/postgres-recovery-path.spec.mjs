import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPasswordService } from "../../services/auth-api/src/passwords.mjs";
import { tokenDigest } from "../../services/auth-api/src/tokens.mjs";

test("mock SMTP recovery uses verified email, password proof, sessions and atomic native PostgreSQL", async ({}, info) => {
  const base = String(info.project.use.baseURL);
  const origin = new URL(base).origin;
  const mailbox = process.env.AUTH_TEST_MAILBOX_URL ?? "http://127.0.0.1:3111";
  const suffix = randomUUID().slice(0, 8);
  const originalPassword = "Moonlight!2026-long-passphrase";
  const newPassword = "NewHarbor!2027-long-passphrase";
  const cookies = (reply) => reply.headers.getSetCookie().map((v) => v.split(";", 1)[0]).join("; ");
  const post = (path, body, cookie = "") => fetch(`${base}/api/auth/${path}`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body),
  });
  async function mail(email, purpose) {
    let payload;
    await expect.poll(async () => {
      const reply = await fetch(`${mailbox}/?email=${encodeURIComponent(email)}${purpose ? `&purpose=${purpose}` : ""}`);
      if (reply.ok) payload = await reply.json();
      return Boolean(payload);
    }).toBe(true);
    return payload;
  }
  async function register(label) {
    const username = `recover-${label}-${suffix}`; const email = `${username}@example.com`;
    const challenge = await post("register/challenge", { email });
    expect(challenge.status).toBe(202); const pending = await challenge.json();
    const { code } = await mail(email);
    const reply = await post("register", { username, email, password: originalPassword, code, challengeId: pending.challengeId }, cookies(challenge));
    expect(reply.status).toBe(201); return { username, email, cookie: cookies(reply), user: (await reply.json()).user };
  }
  const owner = await register("owner"); const other = await register("other");
  const session = (cookie) => fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } }).then((r) => r.json());
  const legacyId = randomUUID(); const legacyEmail = `recover-legacy-${suffix}@example.com`;
  const pool = new pg.Pool({ host: process.env.PGHOST, port: Number(process.env.PGPORT), database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, max: 1 });
  try {
    await pool.query(`INSERT INTO app_users(id,username,normalized_username,email,normalized_email,registered_via)
      VALUES($1,$2,$2,$3,$3,'password')`, [legacyId, `legacy-${suffix}`, legacyEmail]);
    await pool.query("INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)",
      [legacyId, await createPasswordService().hash("OldHarbor!2026")]);
    for (const identifier of [legacyEmail, `nonexistent-${suffix}@example.com`]) {
      const reply = await post("password/reset/request", { identifier });
      expect(reply.status).toBe(202); expect(await reply.json()).toEqual({ ok: true });
    }
    const legacyLogin = await post("login", { identifier: legacyEmail, password: "OldHarbor!2026" });
    expect(legacyLogin.status).toBe(200); const legacyCookie = cookies(legacyLogin);
    expect((await session(legacyCookie)).user.emailVerified).toBe(false);
    const missing = await post("email/verification/request", {}, legacyCookie);
    expect(missing.status).toBe(400);
    const wrong = await post("email/verification/request", { password: "wrong" }, legacyCookie);
    expect(wrong.status).toBe(401);
    const request = await post("email/verification/request", { password: "OldHarbor!2026" }, legacyCookie);
    expect(request.status).toBe(202); expect(await request.json()).toEqual({ ok: true, expiresIn: 86400 });
    const { token } = await mail(legacyEmail, "verify");
    const secondLegacy = await post("login", { identifier: legacyEmail, password: "OldHarbor!2026" });
    expect((await post("email/verification/confirm", { token }, cookies(secondLegacy))).status).toBe(400);
    expect((await post("email/verification/confirm", { token }, other.cookie)).status).toBe(400);
    expect((await post("email/verification/confirm", { token }, legacyCookie)).status).toBe(200);
    expect((await post("email/verification/confirm", { token }, legacyCookie)).status).toBe(400);
    expect((await session(legacyCookie)).user.emailVerified).toBe(true);

    const secondOwner = await post("login", { identifier: owner.email, password: originalPassword });
    // Advance only this synthetic recipient's preceding send timestamp. The
    // production 60-second shared cooldown remains enabled in the real handler.
    await pool.query(`UPDATE security_mail_sends SET requested_at=requested_at-interval '61 seconds'
      WHERE recipient_digest=$1 AND status='sent'`, [tokenDigest(`mail:${owner.email}`, process.env.AUTH_TOKEN_PEPPER)]);
    const resetRequest = await post("password/reset/request", { identifier: owner.email });
    expect(resetRequest.status).toBe(202); expect(await resetRequest.json()).toEqual({ ok: true });
    const resetMail = await mail(owner.email, "reset");
    expect((await post("email/verification/confirm", { token: resetMail.token }, legacyCookie)).status).toBe(400);
    const replies = await Promise.all(Array.from({ length: 2 }, () => post("password/reset/confirm", { token: resetMail.token, password: newPassword })));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await session(owner.cookie)).authenticated).toBe(false);
    expect((await session(cookies(secondOwner))).authenticated).toBe(false);
    expect((await session(other.cookie)).authenticated).toBe(true);
    expect((await post("login", { identifier: owner.email, password: originalPassword })).status).toBe(401);
    expect((await post("login", { identifier: owner.email, password: newPassword })).status).toBe(200);
  } finally { await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [[legacyId, owner.user.id, other.user.id]]); await pool.end(); }
});
