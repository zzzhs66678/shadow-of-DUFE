import { validateProfileUpdate } from "./credentials.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function fail(code) { throw Object.assign(new Error(code), { code }); }
const date = value => value ? new Date(value).toISOString() : null;
export const NAME_MODE_COOLDOWN_DAYS = 7;
export function publicAccountNameSql(alias) {
  if (!/^[a-z_][a-z_0-9]*$/iu.test(alias)) throw new TypeError("Invalid account SQL alias");
  return `CASE WHEN ${alias}.name_mode = 'momo' THEN 'momo' ELSE COALESCE(${alias}.display_name, ${alias}.username) END`;
}
export function accountNameFields(row) {
  const mode = row.name_mode === "momo" ? "momo" : "name";
  const changedAt = date(row.name_mode_changed_at);
  return { accountName: row.display_name ?? row.username ?? null,
    displayName: mode === "momo" ? "momo" : row.display_name ?? row.username ?? null,
    nameMode: mode, nameModeChangedAt: changedAt,
    nameModeAvailableAt: row.name_mode_available_at ? date(row.name_mode_available_at)
      : changedAt ? new Date(new Date(changedAt).getTime() + NAME_MODE_COOLDOWN_DAYS * 86_400_000).toISOString() : null };
}
function receipt(row) {
  return { id: String(row.id), userId: String(row.user_id), username: row.original_username,
    displayName: row.original_display_name, requestedUsername: row.requested_username,
    requestedDisplayName: row.requested_display_name, status: row.status, reason: row.reason ?? null,
    createdAt: date(row.created_at), reviewedAt: date(row.reviewed_at) };
}
function nameChange(input) {
  const names = {};
  if (Object.hasOwn(input, "username")) names.username = input.username;
  if (Object.hasOwn(input, "displayName")) names.displayName = input.displayName;
  const result = validateProfileUpdate(names);
  if (!result.ok) fail("AUTH_NAME_CHANGE_INVALID");
  if (result.value.displayName?.toLocaleLowerCase("en-US") === "momo") fail("AUTH_NAME_CHANGE_INVALID");
  return result.value;
}
function cursorValue(value) {
  if (!value) return null;
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) fail("AUTH_NAME_CHANGE_INVALID");
  let decoded;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { fail("AUTH_NAME_CHANGE_INVALID"); }
  if (!decoded || Object.keys(decoded).length !== 2 || !uuid.test(decoded.id ?? "") ||
      typeof decoded.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/u.test(decoded.createdAt) ||
      !Number.isFinite(Date.parse(decoded.createdAt))) fail("AUTH_NAME_CHANGE_INVALID");
  return decoded;
}
function mapConflict(error) {
  if (error?.code === "23505" && ["app_users_normalized_username_uidx", "app_users_public_display_name_uidx"].includes(error.constraint)) {
    error.code = "AUTH_NAME_TAKEN";
  }
  return error;
}

export function createAccountNameStore({ pool }) {
  async function transaction(work) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw mapConflict(error); }
    finally { client.release(); }
  }
  async function available(client, userId, update) {
    const result = await client.query(`SELECT id FROM app_users WHERE id <> $1 AND (
        ($2::text IS NOT NULL AND normalized_username = $2) OR
        ($3::text IS NOT NULL AND public_account_name_key($3) <> 'momo'
          AND public_account_name_key(COALESCE(display_name, username)) = public_account_name_key($3))
      ) LIMIT 1`, [userId, update.normalizedUsername ?? null, update.displayName ?? null]);
    if (result.rowCount) fail("AUTH_NAME_TAKEN");
  }
  async function latest(userId) {
    const result = await pool.query(`SELECT * FROM account_name_change_requests WHERE user_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1`, [userId]);
    return result.rowCount ? receipt(result.rows[0]) : null;
  }
  return {
    async setAccountNameMode({ userId, sessionId, mode }) {
      if (!["name", "momo"].includes(mode)) fail("AUTH_NAME_MODE_INVALID");
      return transaction(async client => {
        const users = await client.query(`SELECT username,display_name,name_mode,name_mode_changed_at,
          name_mode_changed_at + interval '7 days' AS name_mode_available_at,
          (name_mode_changed_at IS NULL OR name_mode_changed_at + interval '7 days' <= clock_timestamp()) AS may_change
          FROM app_users WHERE id=$1 AND status='active' FOR UPDATE`, [userId]);
        const session = await client.query(`SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2
          AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`, [sessionId, userId]);
        if (!users.rowCount || !session.rowCount) fail("AUTH_SESSION_REQUIRED");
        const row = users.rows[0];
        if (row.name_mode === mode) return accountNameFields(row);
        if (mode === "name" && !(row.display_name || row.username)) fail("AUTH_NAME_MODE_NAME_REQUIRED");
        if (!row.may_change) {
          const error = Object.assign(new Error("AUTH_NAME_MODE_COOLDOWN"), { code: "AUTH_NAME_MODE_COOLDOWN", availableAt: date(row.name_mode_available_at) });
          throw error;
        }
        await client.query("SELECT set_config('dufesh.account_name_mode_session_id',$1,true)", [sessionId]);
        const changed = await client.query(`UPDATE app_users SET name_mode=$2,updated_at=clock_timestamp() WHERE id=$1
          RETURNING username,display_name,name_mode,name_mode_changed_at,
            name_mode_changed_at + interval '7 days' AS name_mode_available_at`, [userId, mode]);
        return accountNameFields(changed.rows[0]);
      });
    },
    async requestAccountNameChange(input) {
      const update = nameChange(input);
      return transaction(async client => {
        const user = await client.query(`SELECT id, username, normalized_username, display_name FROM app_users
          WHERE id = $1 AND status = 'active' FOR UPDATE`, [input.userId]);
        const session = await client.query(`SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2
          AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`, [input.sessionId, input.userId]);
        if (!user.rowCount || !session.rowCount) fail("AUTH_SESSION_REQUIRED");
        const previous = await client.query(`SELECT * FROM account_name_change_requests
          WHERE user_id = $1 AND status = 'pending' FOR UPDATE`, [input.userId]);
        if (previous.rowCount) {
          const row = previous.rows[0];
          if (row.requested_username !== (update.username ?? null) || row.requested_display_name !== (update.displayName ?? null)) {
            fail("AUTH_NAME_CHANGE_CONFLICT");
          }
          return receipt(row);
        }
        const row = user.rows[0];
        if ((!Object.hasOwn(update, "username") || update.username === row.username) &&
            (!Object.hasOwn(update, "displayName") || update.displayName === row.display_name)) fail("AUTH_NAME_CHANGE_CONFLICT");
        await available(client, input.userId, { ...update,
          displayName: update.displayName ?? row.display_name ?? update.username ?? row.username });
        const inserted = await client.query(`INSERT INTO account_name_change_requests
          (user_id,original_username,original_normalized_username,original_display_name,
           requested_username,requested_normalized_username,requested_display_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [input.userId, row.username, row.normalized_username, row.display_name,
          update.username ?? null, update.normalizedUsername ?? null, update.displayName ?? null]);
        return receipt(inserted.rows[0]);
      });
    },
    getAccountNameChange: latest,
    async listAccountNameChanges({ limit = 20, cursor } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail("AUTH_NAME_CHANGE_INVALID");
      const after = cursorValue(cursor);
      const result = await pool.query(`SELECT *, created_at::text AS cursor_created_at
        FROM account_name_change_requests WHERE status = 'pending'
          AND ($1::timestamptz IS NULL OR (created_at,id) > ($1::timestamptz,$2::uuid))
        ORDER BY created_at, id LIMIT $3`, [after?.createdAt ?? null, after?.id ?? null, limit + 1]);
      const rows = result.rows.slice(0, limit); const last = rows.at(-1);
      return { requests: rows.map(receipt), nextCursor: result.rows.length > limit
        ? Buffer.from(JSON.stringify({ createdAt: last.cursor_created_at, id: String(last.id) })).toString("base64url") : null };
    },
    async reviewAccountNameChange(input) {
      if (!uuid.test(input.nameChangeId ?? "") || !["approve", "reject"].includes(input.decision)) fail("AUTH_NAME_CHANGE_INVALID");
      const reason = typeof input.reason === "string" ? input.reason.normalize("NFKC").trim() : "";
      if (Array.from(reason).length > 500 || /[\p{Cc}\p{Cf}]/u.test(reason) || (input.decision === "reject" && !reason)) fail("AUTH_NAME_CHANGE_INVALID");
      return transaction(async client => {
        const found = await client.query(`SELECT user_id FROM account_name_change_requests WHERE id=$1`, [input.nameChangeId]);
        // Lock account rows in a deterministic order before sessions or requests.
        // This also serializes ordinary profile writes and account disablement.
        const users = await client.query(`SELECT id,username,normalized_username,display_name,status,role FROM app_users
          WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[input.actorUserId, found.rows[0]?.user_id ?? input.actorUserId]]);
        const actor = users.rows.find(row => String(row.id) === String(input.actorUserId));
        const actorSession = await client.query(`SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2
          AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`, [input.actorSessionId, input.actorUserId]);
        const elevation = await client.query(`SELECT id FROM admin_elevated_sessions WHERE user_id=$1 AND base_session_id=$2
          AND token_hash=$3 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
        [input.actorUserId, input.actorSessionId, input.actorElevationTokenHash]);
        if (!actor || actor.role !== "admin" || actor.status !== "active" || !actorSession.rowCount || !elevation.rowCount) fail("AUTH_ADMIN_FORBIDDEN");
        if (!found.rowCount) return null;
        const request = await client.query(`SELECT * FROM account_name_change_requests WHERE id=$1 FOR UPDATE`, [input.nameChangeId]);
        const row = request.rows[0]; const target = users.rows.find(user => String(user.id) === String(row?.user_id));
        if (!row || row.status !== "pending" || !target || target.status !== "active" ||
            row.original_username !== target.username || row.original_normalized_username !== target.normalized_username ||
            row.original_display_name !== target.display_name) fail("AUTH_NAME_CHANGE_CONFLICT");
        const status = input.decision === "approve" ? "approved" : "rejected";
        const reviewed = await client.query(`UPDATE account_name_change_requests SET status=$2,reason=$3,
          reviewed_at=clock_timestamp(),reviewed_by=$4,reviewer_session_id=$5,reviewer_elevation_id=$6,review_transaction_id=txid_current()
          WHERE id=$1 AND EXISTS (SELECT 1 FROM user_sessions WHERE id=$5 AND revoked_at IS NULL AND expires_at > clock_timestamp())
            AND EXISTS (SELECT 1 FROM admin_elevated_sessions WHERE id=$6 AND revoked_at IS NULL AND expires_at > clock_timestamp())
          RETURNING *`, [input.nameChangeId, status, reason || null, input.actorUserId, input.actorSessionId, elevation.rows[0].id]);
        if (!reviewed.rowCount) fail("AUTH_ADMIN_FORBIDDEN");
        if (status === "approved") {
          await client.query("SELECT set_config('dufesh.account_name_review_id',$1,true)", [input.nameChangeId]);
          await client.query(`UPDATE app_users SET username=COALESCE($2,username),normalized_username=COALESCE($3,normalized_username),
            display_name=COALESCE($4,display_name),updated_at=clock_timestamp() WHERE id=$1`,
          [row.user_id, row.requested_username, row.requested_normalized_username, row.requested_display_name]);
        }
        await client.query(`INSERT INTO admin_audit_events
          (actor_user_id,actor_role,session_id,action,target_type,target_id,request_id,ip_hash,user_agent_hash,metadata)
          VALUES ($1,'admin',$2,$3,'account_name_change',$4,$5,$6,$7,$8::jsonb)`,
        [input.actorUserId, input.actorSessionId, `admin.account_name.${status}`, input.nameChangeId,
          input.requestId, input.ipHash ?? null, input.userAgentHash ?? null,
          JSON.stringify({ userId: String(row.user_id), reason: reason || null,
            before: { username: row.original_username, displayName: row.original_display_name },
            requested: { username: row.requested_username, displayName: row.requested_display_name } })]);
        return receipt(reviewed.rows[0]);
      });
    },
  };
}
