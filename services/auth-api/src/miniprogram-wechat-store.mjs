function rejected(code) {
  const error = new Error("Native WeChat operation was rejected");
  error.code = code;
  return error;
}

async function transaction(pool, run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function activePrincipal(client, userId, { expectedPasswordHash } = {}) {
  // Match recovery's account -> credential -> session lock ordering.
  const user = await client.query("SELECT status FROM app_users WHERE id = $1 FOR UPDATE", [userId]);
  if (user.rowCount !== 1 || user.rows[0].status !== "active") throw rejected("MINI_AUTHENTICATION_REQUIRED");
  if (expectedPasswordHash !== undefined) {
    const credential = await client.query(
      `SELECT password_hash, locked_until > clock_timestamp() AS locked
       FROM password_credentials WHERE user_id = $1 FOR UPDATE`, [userId]);
    if (credential.rowCount !== 1 || credential.rows[0].locked ||
        credential.rows[0].password_hash !== expectedPasswordHash) throw rejected("MINI_BINDING_CREDENTIALS_INVALID");
  }
}

async function exactSession(client, { userId, sessionId, sessionTokenHash }) {
  const session = await client.query(
    `SELECT id, expires_at FROM user_sessions
     WHERE id = $1 AND user_id = $2 AND token_hash = $3
       AND revoked_at IS NULL AND expires_at > clock_timestamp()
     FOR UPDATE`, [sessionId, userId, sessionTokenHash]);
  if (session.rowCount !== 1) throw rejected("MINI_AUTHENTICATION_REQUIRED");
  return session.rows[0];
}

export function createMiniProgramWechatStore({ pool, claimAnonymousDevice }) {
  return {
    async miniProgramWechatReady() {
      const result = await pool.query(
        `SELECT to_regclass('public.miniprogram_wechat_identities') IS NOT NULL
          AND to_regclass('public.miniprogram_wechat_challenges') IS NOT NULL AS ready`);
      return result.rows[0]?.ready === true;
    },
    async getMiniProgramWechatIdentity({ appId, openidHash }) {
      const result = await pool.query(
        "SELECT user_id FROM miniprogram_wechat_identities WHERE app_id = $1 AND openid_hash = $2",
        [appId, openidHash]);
      return result.rowCount ? { userId: String(result.rows[0].user_id) } : null;
    },

    async hasMiniProgramWechatIdentity({ appId, userId }) {
      const result = await pool.query(
        "SELECT 1 FROM miniprogram_wechat_identities WHERE app_id = $1 AND user_id = $2", [appId, userId]);
      return result.rowCount === 1;
    },

    async getMiniProgramCredentialPrincipal(userId) {
      const result = await pool.query(
        `SELECT users.id, users.status, credentials.password_hash, credentials.locked_until
         FROM app_users AS users JOIN password_credentials AS credentials ON credentials.user_id = users.id
         WHERE users.id = $1`, [userId]);
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return { id: String(row.id), status: row.status, passwordHash: row.password_hash,
        lockedUntil: row.locked_until ? new Date(row.locked_until).toISOString() : null };
    },

    async createMiniProgramWechatChallenge(input) {
      return transaction(pool, async client => {
        if (input.userId) {
          await activePrincipal(client, input.userId);
          await exactSession(client, input);
          // A newly requested challenge replaces pending challenges for this
          // precise session. It cannot revive challenges from another session.
          await client.query(
            `UPDATE miniprogram_wechat_challenges SET consumed_at = clock_timestamp()
             WHERE session_id = $1 AND consumed_at IS NULL`, [input.sessionId]);
        }
        const challenge = await client.query(
          `INSERT INTO miniprogram_wechat_challenges
           (token_hash, app_id, openid_hash, user_id, session_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '5 minutes')
           RETURNING expires_at`,
          [input.challengeHash, input.appId, input.openidHash, input.userId ?? null, input.sessionId ?? null]);
        await client.query(
          `DELETE FROM miniprogram_wechat_challenges WHERE id IN
           (SELECT id FROM miniprogram_wechat_challenges WHERE expires_at <= clock_timestamp()
            ORDER BY expires_at LIMIT 100)`);
        return { expiresAt: new Date(challenge.rows[0].expires_at).toISOString() };
      });
    },

    async bindMiniProgramWechatIdentity(input) {
      return transaction(pool, async client => {
        await activePrincipal(client, input.userId, input);
        await exactSession(client, input);
        const challenge = await client.query(
          `SELECT app_id, openid_hash FROM miniprogram_wechat_challenges
           WHERE token_hash = $1 AND app_id = $2 AND user_id = $3 AND session_id = $4
             AND consumed_at IS NULL AND expires_at > clock_timestamp()
           FOR UPDATE`, [input.challengeHash, input.appId, input.userId, input.sessionId]);
        if (challenge.rowCount !== 1) throw rejected("MINI_BINDING_CHALLENGE_INVALID");
        const openidHash = challenge.rows[0].openid_hash;
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mini-wechat:${input.appId}:${openidHash}`]);
        const current = await client.query(
          `SELECT user_id FROM miniprogram_wechat_identities
           WHERE app_id = $1 AND (openid_hash = $2 OR user_id = $3)`, [input.appId, openidHash, input.userId]);
        if (current.rowCount) {
          // No implicit account merge, replacement, or unlink. Even a different
          // WeChat identity owned by this UUID conflicts with a new binding.
          const exact = await client.query(
            `SELECT user_id FROM miniprogram_wechat_identities
             WHERE app_id = $1 AND openid_hash = $2 AND user_id = $3`, [input.appId, openidHash, input.userId]);
          if (exact.rowCount !== 1 || current.rowCount !== 1) throw rejected("MINI_WECHAT_ACCOUNT_CONFLICT");
        } else {
          try {
            await client.query(
              `INSERT INTO miniprogram_wechat_identities(app_id, openid_hash, user_id) VALUES($1, $2, $3)`,
              [input.appId, openidHash, input.userId]);
          } catch (error) {
            if (error.code === "23505") throw rejected("MINI_WECHAT_ACCOUNT_CONFLICT");
            throw error;
          }
        }
        await client.query(
          "UPDATE miniprogram_wechat_challenges SET consumed_at = clock_timestamp() WHERE token_hash = $1", [input.challengeHash]);
        await client.query(
          "UPDATE password_credentials SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE user_id = $1", [input.userId]);
        return { linked: true };
      });
    },

    async createMiniProgramWechatSession(input) {
      return transaction(pool, async client => {
        await activePrincipal(client, input.userId);
        const identity = await client.query(
          `SELECT id FROM miniprogram_wechat_identities
           WHERE app_id = $1 AND openid_hash = $2 AND user_id = $3 FOR KEY SHARE`,
          [input.appId, input.openidHash, input.userId]);
        if (identity.rowCount !== 1) throw rejected("MINI_AUTHENTICATION_REQUIRED");
        const deviceId = await claimAnonymousDevice(client, input.anonymousDeviceId, input.userId);
        const session = await client.query(
          `INSERT INTO user_sessions(user_id, device_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4) RETURNING id, expires_at`,
          [input.userId, deviceId, input.sessionTokenHash, input.sessionExpiresAt]);
        await client.query("UPDATE app_users SET last_login_at = now(), updated_at = now() WHERE id = $1", [input.userId]);
        return { sessionId: String(session.rows[0].id), expiresAt: new Date(session.rows[0].expires_at).toISOString() };
      });
    },
  };
}
