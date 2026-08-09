import pg from "pg";
import { createPersonalStore } from "./personal-store.mjs";
import { createCommunityStore } from "./community-store.mjs";
import { createTeacherReviewStore } from "./teacher-review-store.mjs";

const { Pool } = pg;

async function claimAnonymousDevice(client, anonymousDeviceId, userId) {
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
  }

  await client.query(
    `UPDATE anonymous_devices
     SET
       claimed_device_id = $2,
       claimed_at = COALESCE(claimed_at, now()),
       last_seen_at = now()
     WHERE id = $1`,
    [anonymousDeviceId, deviceId],
  );
  await client.query(
    `UPDATE user_devices
     SET last_seen_at = now()
     WHERE id = $1`,
    [deviceId],
  );
  return deviceId;
}

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
  const communityStore = createCommunityStore(pool);
  const teacherReviewStore = createTeacherReviewStore(pool);

  return {
    ...personalStore,
    ...communityStore,
    ...teacherReviewStore,
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
               last_login_at = now(),
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
           users.username,
           users.display_name,
           users.avatar_url,
           users.email,
           users.email_verified_at,
           users.school_account,
           users.school_account_verified_at,
           users.created_at,
           users.last_login_at,
           users.status,
           users.role,
           sessions.expires_at,
           devices.public_id AS device_public_id
         FROM user_sessions AS sessions
         INNER JOIN app_users AS users ON users.id = sessions.user_id
         LEFT JOIN user_devices AS devices ON devices.id = sessions.device_id
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
        username: result.rows[0].username,
        displayName: result.rows[0].display_name,
        avatarUrl: result.rows[0].avatar_url,
        email: result.rows[0].email,
        emailVerified: Boolean(result.rows[0].email_verified_at),
        schoolAccount: result.rows[0].school_account,
        schoolAccountVerified: Boolean(
          result.rows[0].school_account_verified_at,
        ),
        createdAt: new Date(result.rows[0].created_at).toISOString(),
        lastLoginAt: result.rows[0].last_login_at
          ? new Date(result.rows[0].last_login_at).toISOString()
          : null,
        status: result.rows[0].status,
        role: result.rows[0].role,
        expiresAt: new Date(result.rows[0].expires_at).toISOString(),
        deviceId: result.rows[0].device_public_id
          ? String(result.rows[0].device_public_id)
          : null,
      };
    },

    async getUserProfile(userId) {
      const result = await pool.query(
        `SELECT
           id,
           username,
           display_name,
           avatar_url,
           email,
           email_verified_at,
           school_account,
           school_account_verified_at,
           created_at,
           last_login_at,
           status
         FROM app_users
         WHERE id = $1
           AND status <> 'deleted'
         LIMIT 1`,
        [userId],
      );
      if (result.rowCount === 0) return null;
      const row = result.rows[0];
      return {
        id: String(row.id),
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        email: row.email,
        emailVerified: Boolean(row.email_verified_at),
        schoolAccount: row.school_account,
        schoolAccountVerified: Boolean(row.school_account_verified_at),
        createdAt: new Date(row.created_at).toISOString(),
        lastLoginAt: row.last_login_at
          ? new Date(row.last_login_at).toISOString()
          : null,
        status: row.status,
      };
    },

    async updateUserProfile(userId, update) {
      try {
        const result = await pool.query(
          `UPDATE app_users
           SET
             username = CASE WHEN $2 THEN $3 ELSE username END,
             normalized_username = CASE WHEN $2 THEN $4 ELSE normalized_username END,
             display_name = CASE WHEN $5 THEN $6 ELSE display_name END,
             school_account = CASE WHEN $7 THEN $8 ELSE school_account END,
             school_account_verified_at = CASE
               WHEN $7 AND school_account IS DISTINCT FROM $8 THEN NULL
               ELSE school_account_verified_at
             END,
             updated_at = now()
           WHERE id = $1
             AND status = 'active'
           RETURNING id`,
          [
            userId,
            Object.hasOwn(update, "username"),
            update.username ?? null,
            update.normalizedUsername ?? null,
            Object.hasOwn(update, "displayName"),
            update.displayName ?? null,
            Object.hasOwn(update, "schoolAccount"),
            update.schoolAccount ?? null,
          ],
        );
        if (result.rowCount === 0) return null;
        return this.getUserProfile(userId);
      } catch (error) {
        if (
          error?.code === "23505" &&
          error?.constraint === "app_users_normalized_username_uidx"
        ) {
          error.code = "AUTH_USERNAME_TAKEN";
        }
        throw error;
      }
    },

    async getUserAvatar(userId) {
      const result = await pool.query(
        `SELECT a.content_type, a.image_bytes, a.sha256, a.byte_size
         FROM user_avatars a
         JOIN app_users u ON u.id = a.user_id
         WHERE a.user_id = $1
           AND u.status = 'active'
         LIMIT 1`,
        [userId],
      );
      if (result.rowCount === 0) return null;
      return {
        contentType: result.rows[0].content_type,
        bytes: result.rows[0].image_bytes,
        sha256: result.rows[0].sha256,
        byteSize: result.rows[0].byte_size,
      };
    },

    async saveUserAvatar(userId, avatar) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const active = await client.query(
          `SELECT id
           FROM app_users
           WHERE id = $1
             AND status = 'active'
           FOR UPDATE`,
          [userId],
        );
        if (active.rowCount === 0) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query(
          `INSERT INTO user_avatars (
             user_id,
             content_type,
             image_bytes,
             sha256,
             width,
             height,
             byte_size
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id) DO UPDATE SET
             content_type = EXCLUDED.content_type,
             image_bytes = EXCLUDED.image_bytes,
             sha256 = EXCLUDED.sha256,
             width = EXCLUDED.width,
             height = EXCLUDED.height,
             byte_size = EXCLUDED.byte_size,
             updated_at = now()`,
          [
            userId,
            avatar.contentType,
            avatar.bytes,
            avatar.sha256,
            avatar.width,
            avatar.height,
            avatar.byteSize,
          ],
        );
        const avatarUrl = `/api/auth/avatars/${userId}?v=${avatar.sha256.slice(0, 16)}`;
        await client.query(
          `UPDATE app_users
           SET avatar_url = $2, updated_at = now()
           WHERE id = $1`,
          [userId, avatarUrl],
        );
        await client.query("COMMIT");
        return { avatarUrl };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteUserAvatar(userId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const deleted = await client.query(
          `DELETE FROM user_avatars
           WHERE user_id = $1
           RETURNING user_id`,
          [userId],
        );
        await client.query(
          `UPDATE app_users
           SET avatar_url = NULL, updated_at = now()
           WHERE id = $1`,
          [userId],
        );
        await client.query("COMMIT");
        return deleted.rowCount > 0;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async getAdminBootstrapTarget(normalizedIdentifier) {
      const result = await pool.query(
        `SELECT
           users.id,
           users.username,
           users.email,
           users.status,
           users.role,
           EXISTS (
             SELECT 1
             FROM admin_mfa_credentials AS mfa
             WHERE mfa.user_id = users.id
           ) AS mfa_configured
         FROM app_users AS users
         WHERE users.normalized_username = $1
            OR users.normalized_email = $1
         LIMIT 1`,
        [normalizedIdentifier],
      );
      if (result.rowCount === 0) return null;
      const row = result.rows[0];
      return {
        id: String(row.id),
        username: row.username,
        email: row.email,
        status: row.status,
        role: row.role,
        mfaConfigured: Boolean(row.mfa_configured),
      };
    },

    async bootstrapAdmin({ userId, enrollment, rotate = false }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const target = await client.query(
          `SELECT id, role, status
           FROM app_users
           WHERE id = $1
           FOR UPDATE`,
          [userId],
        );
        if (target.rowCount === 0 || target.rows[0].status !== "active") {
          const error = new Error("admin bootstrap target is unavailable");
          error.code = "AUTH_ADMIN_BOOTSTRAP_TARGET_INVALID";
          throw error;
        }
        const existing = await client.query(
          `SELECT id
           FROM admin_mfa_credentials
           WHERE user_id = $1
           FOR UPDATE`,
          [userId],
        );
        if (existing.rowCount > 0 && !rotate) {
          const error = new Error("admin MFA already exists");
          error.code = "AUTH_ADMIN_MFA_ALREADY_CONFIGURED";
          throw error;
        }
        await client.query(
          `INSERT INTO admin_mfa_credentials (
             id,
             user_id,
             key_id,
             encrypted_secret,
             secret_iv,
             secret_auth_tag,
             last_totp_step,
             rotated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, NULL, CASE WHEN $7 THEN now() ELSE NULL END)
           ON CONFLICT (user_id) DO UPDATE SET
             id = EXCLUDED.id,
             key_id = EXCLUDED.key_id,
             encrypted_secret = EXCLUDED.encrypted_secret,
             secret_iv = EXCLUDED.secret_iv,
             secret_auth_tag = EXCLUDED.secret_auth_tag,
             last_totp_step = NULL,
             rotated_at = now(),
             updated_at = now()`,
          [
            enrollment.factorId,
            userId,
            enrollment.encrypted.keyId,
            enrollment.encrypted.encryptedSecret,
            enrollment.encrypted.secretIv,
            enrollment.encrypted.secretAuthTag,
            rotate,
          ],
        );
        await client.query(
          `DELETE FROM admin_recovery_codes
           WHERE user_id = $1`,
          [userId],
        );
        await client.query(
          `INSERT INTO admin_recovery_codes (user_id, code_hash)
           SELECT $1, code_hash
           FROM unnest($2::text[]) AS code_hash`,
          [userId, enrollment.recoveryCodeHashes],
        );
        await client.query(
          `UPDATE app_users
           SET role = 'admin', updated_at = now()
           WHERE id = $1`,
          [userId],
        );
        await client.query(
          `UPDATE user_sessions
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1`,
          [userId],
        );
        await client.query(
          `UPDATE admin_elevated_sessions
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1`,
          [userId],
        );
        await client.query(
          `INSERT INTO admin_audit_events (
             action,
             target_type,
             target_id,
             metadata
           )
           VALUES ('admin.bootstrap', 'user', $1, $2::jsonb)`,
          [
            userId,
            JSON.stringify({
              rotated: existing.rowCount > 0,
              previousRole: target.rows[0].role,
            }),
          ],
        );
        await client.query("COMMIT");
        return { userId, sessionsRevoked: true };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async getAdminMfaCredential(userId) {
      const result = await pool.query(
        `SELECT
           mfa.id,
           mfa.key_id,
           mfa.encrypted_secret,
           mfa.secret_iv,
           mfa.secret_auth_tag,
           mfa.last_totp_step
         FROM admin_mfa_credentials AS mfa
         INNER JOIN app_users AS users ON users.id = mfa.user_id
         WHERE mfa.user_id = $1
           AND users.status = 'active'
           AND users.role = 'admin'
         LIMIT 1`,
        [userId],
      );
      if (result.rowCount === 0) return null;
      const row = result.rows[0];
      return {
        factorId: String(row.id),
        encrypted: {
          keyId: row.key_id,
          encryptedSecret: row.encrypted_secret,
          secretIv: row.secret_iv,
          secretAuthTag: row.secret_auth_tag,
        },
        lastTotpStep:
          row.last_totp_step === null ? null : Number(row.last_totp_step),
      };
    },

    async getAdminAccessState({ userId, sessionId, elevationTokenHash }) {
      const result = await pool.query(
        `SELECT
           EXISTS (
             SELECT 1
             FROM admin_mfa_credentials AS mfa
             WHERE mfa.user_id = users.id
           ) AS mfa_configured,
           elevation.expires_at AS elevated_until
         FROM app_users AS users
         LEFT JOIN admin_elevated_sessions AS elevation
           ON elevation.user_id = users.id
          AND elevation.base_session_id = $2
          AND elevation.token_hash = $3
          AND elevation.revoked_at IS NULL
          AND elevation.expires_at > now()
         WHERE users.id = $1
           AND users.status = 'active'
           AND users.role = 'admin'
         LIMIT 1`,
        [userId, sessionId, elevationTokenHash],
      );
      if (result.rowCount === 0) return null;
      return {
        mfaConfigured: Boolean(result.rows[0].mfa_configured),
        elevated: Boolean(result.rows[0].elevated_until),
        elevatedUntil: result.rows[0].elevated_until
          ? new Date(result.rows[0].elevated_until).toISOString()
          : null,
      };
    },

    async createAdminElevationFromTotp(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const consumed = await client.query(
          `UPDATE admin_mfa_credentials AS mfa
           SET last_totp_step = $3, updated_at = now()
           WHERE mfa.user_id = $1
             AND (mfa.last_totp_step IS NULL OR mfa.last_totp_step < $3)
             AND EXISTS (
               SELECT 1
               FROM app_users AS users
               WHERE users.id = mfa.user_id
                 AND users.status = 'active'
                 AND users.role = 'admin'
             )
             AND EXISTS (
               SELECT 1
               FROM user_sessions AS sessions
               WHERE sessions.id = $2
                 AND sessions.user_id = mfa.user_id
                 AND sessions.revoked_at IS NULL
                 AND sessions.expires_at > now()
             )
           RETURNING mfa.id`,
          [input.userId, input.sessionId, input.matchedStep],
        );
        if (consumed.rowCount === 0) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          `UPDATE admin_elevated_sessions
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE base_session_id = $1
             AND revoked_at IS NULL`,
          [input.sessionId],
        );
        await client.query(
          `INSERT INTO admin_elevated_sessions (
             user_id,
             base_session_id,
             token_hash,
             method,
             expires_at,
             ip_hash,
             user_agent_hash
           )
           VALUES ($1, $2, $3, 'totp', $4, $5, $6)`,
          [
            input.userId,
            input.sessionId,
            input.tokenHash,
            input.expiresAt,
            input.ipHash,
            input.userAgentHash,
          ],
        );
        await client.query(
          `INSERT INTO admin_audit_events (
             actor_user_id,
             actor_role,
             session_id,
             action,
             request_id,
             ip_hash,
             user_agent_hash,
             metadata
           )
           VALUES ($1, 'admin', $2, 'admin.elevation.created', $3, $4, $5,
                   '{"method":"totp"}'::jsonb)`,
          [
            input.userId,
            input.sessionId,
            input.requestId,
            input.ipHash,
            input.userAgentHash,
          ],
        );
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async createAdminElevationFromRecovery(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const consumed = await client.query(
          `UPDATE admin_recovery_codes AS codes
           SET consumed_at = now()
           WHERE codes.user_id = $1
             AND codes.code_hash = $3
             AND codes.consumed_at IS NULL
             AND EXISTS (
               SELECT 1
               FROM app_users AS users
               WHERE users.id = codes.user_id
                 AND users.status = 'active'
                 AND users.role = 'admin'
             )
             AND EXISTS (
               SELECT 1
               FROM user_sessions AS sessions
               WHERE sessions.id = $2
                 AND sessions.user_id = codes.user_id
                 AND sessions.revoked_at IS NULL
                 AND sessions.expires_at > now()
             )
           RETURNING codes.id`,
          [input.userId, input.sessionId, input.recoveryCodeHash],
        );
        if (consumed.rowCount === 0) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          `UPDATE admin_elevated_sessions
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE base_session_id = $1
             AND revoked_at IS NULL`,
          [input.sessionId],
        );
        await client.query(
          `INSERT INTO admin_elevated_sessions (
             user_id,
             base_session_id,
             token_hash,
             method,
             expires_at,
             ip_hash,
             user_agent_hash
           )
           VALUES ($1, $2, $3, 'recovery_code', $4, $5, $6)`,
          [
            input.userId,
            input.sessionId,
            input.tokenHash,
            input.expiresAt,
            input.ipHash,
            input.userAgentHash,
          ],
        );
        await client.query(
          `INSERT INTO admin_audit_events (
             actor_user_id,
             actor_role,
             session_id,
             action,
             request_id,
             ip_hash,
             user_agent_hash,
             metadata
           )
           VALUES ($1, 'admin', $2, 'admin.elevation.created', $3, $4, $5,
                   '{"method":"recovery_code"}'::jsonb)`,
          [
            input.userId,
            input.sessionId,
            input.requestId,
            input.ipHash,
            input.userAgentHash,
          ],
        );
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async revokeAdminElevation({ userId, sessionId, elevationTokenHash }) {
      const result = await pool.query(
        `UPDATE admin_elevated_sessions
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = $1
           AND base_session_id = $2
           AND token_hash = $3
           AND revoked_at IS NULL
         RETURNING id`,
        [userId, sessionId, elevationTokenHash],
      );
      return result.rowCount > 0;
    },

    async getAdminOverview() {
      const result = await pool.query(
        `SELECT
           count(*)::integer AS total_users,
           count(*) FILTER (WHERE status = 'active')::integer AS active_users,
           count(*) FILTER (WHERE status = 'disabled')::integer AS disabled_users,
           count(*) FILTER (WHERE role = 'admin')::integer AS administrators,
           count(*) FILTER (WHERE email_verified_at IS NOT NULL)::integer
             AS verified_emails
         FROM app_users
         WHERE status <> 'deleted'`,
      );
      const row = result.rows[0];
      return {
        totalUsers: row.total_users,
        activeUsers: row.active_users,
        disabledUsers: row.disabled_users,
        administrators: row.administrators,
        verifiedEmails: row.verified_emails,
      };
    },

    async listAdminUsers({ query, limit }) {
      const normalizedQuery = query.toLocaleLowerCase("en-US");
      const result = await pool.query(
        `SELECT
           id,
           username,
           display_name,
           email,
           email_verified_at,
           school_account_verified_at,
           status,
           role,
           created_at,
           last_login_at
         FROM app_users
         WHERE status <> 'deleted'
           AND (
             $1 = ''
             OR normalized_username LIKE '%' || $1 || '%'
             OR normalized_email LIKE '%' || $1 || '%'
           )
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [normalizedQuery, limit],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        username: row.username,
        displayName: row.display_name,
        email: row.email,
        emailVerified: Boolean(row.email_verified_at),
        schoolAccountVerified: Boolean(row.school_account_verified_at),
        status: row.status,
        role: row.role,
        createdAt: new Date(row.created_at).toISOString(),
        lastLoginAt: row.last_login_at
          ? new Date(row.last_login_at).toISOString()
          : null,
      }));
    },

    async listAdminAudit({ limit }) {
      const result = await pool.query(
        `SELECT
           id,
           actor_user_id,
           actor_role,
           action,
           target_type,
           target_id,
           request_id,
           metadata,
           created_at
         FROM admin_audit_events
         ORDER BY created_at DESC, id DESC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
        actorRole: row.actor_role,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        requestId: row.request_id ? String(row.request_id) : null,
        metadata: row.metadata,
        createdAt: new Date(row.created_at).toISOString(),
      }));
    },

    async updateAdminUserStatus(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const actor = await client.query(
          `SELECT users.role, users.status
           FROM app_users AS users
           INNER JOIN user_sessions AS sessions
             ON sessions.id = $2
            AND sessions.user_id = users.id
            AND sessions.revoked_at IS NULL
            AND sessions.expires_at > now()
           INNER JOIN admin_elevated_sessions AS elevation
             ON elevation.base_session_id = sessions.id
            AND elevation.user_id = users.id
            AND elevation.token_hash = $3
            AND elevation.revoked_at IS NULL
            AND elevation.expires_at > now()
           WHERE users.id = $1
           FOR UPDATE OF users, sessions, elevation`,
          [
            input.actorUserId,
            input.actorSessionId,
            input.actorElevationTokenHash,
          ],
        );
        if (
          actor.rowCount === 0 ||
          actor.rows[0].role !== "admin" ||
          actor.rows[0].status !== "active"
        ) {
          const error = new Error("administrator permission was revoked");
          error.code = "AUTH_ADMIN_FORBIDDEN";
          throw error;
        }
        if (
          String(input.actorUserId) === String(input.targetUserId) &&
          input.status === "disabled"
        ) {
          const error = new Error("administrator cannot disable itself");
          error.code = "AUTH_ADMIN_SELF_DISABLE";
          throw error;
        }
        const target = await client.query(
          `SELECT id, username, status, role
           FROM app_users
           WHERE id = $1
             AND status <> 'deleted'
           FOR UPDATE`,
          [input.targetUserId],
        );
        if (target.rowCount === 0) {
          await client.query("ROLLBACK");
          return null;
        }
        if (
          input.expectedStatus &&
          target.rows[0].status !== input.expectedStatus
        ) {
          await client.query("ROLLBACK");
          return { conflict: true, currentStatus: target.rows[0].status };
        }
        await client.query(
          `UPDATE app_users
           SET status = $2, updated_at = now()
           WHERE id = $1`,
          [input.targetUserId, input.status],
        );
        if (input.status === "disabled") {
          await client.query(
            `UPDATE user_sessions
             SET revoked_at = COALESCE(revoked_at, now())
             WHERE user_id = $1`,
            [input.targetUserId],
          );
          await client.query(
            `UPDATE admin_elevated_sessions
             SET revoked_at = COALESCE(revoked_at, now())
             WHERE user_id = $1`,
            [input.targetUserId],
          );
        }
        await client.query(
          `INSERT INTO admin_audit_events (
             actor_user_id,
             actor_role,
             session_id,
             action,
             target_type,
             target_id,
             request_id,
             ip_hash,
             user_agent_hash,
             metadata
           )
           VALUES ($1, 'admin', $2, 'admin.user.status_changed', 'user', $3,
                   $4, $5, $6, $7::jsonb)`,
          [
            input.actorUserId,
            input.actorSessionId,
            input.targetUserId,
            input.requestId,
            input.ipHash,
            input.userAgentHash,
            JSON.stringify({
              before: { status: target.rows[0].status },
              after: { status: input.status },
              reason: input.reason,
            }),
          ],
        );
        await client.query("COMMIT");
        return {
          conflict: false,
          user: {
            id: String(target.rows[0].id),
            username: target.rows[0].username,
            status: input.status,
            role: target.rows[0].role,
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async registerCredentialUser({
      username,
      normalizedUsername,
      email,
      normalizedEmail,
      schoolAccount,
      passwordHash,
      anonymousDeviceId,
      sessionTokenHash,
      sessionExpiresAt,
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const user = await client.query(
          `INSERT INTO app_users (
             username,
             normalized_username,
             email,
             normalized_email,
             school_account,
             display_name,
             registered_via,
             last_login_at
           )
           VALUES ($1, $2, $3, $4, $5, $1, 'password', now())
           RETURNING id, username, display_name, email, school_account,
                     created_at, last_login_at, status`,
          [
            username,
            normalizedUsername,
            email,
            normalizedEmail,
            schoolAccount,
          ],
        );
        const userId = user.rows[0].id;
        await client.query(
          `INSERT INTO password_credentials (user_id, password_hash)
           VALUES ($1, $2)`,
          [userId, passwordHash],
        );
        const deviceId = await claimAnonymousDevice(
          client,
          anonymousDeviceId,
          userId,
        );
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
          user: {
            id: String(userId),
            username: user.rows[0].username,
            displayName: user.rows[0].display_name,
            email: user.rows[0].email,
            schoolAccount: user.rows[0].school_account,
            status: user.rows[0].status,
            createdAt: new Date(user.rows[0].created_at).toISOString(),
            lastLoginAt: new Date(user.rows[0].last_login_at).toISOString(),
          },
          sessionId: String(session.rows[0].id),
          expiresAt: new Date(session.rows[0].expires_at).toISOString(),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        if (
          error?.code === "23505" &&
          error?.constraint === "app_users_normalized_username_uidx"
        ) {
          error.code = "AUTH_USERNAME_TAKEN";
        } else if (
          error?.code === "23505" &&
          error?.constraint === "app_users_normalized_email_uidx"
        ) {
          error.code = "AUTH_EMAIL_TAKEN";
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async getCredentialPrincipal(identifier) {
      const result = await pool.query(
        `SELECT
           users.id,
           users.username,
           users.display_name,
           users.email,
           users.school_account,
           users.status,
           credentials.password_hash,
           credentials.failed_attempts,
           credentials.locked_until
         FROM app_users AS users
         INNER JOIN password_credentials AS credentials
           ON credentials.user_id = users.id
         WHERE users.normalized_username = $1
            OR users.normalized_email = $1
         LIMIT 1`,
        [identifier],
      );
      if (result.rowCount === 0) return null;
      const row = result.rows[0];
      return {
        id: String(row.id),
        username: row.username,
        displayName: row.display_name,
        email: row.email,
        schoolAccount: row.school_account,
        status: row.status,
        passwordHash: row.password_hash,
        failedAttempts: row.failed_attempts,
        lockedUntil: row.locked_until
          ? new Date(row.locked_until).toISOString()
          : null,
      };
    },

    async recordCredentialFailure(userId) {
      await pool.query(
        `UPDATE password_credentials
         SET
           failed_attempts = failed_attempts + 1,
           locked_until = CASE
             WHEN failed_attempts + 1 >= 7 THEN now() + interval '15 minutes'
             WHEN failed_attempts + 1 = 6 THEN now() + interval '2 minutes'
             WHEN failed_attempts + 1 = 5 THEN now() + interval '30 seconds'
             ELSE locked_until
           END,
           updated_at = now()
         WHERE user_id = $1`,
        [userId],
      );
    },

    async createCredentialSession({
      userId,
      anonymousDeviceId,
      sessionTokenHash,
      sessionExpiresAt,
    }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const principal = await client.query(
          `SELECT users.status, credentials.locked_until
           FROM app_users AS users
           INNER JOIN password_credentials AS credentials
             ON credentials.user_id = users.id
           WHERE users.id = $1
           FOR UPDATE OF users, credentials`,
          [userId],
        );
        if (
          principal.rowCount === 0 ||
          principal.rows[0].status !== "active" ||
          (principal.rows[0].locked_until &&
            new Date(principal.rows[0].locked_until).getTime() > Date.now())
        ) {
          const error = new Error("Credential login is unavailable");
          error.code = "AUTH_CREDENTIAL_LOGIN_REJECTED";
          throw error;
        }

        const deviceId = await claimAnonymousDevice(
          client,
          anonymousDeviceId,
          userId,
        );
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
        await client.query(
          `UPDATE password_credentials
           SET failed_attempts = 0, locked_until = NULL, updated_at = now()
           WHERE user_id = $1`,
          [userId],
        );
        await client.query(
          `UPDATE app_users
           SET last_login_at = now(), updated_at = now()
           WHERE id = $1`,
          [userId],
        );
        await client.query("COMMIT");
        return {
          sessionId: String(session.rows[0].id),
          expiresAt: new Date(session.rows[0].expires_at).toISOString(),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async createPasswordReset({ userId, tokenHash, expiresAt }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE password_reset_tokens
           SET consumed_at = COALESCE(consumed_at, now())
           WHERE user_id = $1
             AND consumed_at IS NULL`,
          [userId],
        );
        await client.query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [userId, tokenHash, expiresAt],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async createEmailVerification({ userId, tokenHash, expiresAt }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE email_verification_tokens
           SET consumed_at = COALESCE(consumed_at, now())
           WHERE user_id = $1
             AND consumed_at IS NULL`,
          [userId],
        );
        const inserted = await client.query(
          `INSERT INTO email_verification_tokens (
             user_id,
             normalized_email,
             token_hash,
             expires_at
           )
           SELECT id, normalized_email, $2, $3
           FROM app_users
           WHERE id = $1
             AND status = 'active'
             AND normalized_email IS NOT NULL
             AND email_verified_at IS NULL
           RETURNING id`,
          [userId, tokenHash, expiresAt],
        );
        await client.query("COMMIT");
        return inserted.rowCount > 0;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async consumeEmailVerification({ userId, tokenHash }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const token = await client.query(
          `UPDATE email_verification_tokens AS tokens
           SET consumed_at = now()
           WHERE tokens.user_id = $1
             AND tokens.token_hash = $2
             AND tokens.consumed_at IS NULL
             AND tokens.expires_at > now()
             AND EXISTS (
               SELECT 1
               FROM app_users AS users
               WHERE users.id = tokens.user_id
                 AND users.status = 'active'
                 AND users.email_verified_at IS NULL
                 AND users.normalized_email = tokens.normalized_email
             )
           RETURNING tokens.user_id`,
          [userId, tokenHash],
        );
        if (token.rowCount === 0) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          `UPDATE app_users
           SET email_verified_at = now(), updated_at = now()
           WHERE id = $1
             AND email_verified_at IS NULL`,
          [userId],
        );
        await client.query(
          `UPDATE email_verification_tokens
           SET consumed_at = COALESCE(consumed_at, now())
           WHERE user_id = $1
             AND consumed_at IS NULL`,
          [userId],
        );
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async getPasswordResetPrincipal(tokenHash) {
      const result = await pool.query(
        `SELECT users.username, users.email
         FROM password_reset_tokens AS tokens
         INNER JOIN app_users AS users ON users.id = tokens.user_id
         WHERE tokens.token_hash = $1
           AND tokens.consumed_at IS NULL
           AND tokens.expires_at > now()
           AND users.status = 'active'
         LIMIT 1`,
        [tokenHash],
      );
      return result.rowCount > 0
        ? {
            username: result.rows[0].username,
            email: result.rows[0].email,
          }
        : null;
    },

    async consumePasswordReset({ tokenHash, passwordHash }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const token = await client.query(
          `UPDATE password_reset_tokens
           SET consumed_at = now()
           WHERE token_hash = $1
             AND consumed_at IS NULL
             AND expires_at > now()
             AND EXISTS (
               SELECT 1
               FROM app_users AS users
               WHERE users.id = password_reset_tokens.user_id
                 AND users.status = 'active'
             )
           RETURNING user_id`,
          [tokenHash],
        );
        if (token.rowCount === 0) {
          await client.query("ROLLBACK");
          return false;
        }
        const userId = token.rows[0].user_id;
        await client.query(
          `UPDATE password_credentials
           SET
             password_hash = $2,
             failed_attempts = 0,
             locked_until = NULL,
             password_changed_at = now(),
             updated_at = now()
           WHERE user_id = $1`,
          [userId, passwordHash],
        );
        await client.query(
          `UPDATE user_sessions
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1`,
          [userId],
        );
        await client.query(
          `UPDATE admin_elevated_sessions
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1`,
          [userId],
        );
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listUserDevices(userId, currentSessionId) {
      const result = await pool.query(
        `SELECT
           devices.public_id,
           devices.label,
           devices.platform,
           devices.first_seen_at,
           devices.last_seen_at,
           EXISTS (
             SELECT 1
             FROM user_sessions AS active_sessions
             WHERE active_sessions.device_id = devices.id
               AND active_sessions.revoked_at IS NULL
               AND active_sessions.expires_at > now()
           ) AS active,
           EXISTS (
             SELECT 1
             FROM user_sessions AS current_session
             WHERE current_session.id = $2
               AND current_session.device_id = devices.id
           ) AS current
         FROM user_devices AS devices
         WHERE devices.user_id = $1
           AND devices.revoked_at IS NULL
         ORDER BY current DESC, devices.last_seen_at DESC`,
        [userId, currentSessionId],
      );

      return result.rows.map((row) => ({
        id: String(row.public_id),
        label: row.label || "网页设备",
        platform: row.platform || "web",
        firstSeenAt: new Date(row.first_seen_at).toISOString(),
        lastSeenAt: new Date(row.last_seen_at).toISOString(),
        active: row.active,
        current: row.current,
      }));
    },

    async revokeUserDevice(userId, currentSessionId, publicDeviceId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const target = await client.query(
          `SELECT
             devices.id,
             EXISTS (
               SELECT 1
               FROM user_sessions AS current_session
               WHERE current_session.id = $2
                 AND current_session.device_id = devices.id
             ) AS current
           FROM user_devices AS devices
           WHERE devices.user_id = $1
             AND devices.public_id = $3
             AND devices.revoked_at IS NULL
           FOR UPDATE`,
          [userId, currentSessionId, publicDeviceId],
        );
        if (target.rowCount === 0) {
          await client.query("ROLLBACK");
          return null;
        }

        const deviceId = target.rows[0].id;
        await client.query(
          `UPDATE user_sessions
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1
             AND device_id = $2`,
          [userId, deviceId],
        );
        await client.query(
          `UPDATE admin_elevated_sessions
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1
             AND base_session_id IN (
               SELECT id
               FROM user_sessions
               WHERE user_id = $1
                 AND device_id = $2
             )`,
          [userId, deviceId],
        );
        await client.query(
          `UPDATE user_devices
           SET revoked_at = now()
           WHERE user_id = $1
             AND id = $2`,
          [userId, deviceId],
        );
        await client.query("COMMIT");
        return { current: target.rows[0].current };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteAccount(userId) {
      const result = await pool.query(
        `DELETE FROM app_users
         WHERE id = $1
           AND status = 'active'
         RETURNING id`,
        [userId],
      );
      return result.rowCount > 0;
    },

    async revokeSession(tokenHash) {
      await pool.query(
        `WITH revoked_sessions AS (
           UPDATE user_sessions
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE token_hash = $1
           RETURNING id
         )
         UPDATE admin_elevated_sessions
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE base_session_id IN (SELECT id FROM revoked_sessions)`,
        [tokenHash],
      );
    },

    async close() {
      await pool.end();
    },
  };
}
