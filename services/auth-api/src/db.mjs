import pg from "pg";
import { createPersonalStore } from "./personal-store.mjs";

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
  const personalStore = createPersonalStore(pool);

  return {
    ...personalStore,
    async health() {
      await pool.query("SELECT 1");
    },

    async getOrCreateAnonymousDevice(tokenHash) {
      const existing = await pool.query(
        `SELECT id, public_id, last_seen_at
         FROM anonymous_devices
         WHERE token_hash = $1
           AND revoked_at IS NULL
         LIMIT 1`,
        [tokenHash],
      );

      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        if (Date.now() - new Date(row.last_seen_at).getTime() >= 300_000) {
          await pool.query(
            `UPDATE anonymous_devices
             SET last_seen_at = now()
             WHERE token_hash = $1
               AND last_seen_at < now() - interval '5 minutes'`,
            [tokenHash],
          );
        }
        return { id: String(row.id), publicId: String(row.public_id) };
      }

      const inserted = await pool.query(
        `INSERT INTO anonymous_devices (token_hash)
         VALUES ($1)
         ON CONFLICT (token_hash) DO NOTHING
         RETURNING id, public_id`,
        [tokenHash],
      );

      if (inserted.rowCount > 0) {
        return {
          id: String(inserted.rows[0].id),
          publicId: String(inserted.rows[0].public_id),
        };
      }

      const raced = await pool.query(
        `SELECT id, public_id
         FROM anonymous_devices
         WHERE token_hash = $1
           AND revoked_at IS NULL
         LIMIT 1`,
        [tokenHash],
      );

      if (raced.rowCount === 0) {
        throw new Error("anonymous device could not be resolved");
      }

      return {
        id: String(raced.rows[0].id),
        publicId: String(raced.rows[0].public_id),
      };
    },

    async createOAuthTransaction({
      provider,
      stateHash,
      browserTokenHash,
      anonymousDeviceId,
      returnTo,
      expiresAt,
    }) {
      await pool.query(
        `INSERT INTO oauth_transactions (
           provider,
           state_hash,
           browser_token_hash,
           anonymous_device_id,
           return_to,
           expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          provider,
          stateHash,
          browserTokenHash,
          anonymousDeviceId,
          returnTo,
          expiresAt,
        ],
      );

      await pool.query(
        `DELETE FROM oauth_transactions
         WHERE id IN (
           SELECT id
           FROM oauth_transactions
           WHERE expires_at < now() - interval '1 day'
           ORDER BY expires_at
           LIMIT 100
         )`,
      );
    },

    async consumeOAuthAndCreateSession({
      provider,
      stateHash,
      browserTokenHash,
      identity,
      sessionTokenHash,
      sessionExpiresAt,
    }) {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const transaction = await client.query(
          `UPDATE oauth_transactions
           SET consumed_at = now()
           WHERE provider = $1
             AND state_hash = $2
             AND browser_token_hash = $3
             AND consumed_at IS NULL
             AND expires_at > now()
           RETURNING id, anonymous_device_id, return_to`,
          [provider, stateHash, browserTokenHash],
        );

        if (transaction.rowCount === 0) {
          const error = new Error("OAuth transaction is invalid or expired");
          error.code = "AUTH_OAUTH_TRANSACTION_INVALID";
          throw error;
        }

        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`${provider}:${identity.subject}`],
        );

        const existingIdentity = await client.query(
          `SELECT user_id
           FROM oauth_identities
           WHERE provider = $1
             AND provider_subject = $2
           LIMIT 1`,
          [provider, identity.subject],
        );

        let userId;
        if (existingIdentity.rowCount > 0) {
          userId = existingIdentity.rows[0].user_id;
          await client.query(
            `UPDATE app_users
             SET
               display_name = COALESCE($2, display_name),
               avatar_url = COALESCE($3, avatar_url),
               updated_at = now()
             WHERE id = $1`,
            [userId, identity.displayName, identity.avatarUrl],
          );
          await client.query(
            `UPDATE oauth_identities
             SET
               union_id = COALESCE($3, union_id),
               profile = $4::jsonb,
               last_login_at = now()
             WHERE provider = $1
               AND provider_subject = $2`,
            [
              provider,
              identity.subject,
              identity.unionId,
              JSON.stringify(identity.profile ?? {}),
            ],
          );
        } else {
          const user = await client.query(
            `INSERT INTO app_users (display_name, avatar_url)
             VALUES ($1, $2)
             RETURNING id`,
            [identity.displayName, identity.avatarUrl],
          );
          userId = user.rows[0].id;
          await client.query(
            `INSERT INTO oauth_identities (
               user_id,
               provider,
               provider_subject,
               union_id,
               profile,
               last_login_at
             )
             VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
            [
              userId,
              provider,
              identity.subject,
              identity.unionId,
              JSON.stringify(identity.profile ?? {}),
            ],
          );
        }

        const anonymousDeviceId =
          transaction.rows[0].anonymous_device_id;
        const anonymousDevice = await client.query(
          `SELECT claimed_device_id
           FROM anonymous_devices
           WHERE id = $1
             AND revoked_at IS NULL
           FOR UPDATE`,
          [anonymousDeviceId],
        );

        if (anonymousDevice.rowCount === 0) {
          const error = new Error("Anonymous device is unavailable");
          error.code = "AUTH_ANONYMOUS_DEVICE_INVALID";
          throw error;
        }

        let deviceId = anonymousDevice.rows[0].claimed_device_id;
        if (deviceId) {
          const claimed = await client.query(
            `SELECT user_id
             FROM user_devices
             WHERE id = $1
               AND revoked_at IS NULL`,
            [deviceId],
          );
          if (
            claimed.rowCount === 0 ||
            String(claimed.rows[0].user_id) !== String(userId)
          ) {
            deviceId = null;
          }
        }

        if (!deviceId) {
          const device = await client.query(
            `INSERT INTO user_devices (user_id, label, platform)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [userId, "网页设备", "web"],
          );
          deviceId = device.rows[0].id;
          await client.query(
            `UPDATE anonymous_devices
             SET
               claimed_device_id = $2,
               claimed_at = now(),
               last_seen_at = now()
             WHERE id = $1`,
            [anonymousDeviceId, deviceId],
          );
        }

        const session = await client.query(
          `INSERT INTO user_sessions (
             user_id,
             device_id,
             token_hash,
             expires_at
           )
           VALUES ($1, $2, $3, $4)
           RETURNING id, expires_at`,
          [userId, deviceId, sessionTokenHash, sessionExpiresAt],
        );

        await client.query("COMMIT");

        return {
          userId: String(userId),
          sessionId: String(session.rows[0].id),
          expiresAt: new Date(session.rows[0].expires_at).toISOString(),
          returnTo: transaction.rows[0].return_to,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
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
