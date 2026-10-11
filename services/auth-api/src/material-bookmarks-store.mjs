export const MAX_MATERIAL_BOOKMARKS = 1000;
export const isMaterialBookmarkId = (value) => typeof value === "string" && /^[0-9a-f]{20}$/u.test(value);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

async function transaction(pool, callback) {
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client !== pool) client.release();
  }
}

async function requireSession(client, { userId, sessionId }, write = false) {
  const result = await client.query(
    `SELECT users.id FROM app_users AS users
     JOIN user_sessions AS sessions ON sessions.user_id = users.id
     WHERE users.id = $1::uuid AND users.status = 'active'
       AND sessions.id = $2::uuid AND sessions.revoked_at IS NULL
       AND sessions.expires_at > now()
     FOR ${write ? "UPDATE" : "SHARE"} OF users, sessions`,
    [userId, sessionId],
  );
  if (!result.rows.length) throw failure("MATERIAL_BOOKMARK_SESSION_INVALID");
}

export function createMaterialBookmarkStore(pool) {
  return {
    async listMaterialBookmarks({ userId, sessionId }) {
      return transaction(pool, async (client) => {
        await requireSession(client, { userId, sessionId });
        const result = await client.query(
          `SELECT material_id, created_at FROM material_bookmarks
           WHERE user_id = $1::uuid ORDER BY created_at DESC, material_id
           LIMIT $2`,
          [userId, MAX_MATERIAL_BOOKMARKS],
        );
        return result.rows.map((row) => ({
          materialId: row.material_id,
          bookmarkedAt: new Date(row.created_at).toISOString(),
        }));
      });
    },

    async setMaterialBookmark({ userId, sessionId, materialId, active }) {
      if (!isMaterialBookmarkId(materialId) || typeof active !== "boolean") {
        throw failure("MATERIAL_BOOKMARK_INVALID");
      }
      return transaction(pool, async (client) => {
        // Serialize this user's mutations, including concurrent inserts at the cap.
        // Recheck the session inside the transaction so revoked sessions fail closed.
        await requireSession(client, { userId, sessionId }, true);
        let changed;
        if (active) {
          const existing = await client.query(
            `SELECT material_id FROM material_bookmarks WHERE user_id = $1::uuid AND material_id = $2`,
            [userId, materialId],
          );
          if (existing.rows.length) return { materialId, bookmarked: true };
          const count = await client.query(
            `SELECT count(*)::integer AS total FROM material_bookmarks WHERE user_id = $1::uuid`, [userId],
          );
          if (count.rows[0].total >= MAX_MATERIAL_BOOKMARKS) throw failure("MATERIAL_BOOKMARK_LIMIT");
          changed = await client.query(
            `INSERT INTO material_bookmarks (user_id, material_id) VALUES ($1::uuid, $2)
             ON CONFLICT (user_id, material_id) DO NOTHING RETURNING material_id`, [userId, materialId],
          );
        } else {
          // No catalog/file lookup: missing and withdrawn references remain removable.
          changed = await client.query(
            `DELETE FROM material_bookmarks WHERE user_id = $1::uuid AND material_id = $2 RETURNING material_id`,
            [userId, materialId],
          );
        }
        if (changed.rows.length) {
          await client.query(
            `INSERT INTO material_bookmark_events (actor_user_id, material_id, action) VALUES ($1::uuid, $2, $3)`,
            [userId, materialId, active ? "added" : "removed"],
          );
        }
        return { materialId, bookmarked: active };
      });
    },
  };
}
