function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function publicAuthor(row) {
  if (!row.author_user_id || row.blocked_by_viewer) return null;
  return {
    id: String(row.author_user_id),
    username: row.author_username,
    displayName: row.author_display_name,
    avatarUrl: row.author_avatar_url,
  };
}

function mapTopic(row) {
  return {
    id: String(row.id),
    title: row.title,
    body: row.body,
    status: row.status,
    visibility: row.visibility,
    version: Number(row.version),
    author: publicAuthor(row),
    likeCount: Number(row.like_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    liked: Boolean(row.viewer_liked),
    bookmarked: Boolean(row.viewer_bookmarked),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    editedAt: iso(row.edited_at),
  };
}

function mapComment(row) {
  const unavailable = row.status !== "published" || row.blocked_by_viewer;
  return {
    id: String(row.id),
    topicId: String(row.topic_id),
    parentCommentId: row.parent_comment_id
      ? String(row.parent_comment_id)
      : null,
    rootCommentId: row.root_comment_id
      ? String(row.root_comment_id)
      : null,
    replyToUserId: row.reply_to_user_id
      ? String(row.reply_to_user_id)
      : null,
    body: unavailable ? null : row.body,
    status: row.blocked_by_viewer ? "blocked" : row.status,
    version: Number(row.version),
    author: unavailable ? null : publicAuthor(row),
    likeCount: Number(row.like_count ?? 0),
    liked: Boolean(row.viewer_liked),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    editedAt: iso(row.edited_at),
  };
}

function communityError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertPostingAllowed(client, userId) {
  const result = await client.query(
    `SELECT
       users.status,
       EXISTS (
         SELECT 1
         FROM community_user_sanctions AS sanctions
         WHERE sanctions.user_id = users.id
           AND sanctions.revoked_at IS NULL
           AND sanctions.starts_at <= now()
           AND (sanctions.expires_at IS NULL OR sanctions.expires_at > now())
       ) AS sanctioned
     FROM app_users AS users
     WHERE users.id = $1::uuid
     FOR UPDATE OF users`,
    [userId],
  );
  if (
    result.rowCount !== 1 ||
    result.rows[0].status !== "active" ||
    result.rows[0].sanctioned
  ) {
    throw communityError("COMMUNITY_POSTING_FORBIDDEN");
  }
}

async function assertTopicInteractionAllowed(client, topicId, userId) {
  const result = await client.query(
    `SELECT
       topics.id,
       topics.author_user_id,
       topics.status,
       EXISTS (
         SELECT 1
         FROM community_user_blocks AS blocks
         WHERE (
           blocks.blocker_user_id = $2::uuid AND
           blocks.blocked_user_id = topics.author_user_id
         ) OR (
           blocks.blocker_user_id = topics.author_user_id AND
           blocks.blocked_user_id = $2::uuid
         )
       ) AS blocked
     FROM community_topics AS topics
     WHERE topics.id = $1::uuid
     FOR SHARE OF topics`,
    [topicId, userId],
  );
  if (result.rowCount !== 1 || result.rows[0].status !== "published") {
    throw communityError("COMMUNITY_TOPIC_UNAVAILABLE");
  }
  if (result.rows[0].blocked) {
    throw communityError("COMMUNITY_TOPIC_UNAVAILABLE");
  }
  return result.rows[0];
}

async function lockOwnedTopic(client, topicId, userId) {
  const result = await client.query(
    `SELECT
       topics.*,
       COALESCE(authors.display_name, authors.username) AS actor_label
     FROM community_topics AS topics
     LEFT JOIN app_users AS authors ON authors.id = topics.author_user_id
     WHERE topics.id = $1::uuid
     FOR UPDATE OF topics`,
    [topicId],
  );
  const topic = result.rows[0];
  if (!topic || String(topic.author_user_id) !== String(userId)) {
    throw communityError("COMMUNITY_CONTENT_NOT_FOUND");
  }
  if (topic.status !== "published") {
    throw communityError("COMMUNITY_CONTENT_UNAVAILABLE");
  }
  return topic;
}

async function lockOwnedComment(client, commentId, userId) {
  const result = await client.query(
    `SELECT
       comments.*,
       COALESCE(authors.display_name, authors.username) AS actor_label
     FROM community_comments AS comments
     LEFT JOIN app_users AS authors ON authors.id = comments.author_user_id
     WHERE comments.id = $1::uuid
     FOR UPDATE OF comments`,
    [commentId],
  );
  const comment = result.rows[0];
  if (!comment || String(comment.author_user_id) !== String(userId)) {
    throw communityError("COMMUNITY_CONTENT_NOT_FOUND");
  }
  if (comment.status !== "published") {
    throw communityError("COMMUNITY_CONTENT_UNAVAILABLE");
  }
  return comment;
}

async function recordTopicEdit(client, topic, userId) {
  await client.query(
    `INSERT INTO community_content_edits (
       actor_user_id, actor_label, content_type, content_id,
       previous_version, previous_title, previous_body
     ) VALUES ($1::uuid, $2, 'topic', $3::uuid, $4, $5, $6)`,
    [
      userId,
      topic.actor_label,
      topic.id,
      topic.version,
      topic.title,
      topic.body,
    ],
  );
}

async function recordCommentEdit(client, comment, userId) {
  await client.query(
    `INSERT INTO community_content_edits (
       actor_user_id, actor_label, content_type, content_id,
       previous_version, previous_title, previous_body
     ) VALUES ($1::uuid, $2, 'comment', $3::uuid, $4, NULL, $5)`,
    [userId, comment.actor_label, comment.id, comment.version, comment.body],
  );
}

function mutationTopic(row) {
  return {
    id: String(row.id),
    status: row.status,
    visibility: row.visibility,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mutationComment(row) {
  return {
    id: String(row.id),
    topicId: String(row.topic_id),
    parentCommentId: row.parent_comment_id
      ? String(row.parent_comment_id)
      : null,
    rootCommentId: row.root_comment_id ? String(row.root_comment_id) : null,
    status: row.status,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const topicSelect = `
  SELECT
    topics.id,
    topics.author_user_id,
    topics.title,
    topics.body,
    topics.status,
    topics.visibility,
    topics.version,
    topics.created_at,
    topics.updated_at,
    topics.edited_at,
    authors.username AS author_username,
    authors.display_name AS author_display_name,
    authors.avatar_url AS author_avatar_url,
    EXISTS (
      SELECT 1
      FROM community_user_blocks AS blocks
      WHERE blocks.blocker_user_id = $1::uuid
        AND blocks.blocked_user_id = topics.author_user_id
    ) AS blocked_by_viewer,
    EXISTS (
      SELECT 1
      FROM community_user_blocks AS blocks
      WHERE blocks.blocker_user_id = topics.author_user_id
        AND blocks.blocked_user_id = $1::uuid
    ) AS viewer_blocked_by_author,
    (SELECT count(*) FROM community_topic_likes AS likes WHERE likes.topic_id = topics.id) AS like_count,
    (SELECT count(*) FROM community_comments AS comments WHERE comments.topic_id = topics.id AND comments.status <> 'deleted') AS comment_count,
    EXISTS (
      SELECT 1 FROM community_topic_likes AS viewer_likes
      WHERE viewer_likes.topic_id = topics.id
        AND viewer_likes.user_id = $1::uuid
    ) AS viewer_liked,
    EXISTS (
      SELECT 1 FROM community_topic_bookmarks AS viewer_bookmarks
      WHERE viewer_bookmarks.topic_id = topics.id
        AND viewer_bookmarks.user_id = $1::uuid
    ) AS viewer_bookmarked
  FROM community_topics AS topics
  LEFT JOIN app_users AS authors ON authors.id = topics.author_user_id
`;

export function createCommunityStore(pool) {
  return {
    async listCommunityTopics({ viewerUserId = null, cursor = null, limit = 20 }) {
      const result = await pool.query(
        `${topicSelect}
         WHERE topics.status = 'published'
           AND topics.visibility = 'public'
           AND (
             $2::timestamptz IS NULL OR
             (topics.created_at, topics.id) < ($2::timestamptz, $3::uuid)
           )
           AND NOT EXISTS (
             SELECT 1 FROM community_user_blocks AS viewer_blocks
             WHERE viewer_blocks.blocker_user_id = $1::uuid
               AND viewer_blocks.blocked_user_id = topics.author_user_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM community_user_blocks AS author_blocks
             WHERE author_blocks.blocker_user_id = topics.author_user_id
               AND author_blocks.blocked_user_id = $1::uuid
           )
         ORDER BY topics.created_at DESC, topics.id DESC
         LIMIT $4`,
        [viewerUserId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map(mapTopic),
        nextCursor: hasMore && last
          ? { createdAt: iso(last.created_at), id: String(last.id) }
          : null,
      };
    },

    async getCommunityTopic({ topicId, viewerUserId = null }) {
      const result = await pool.query(
        `${topicSelect}
         WHERE topics.id = $2::uuid
         LIMIT 1`,
        [viewerUserId, topicId],
      );
      if (result.rowCount === 0) return null;
      if (
        result.rows[0].blocked_by_viewer ||
        result.rows[0].viewer_blocked_by_author
      ) {
        return {
          id: String(result.rows[0].id),
          status: "blocked",
          createdAt: iso(result.rows[0].created_at),
          fallbackPath: "/community",
        };
      }
      const topic = mapTopic(result.rows[0]);
      if (topic.status !== "published") {
        return {
          id: topic.id,
          status: topic.status,
          createdAt: topic.createdAt,
          fallbackPath: "/community",
        };
      }
      return topic;
    },

    async listCommunityComments({
      topicId,
      viewerUserId = null,
      cursor = null,
      limit = 20,
    }) {
      const roots = await pool.query(
        `SELECT id, created_at
         FROM community_comments
         WHERE topic_id = $1::uuid
           AND parent_comment_id IS NULL
           AND (
             $2::timestamptz IS NULL OR
             (created_at, id) > ($2::timestamptz, $3::uuid)
           )
         ORDER BY created_at ASC, id ASC
         LIMIT $4`,
        [topicId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      const hasMore = roots.rows.length > limit;
      const rootRows = roots.rows.slice(0, limit);
      const rootIds = rootRows.map((row) => String(row.id));
      if (rootIds.length === 0) return { items: [], nextCursor: null };

      const result = await pool.query(
        `SELECT
           comments.id,
           comments.topic_id,
           comments.author_user_id,
           comments.parent_comment_id,
           comments.root_comment_id,
           comments.reply_to_user_id,
           comments.body,
           comments.status,
           comments.version,
           comments.created_at,
           comments.updated_at,
           comments.edited_at,
           authors.username AS author_username,
           authors.display_name AS author_display_name,
           authors.avatar_url AS author_avatar_url,
           EXISTS (
             SELECT 1 FROM community_user_blocks AS blocks
             WHERE (
               blocks.blocker_user_id = $2::uuid AND
               blocks.blocked_user_id = comments.author_user_id
             ) OR (
               blocks.blocker_user_id = comments.author_user_id AND
               blocks.blocked_user_id = $2::uuid
             )
           ) AS blocked_by_viewer,
           (SELECT count(*) FROM community_comment_likes AS likes WHERE likes.comment_id = comments.id) AS like_count,
           EXISTS (
             SELECT 1 FROM community_comment_likes AS viewer_likes
             WHERE viewer_likes.comment_id = comments.id
               AND viewer_likes.user_id = $2::uuid
           ) AS viewer_liked
         FROM community_comments AS comments
         LEFT JOIN app_users AS authors ON authors.id = comments.author_user_id
         LEFT JOIN community_comments AS roots ON roots.id = COALESCE(comments.root_comment_id, comments.id)
         WHERE comments.topic_id = $1::uuid
           AND (
             comments.id = ANY($3::uuid[]) OR
             comments.root_comment_id = ANY($3::uuid[])
           )
         ORDER BY
           roots.created_at ASC,
           roots.id ASC,
           CASE WHEN comments.parent_comment_id IS NULL THEN 0 ELSE 1 END,
           comments.created_at ASC,
           comments.id ASC`,
        [topicId, viewerUserId, rootIds],
      );
      const last = rootRows.at(-1);
      return {
        items: result.rows.map(mapComment),
        nextCursor: hasMore && last
          ? { createdAt: iso(last.created_at), id: String(last.id) }
          : null,
      };
    },

    async createCommunityTopic({ userId, title, body, visibility }) {
      return withTransaction(pool, async (client) => {
        await assertPostingAllowed(client, userId);
        const result = await client.query(
          `INSERT INTO community_topics (
             author_user_id, title, body, visibility
           ) VALUES ($1::uuid, $2, $3, $4)
           RETURNING id, status, visibility, version, created_at, updated_at`,
          [userId, title, body, visibility],
        );
        return mutationTopic(result.rows[0]);
      });
    },

    async updateCommunityTopic({
      topicId,
      userId,
      expectedVersion,
      title,
      body,
      visibility,
    }) {
      return withTransaction(pool, async (client) => {
        await assertPostingAllowed(client, userId);
        const topic = await lockOwnedTopic(client, topicId, userId);
        if (Number(topic.version) !== expectedVersion) {
          throw communityError("COMMUNITY_VERSION_CONFLICT", {
            currentVersion: Number(topic.version),
          });
        }
        await recordTopicEdit(client, topic, userId);
        const result = await client.query(
          `UPDATE community_topics
           SET title = COALESCE($3, title),
               body = COALESCE($4, body),
               visibility = COALESCE($5, visibility),
               version = version + 1,
               updated_at = now(),
               edited_at = now()
           WHERE id = $1::uuid AND author_user_id = $2::uuid
           RETURNING id, status, visibility, version, created_at, updated_at`,
          [topicId, userId, title ?? null, body ?? null, visibility ?? null],
        );
        return mutationTopic(result.rows[0]);
      });
    },

    async deleteCommunityTopic({ topicId, userId, expectedVersion }) {
      return withTransaction(pool, async (client) => {
        const topic = await lockOwnedTopic(client, topicId, userId);
        if (Number(topic.version) !== expectedVersion) {
          throw communityError("COMMUNITY_VERSION_CONFLICT", {
            currentVersion: Number(topic.version),
          });
        }
        await recordTopicEdit(client, topic, userId);
        const result = await client.query(
          `UPDATE community_topics
           SET status = 'deleted',
               version = version + 1,
               updated_at = now(),
               deleted_at = now()
           WHERE id = $1::uuid AND author_user_id = $2::uuid
           RETURNING id, status, visibility, version, created_at, updated_at`,
          [topicId, userId],
        );
        return mutationTopic(result.rows[0]);
      });
    },

    async createCommunityComment({
      topicId,
      userId,
      body,
      replyToCommentId,
    }) {
      return withTransaction(pool, async (client) => {
        await assertPostingAllowed(client, userId);
        await assertTopicInteractionAllowed(client, topicId, userId);
        let parentCommentId = null;
        let replyToUserId = null;
        if (replyToCommentId) {
          const targetResult = await client.query(
            `SELECT
               comments.id,
               comments.author_user_id,
               comments.parent_comment_id,
               comments.root_comment_id,
               comments.status,
               EXISTS (
                 SELECT 1
                 FROM community_user_blocks AS blocks
                 WHERE (
                   blocks.blocker_user_id = $3::uuid AND
                   blocks.blocked_user_id = comments.author_user_id
                 ) OR (
                   blocks.blocker_user_id = comments.author_user_id AND
                   blocks.blocked_user_id = $3::uuid
                 )
               ) AS blocked
             FROM community_comments AS comments
             WHERE comments.id = $1::uuid AND comments.topic_id = $2::uuid
             FOR SHARE OF comments`,
            [replyToCommentId, topicId, userId],
          );
          const target = targetResult.rows[0];
          if (!target || target.status !== "published" || target.blocked) {
            throw communityError("COMMUNITY_REPLY_TARGET_UNAVAILABLE");
          }
          parentCommentId = target.parent_comment_id
            ? target.root_comment_id
            : target.id;
          replyToUserId = target.author_user_id;
        }
        const result = await client.query(
          `INSERT INTO community_comments (
             topic_id, author_user_id, parent_comment_id,
             root_comment_id, reply_to_user_id, body
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, $4::uuid, $5)
           RETURNING id, topic_id, parent_comment_id, root_comment_id,
                     status, version, created_at, updated_at`,
          [topicId, userId, parentCommentId, replyToUserId, body],
        );
        return mutationComment(result.rows[0]);
      });
    },

    async updateCommunityComment({
      commentId,
      userId,
      expectedVersion,
      body,
    }) {
      return withTransaction(pool, async (client) => {
        await assertPostingAllowed(client, userId);
        const comment = await lockOwnedComment(client, commentId, userId);
        if (Number(comment.version) !== expectedVersion) {
          throw communityError("COMMUNITY_VERSION_CONFLICT", {
            currentVersion: Number(comment.version),
          });
        }
        await recordCommentEdit(client, comment, userId);
        const result = await client.query(
          `UPDATE community_comments
           SET body = $3,
               version = version + 1,
               updated_at = now(),
               edited_at = now()
           WHERE id = $1::uuid AND author_user_id = $2::uuid
           RETURNING id, topic_id, parent_comment_id, root_comment_id,
                     status, version, created_at, updated_at`,
          [commentId, userId, body],
        );
        return mutationComment(result.rows[0]);
      });
    },

    async deleteCommunityComment({ commentId, userId, expectedVersion }) {
      return withTransaction(pool, async (client) => {
        const comment = await lockOwnedComment(client, commentId, userId);
        if (Number(comment.version) !== expectedVersion) {
          throw communityError("COMMUNITY_VERSION_CONFLICT", {
            currentVersion: Number(comment.version),
          });
        }
        await recordCommentEdit(client, comment, userId);
        const result = await client.query(
          `UPDATE community_comments
           SET status = 'deleted',
               version = version + 1,
               updated_at = now(),
               deleted_at = now()
           WHERE id = $1::uuid AND author_user_id = $2::uuid
           RETURNING id, topic_id, parent_comment_id, root_comment_id,
                     status, version, created_at, updated_at`,
          [commentId, userId],
        );
        return mutationComment(result.rows[0]);
      });
    },
  };
}
