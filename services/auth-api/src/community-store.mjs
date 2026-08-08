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
  };
}
