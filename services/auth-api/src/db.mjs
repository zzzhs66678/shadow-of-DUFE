import pg from "pg";

const { Pool } = pg;

export function createDatabasePool(config) {
  const pool = new Pool({
    ...config.database,
    max: config.poolMax,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
    application_name: "dufesh-auth-api",
    keepAlive: true,
    maxUses: 7_500,
  });

  pool.on("error", (error) => {
    console.error("Unexpected idle PostgreSQL client error", error);
  });

  return pool;
}

export function createAuthStore(pool) {
  return {
    async health() {
      await pool.query("SELECT 1");
    },

    async getOrCreateAnonymousDevice(tokenHash) {
      const result = await pool.query(
        `INSERT INTO anonymous_devices (token_hash)
         VALUES ($1)
         ON CONFLICT (token_hash)
         DO UPDATE SET
           last_seen_at = CASE
             WHEN anonymous_devices.last_seen_at < now() - interval '5 minutes'
             THEN now()
             ELSE anonymous_devices.last_seen_at
           END
         RETURNING public_id`,
        [tokenHash],
      );

      return String(result.rows[0].public_id);
    },

    async getActiveSession(tokenHash) {
      const result = await pool.query(
        `SELECT
           sessions.id AS session_id,
           users.id AS user_id,
           users.display_name,
           users.avatar_url,
           sessions.expires_at
         FROM user_sessions AS sessions
         INNER JOIN app_users AS users ON users.id = sessions.user_id
         WHERE sessions.token_hash = $1
           AND sessions.revoked_at IS NULL
           AND sessions.expires_at > now()
           AND users.status = 'active'
         LIMIT 1`,
        [tokenHash],
      );

      if (result.rowCount === 0) return null;

      await pool.query(
        `UPDATE user_sessions
         SET last_seen_at = now()
         WHERE id = $1
           AND last_seen_at < now() - interval '5 minutes'`,
        [result.rows[0].session_id],
      );

      return {
        id: String(result.rows[0].session_id),
        userId: String(result.rows[0].user_id),
        displayName: result.rows[0].display_name,
        avatarUrl: result.rows[0].avatar_url,
        expiresAt: new Date(result.rows[0].expires_at).toISOString(),
      };
    },

    async revokeSession(tokenHash) {
      await pool.query(
        `UPDATE user_sessions
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE token_hash = $1`,
        [tokenHash],
      );
    },

    async close() {
      await pool.end();
    },
  };
}
