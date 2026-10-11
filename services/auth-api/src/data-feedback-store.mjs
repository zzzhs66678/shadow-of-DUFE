import { validateDataFeedback, validateFeedbackResolution } from "./data-feedback-contract.mjs";

function fail(code) { throw Object.assign(new Error(code), { code }); }
const date = (value) => new Date(value).toISOString();
function receipt(row) {
  return { id: String(row.id), type: row.type, courseId: row.course_id, meetingId: row.meeting_id,
    materialId: row.material_id, room: row.room, path: row.path, message: row.message,
    status: row.status, version: row.version, createdAt: date(row.created_at), updatedAt: date(row.updated_at) };
}

export function createDataFeedbackStore(pool) {
  async function transaction(input, admin, work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const actor = admin
        ? await client.query(`SELECT users.id FROM app_users AS users
            JOIN user_sessions AS sessions ON sessions.user_id = users.id AND sessions.id = $2
              AND sessions.revoked_at IS NULL AND sessions.expires_at > now()
            JOIN admin_elevated_sessions AS elevation ON elevation.base_session_id = sessions.id
              AND elevation.user_id = users.id AND elevation.token_hash = $3
              AND elevation.revoked_at IS NULL AND elevation.expires_at > now()
            WHERE users.id = $1 AND users.role = 'admin' AND users.status = 'active'
            FOR SHARE OF users, sessions, elevation`, [input.userId, input.sessionId, input.elevationTokenHash])
        : await client.query(`SELECT users.id FROM app_users AS users
            JOIN user_sessions AS sessions ON sessions.user_id = users.id AND sessions.id = $2
              AND sessions.revoked_at IS NULL AND sessions.expires_at > now()
            WHERE users.id = $1 AND users.status = 'active' FOR SHARE OF users, sessions`, [input.userId, input.sessionId]);
      if (!actor.rowCount) fail(admin ? "AUTH_ADMIN_FORBIDDEN" : "AUTH_SESSION_REQUIRED");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async function audit(client, input, action, targetId = null, metadata = {}) {
    await client.query(`INSERT INTO admin_audit_events
      (actor_user_id, actor_role, session_id, action, target_type, target_id, request_id, ip_hash, user_agent_hash, metadata)
      VALUES ($1, 'admin', $2, $3, 'data_feedback', $4, $5, $6, $7, $8::jsonb)`,
    [input.userId, input.sessionId, action, targetId, input.requestId, input.ipHash, input.userAgentHash, JSON.stringify(metadata)]);
  }

  async function list(input, admin) {
    return transaction(input, admin, async client => {
      // Cursor is resolved within the same owner/status scope; never accept another user's cursor.
      const scope = admin ? "status = $1" : "user_id = $1";
      const value = admin ? input.status : input.userId;
      if (input.cursor) {
        const exists = await client.query(`SELECT id FROM data_feedback WHERE ${scope} AND id = $2`, [value, input.cursor]);
        if (!exists.rowCount) fail("FEEDBACK_INVALID_CURSOR");
      }
      const result = await client.query(`SELECT * FROM data_feedback WHERE ${scope}
        AND ($2::uuid IS NULL OR (created_at, id) <
          (SELECT created_at, id FROM data_feedback WHERE ${scope} AND id = $2))
        ORDER BY created_at DESC, id DESC LIMIT $3`, [value, input.cursor, input.limit + 1]);
      const items = result.rows.slice(0, input.limit).map(receipt);
      if (admin) await audit(client, input, "admin.data_feedback.list_viewed");
      return { items, nextCursor: result.rows.length > input.limit ? items.at(-1).id : null };
    });
  }

  return {
    // The generic auth session reader also selects registration fields. This narrow
    // reader uses the same session table but never reads school accounts or email.
    async getDataFeedbackSession(tokenHash) {
      const result = await pool.query(`SELECT sessions.id, users.id AS user_id, users.role
        FROM user_sessions AS sessions JOIN app_users AS users ON users.id = sessions.user_id
        WHERE sessions.token_hash = $1 AND sessions.revoked_at IS NULL AND sessions.expires_at > now()
          AND users.status = 'active' LIMIT 1`, [tokenHash]);
      return result.rowCount ? { id: String(result.rows[0].id), userId: String(result.rows[0].user_id), role: result.rows[0].role } : null;
    },
    async createDataFeedback(input) {
      const data = validateDataFeedback(input.data);
      if (!data) fail("FEEDBACK_INVALID_BODY");
      return transaction(input, false, async client => {
        const values = [input.userId, data.requestKey, data.type, data.courseId, data.meetingId, data.materialId, data.room, data.path, data.message];
        const inserted = await client.query(`INSERT INTO data_feedback
          (user_id, request_key, type, course_id, meeting_id, material_id, room, path, message)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id, request_key) DO NOTHING RETURNING *`, values);
        if (inserted.rowCount) return { feedback: receipt(inserted.rows[0]), created: true };
        const previous = await client.query(`SELECT * FROM data_feedback WHERE user_id = $1 AND request_key = $2`, values.slice(0, 2));
        const row = previous.rows[0];
        if (!row || [row.type, row.course_id, row.meeting_id, row.material_id, row.room, row.path, row.message].some((value, i) => value !== values[i + 2])) fail("FEEDBACK_REQUEST_CONFLICT");
        return { feedback: receipt(row), created: false };
      });
    },
    listOwnDataFeedback: input => list(input, false),
    listAdminDataFeedback: input => list(input, true),
    async getOwnDataFeedback(input) {
      return transaction(input, false, async client => {
        const result = await client.query(`SELECT * FROM data_feedback WHERE id = $1 AND user_id = $2`, [input.feedbackId, input.userId]);
        return result.rowCount ? receipt(result.rows[0]) : null;
      });
    },
    async getAdminDataFeedback(input) {
      return transaction(input, true, async client => {
        const result = await client.query(`SELECT * FROM data_feedback WHERE id = $1`, [input.feedbackId]);
        if (!result.rowCount) return null;
        const actions = await client.query(`SELECT id, from_status, to_status, version, note, created_at
          FROM data_feedback_actions WHERE feedback_id = $1 ORDER BY version ASC`, [input.feedbackId]);
        await audit(client, input, "admin.data_feedback.detail_viewed", input.feedbackId);
        return { ...receipt(result.rows[0]), actions: actions.rows.map(row => ({ id: String(row.id), fromStatus: row.from_status,
          toStatus: row.to_status, version: row.version, note: row.note, createdAt: date(row.created_at) })) };
      });
    },
    async resolveDataFeedback(input) {
      const change = validateFeedbackResolution(input.change);
      if (!change) fail("FEEDBACK_INVALID_BODY");
      return transaction(input, true, async client => {
        const result = await client.query(`SELECT * FROM data_feedback WHERE id = $1 FOR UPDATE`, [input.feedbackId]);
        if (!result.rowCount) return null;
        const row = result.rows[0];
        if (row.version !== change.version || row.status === change.status) fail("FEEDBACK_VERSION_CONFLICT");
        const updated = await client.query(`UPDATE data_feedback SET status = $2, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING *`, [input.feedbackId, change.status]);
        await client.query(`INSERT INTO data_feedback_actions
          (feedback_id, actor_user_id, from_status, to_status, version, note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.feedbackId, input.userId, row.status, change.status, row.version + 1, change.note]);
        await audit(client, input, "admin.data_feedback.status_changed", input.feedbackId,
          { fromStatus: row.status, toStatus: change.status, version: row.version + 1 });
        return receipt(updated.rows[0]);
      });
    },
  };
}
