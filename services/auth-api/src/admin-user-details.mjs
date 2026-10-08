export function createAdminUserDetailsStore(pool) {
  return {
    async getAdminUserRegistration(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const actor = await client.query(
          `SELECT users.id FROM app_users AS users
           JOIN user_sessions AS sessions ON sessions.user_id = users.id
             AND sessions.id = $2 AND sessions.revoked_at IS NULL AND sessions.expires_at > now()
           JOIN admin_elevated_sessions AS elevation ON elevation.base_session_id = sessions.id
             AND elevation.user_id = users.id AND elevation.token_hash = $3
             AND elevation.revoked_at IS NULL AND elevation.expires_at > now()
           WHERE users.id = $1 AND users.role = 'admin' AND users.status = 'active'
           FOR SHARE OF users, sessions, elevation`,
          [input.actorUserId, input.actorSessionId, input.actorElevationTokenHash],
        );
        if (!actor.rowCount) {
          const error = new Error("administrator permission was revoked");
          error.code = "AUTH_ADMIN_FORBIDDEN";
          throw error;
        }
        const result = await client.query(
          `SELECT users.id, users.username, users.display_name, users.email,
                  users.email_verified_at, users.school_account, users.school_account_verified_at,
                  users.avatar_url, users.registered_via, users.created_at, users.last_login_at,
                  users.role, users.status, profile.entrance_year, profile.college,
                  profile.major_id, profile.class_name, profile.updated_at AS profile_updated_at
           FROM app_users AS users LEFT JOIN user_profiles AS profile ON profile.user_id = users.id
           WHERE users.id = $1 AND users.status <> 'deleted'`,
          [input.targetUserId],
        );
        if (!result.rowCount) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query(
          `INSERT INTO admin_audit_events
             (actor_user_id, actor_role, session_id, action, target_type, target_id,
              request_id, ip_hash, user_agent_hash, metadata)
           VALUES ($1, 'admin', $2, 'admin.user.registration_viewed', 'user', $3, $4, $5, $6, '{}'::jsonb)`,
          [input.actorUserId, input.actorSessionId, input.targetUserId,
            input.requestId, input.ipHash, input.userAgentHash],
        );
        const row = result.rows[0];
        const date = (value) => value ? new Date(value).toISOString() : null;
        const registration = {
          id: String(row.id), username: row.username, displayName: row.display_name,
          email: row.email, emailVerified: Boolean(row.email_verified_at),
          schoolAccount: row.school_account, schoolAccountVerified: Boolean(row.school_account_verified_at),
          avatarUrl: row.avatar_url, registeredVia: row.registered_via,
          createdAt: date(row.created_at), lastLoginAt: date(row.last_login_at),
          role: row.role, status: row.status,
          profile: row.profile_updated_at ? {
            entranceYear: row.entrance_year, college: row.college, majorId: row.major_id,
            className: row.class_name, updatedAt: date(row.profile_updated_at),
          } : null,
        };
        await client.query("COMMIT");
        return registration;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
