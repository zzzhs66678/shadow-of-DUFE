import { createHash } from "node:crypto";
import { encodeWhiteboardCursor, isWhiteboardUuid, validateWhiteboardContent, validateWhiteboardMutation, validWhiteboardPage } from "./whiteboard-contract.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const iso = value => value === null ? null : new Date(value).toISOString();
// Explicit public whitelist: never return a raw row or join admin/user profiles.
function entry(row) {
  return { id: String(row.id), kind: row.kind, title: row.title, body: row.body,
    guest: row.guest, guestBio: row.guest_bio, location: row.location,
    startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), expiresAt: iso(row.expires_at),
    status: row.status, version: Number(row.version), publishedAt: iso(row.published_at), updatedAt: iso(row.updated_at) };
}
const publicColumns = "id,kind,title,body,guest,guest_bio,location,starts_at,ends_at,expires_at,status,version,published_at,updated_at";
const cursorTime = column => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function createWhiteboardStore(pool) {
  async function guard(client, input, write) {
    // Serializing each administrator's writes also serializes mutationId claims.
    // A different administrator still gets row-level optimistic conflict checks.
    const result = await client.query(`SELECT users.id FROM app_users AS users
      JOIN user_sessions AS sessions ON sessions.user_id=users.id AND sessions.id=$2
        AND sessions.revoked_at IS NULL AND sessions.expires_at>clock_timestamp()
      JOIN admin_elevated_sessions AS elevation ON elevation.user_id=users.id AND elevation.base_session_id=sessions.id
        AND elevation.token_hash=$3 AND elevation.revoked_at IS NULL AND elevation.expires_at>clock_timestamp()
      WHERE users.id=$1 AND users.role='admin' AND users.status='active'
      FOR ${write ? "UPDATE" : "SHARE"} OF users FOR SHARE OF sessions,elevation`,
    [input.userId, input.sessionId, input.elevationTokenHash]);
    if (!result.rowCount) fail("AUTH_ADMIN_FORBIDDEN");
  }
  async function transaction(input, write, work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await guard(client, input, write);
      const result = await work(client);
      // Natural expiry can happen while waiting on another writer's entry lock.
      await guard(client, input, write);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async function audit(client, input, action, targetId, metadata) {
    await client.query(`INSERT INTO admin_audit_events
      (actor_user_id,actor_role,session_id,action,target_type,target_id,request_id,ip_hash,user_agent_hash,metadata)
      VALUES ($1,'admin',$2,$3,'whiteboard',$4,$5,$6,$7,$8::jsonb)`,
    [input.userId, input.sessionId, action, targetId, input.requestId, input.ipHash, input.userAgentHash, JSON.stringify(metadata)]);
  }
  async function list(client, page, admin) {
    if (!validWhiteboardPage(page, admin)) fail("WHITEBOARD_INVALID");
    const order = admin ? "updated_at" : "published_at";
    const scope = admin ? page.status : page.scope;
    const expiry = "CASE WHEN kind='event' THEN ends_at ELSE expires_at END";
    const predicate = admin ? "($1='all' OR status=$1)" : `status='published' AND
      (($1='active' AND (${expiry} IS NULL OR ${expiry}>statement_timestamp())) OR
       ($1='archive' AND ${expiry}<=statement_timestamp()))`;
    const result = await client.query(`SELECT ${publicColumns},${cursorTime(order)} AS cursor_at FROM whiteboard_entries
      WHERE ${predicate} AND ($2::timestamptz IS NULL OR (${order},id)<($2::timestamptz,$3::uuid))
      ORDER BY ${order} DESC,id DESC LIMIT $4`, [scope, page.cursor?.at ?? null, page.cursor?.id ?? null, page.limit + 1]);
    const rows = result.rows.slice(0, page.limit);
    const last = rows.at(-1);
    return { items: rows.map(entry), nextCursor: result.rows.length > page.limit && last
      ? encodeWhiteboardCursor({ v: 1, scope: `${admin ? "admin" : "public"}:${scope}`, at: last.cursor_at, id: String(last.id) }) : null };
  }

  return {
    async getWhiteboardSession(tokenHash) {
      const result = await pool.query(`SELECT sessions.id,users.id AS user_id,users.role FROM user_sessions AS sessions
        JOIN app_users AS users ON users.id=sessions.user_id WHERE sessions.token_hash=$1
        AND sessions.revoked_at IS NULL AND sessions.expires_at>clock_timestamp() AND users.status='active' LIMIT 1`, [tokenHash]);
      return result.rowCount ? { id: String(result.rows[0].id), userId: String(result.rows[0].user_id), role: result.rows[0].role } : null;
    },
    listPublicWhiteboard: page => list(pool, page, false),
    listAdminWhiteboard: input => transaction(input, false, async client => {
      const result = await list(client, input.page, true);
      await audit(client, input, "admin.whiteboard.list_viewed", null, { status: input.page.status });
      return result;
    }),
    async mutateWhiteboard(input) {
      const patch = input.entryId !== null;
      if (patch && !isWhiteboardUuid(input.entryId)) fail("WHITEBOARD_INVALID");
      const change = validateWhiteboardMutation(input.data, patch);
      if (!change) fail("WHITEBOARD_INVALID");
      const requestHash = createHash("sha256").update(JSON.stringify({ entryId: patch ? input.entryId.toLowerCase() : null, ...change })).digest("hex");
      return transaction(input, true, async client => {
        const previous = await client.query("SELECT request_hash,receipt FROM whiteboard_actions WHERE actor_user_id=$1 AND mutation_id=$2", [input.userId, change.mutationId]);
        if (previous.rowCount) {
          if (previous.rows[0].request_hash !== requestHash) fail("WHITEBOARD_MUTATION_CONFLICT");
          return { entry: previous.rows[0].receipt, replayed: true };
        }
        let row;
        if (patch) {
          const locked = await client.query("SELECT * FROM whiteboard_entries WHERE id=$1 FOR UPDATE", [input.entryId]);
          row = locked.rows[0];
          if (!row) fail("WHITEBOARD_NOT_FOUND");
          if (Number(row.version) !== change.version) fail("WHITEBOARD_CONFLICT");
        }
        const oldContent = row ? entry(row) : {};
        for (const field of ["id", "version", "publishedAt", "updatedAt"]) delete oldContent[field];
        // Event -> note patches must explicitly clear old event fields. Merging
        // before validation prevents stale invisible data from surviving a switch.
        const content = validateWhiteboardContent({ ...oldContent, ...change.fields });
        if (!content) fail("WHITEBOARD_INVALID");
        const values = [content.kind, content.title, content.body, content.guest, content.guestBio, content.location,
          content.startsAt, content.endsAt, content.expiresAt, content.status];
        const written = patch ? await client.query(`UPDATE whiteboard_entries SET kind=$1,title=$2,body=$3,guest=$4,guest_bio=$5,
          location=$6,starts_at=$7,ends_at=$8,expires_at=$9,status=$10,version=version+1,updated_at=clock_timestamp(),
          published_at=CASE WHEN $10='published' AND status<>'published' THEN clock_timestamp() ELSE published_at END
          WHERE id=$11 RETURNING ${publicColumns}`, [...values, input.entryId])
          : await client.query(`INSERT INTO whiteboard_entries(kind,title,body,guest,guest_bio,location,starts_at,ends_at,expires_at,status,published_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10='published' THEN clock_timestamp() END) RETURNING ${publicColumns}`, values);
        const saved = entry(written.rows[0]);
        await client.query(`INSERT INTO whiteboard_actions(entry_id,actor_user_id,mutation_id,request_hash,operation,from_status,to_status,version,receipt)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [saved.id, input.userId, change.mutationId, requestHash, patch ? "update" : "create", row?.status ?? null, saved.status, saved.version, JSON.stringify(saved)]);
        await audit(client, input, patch ? "admin.whiteboard.updated" : "admin.whiteboard.created", saved.id,
          { kind: saved.kind, fromStatus: row?.status ?? null, toStatus: saved.status, version: saved.version });
        return { entry: saved, replayed: false };
      });
    },
  };
}
