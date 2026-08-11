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

function mapProfileComment(row) {
  return {
    id: String(row.id),
    topicId: String(row.topic_id),
    topicTitle: row.topic_title,
    body: row.body,
    likeCount: Number(row.like_count ?? 0),
    liked: Boolean(row.viewer_liked),
    createdAt: iso(row.created_at),
    editedAt: iso(row.edited_at),
  };
}

function communityError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

export function communityModerationAllowedActions(
  targetType,
  targetStatus,
  activeSanctionType = null,
) {
  if (targetType === "user") {
    if (targetStatus !== "active") return ["dismiss"];
    return activeSanctionType
      ? ["unban"]
      : ["warn", "suspend", "ban", "dismiss"];
  }
  if (targetStatus === "hidden") return ["restore", "delete"];
  if (targetStatus === "published") {
    return ["hide", "delete", "warn", "dismiss"];
  }
  return ["warn", "dismiss"];
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

async function assertElevatedAdmin(client, input) {
  const result = await client.query(
    `SELECT
       users.role,
       users.status,
       COALESCE(users.display_name, users.username) AS actor_label
     FROM app_users AS users
     JOIN user_sessions AS sessions
       ON sessions.id = $2::uuid
      AND sessions.user_id = users.id
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > now()
     JOIN admin_elevated_sessions AS elevation
       ON elevation.base_session_id = sessions.id
      AND elevation.user_id = users.id
      AND elevation.token_hash = $3
      AND elevation.revoked_at IS NULL
      AND elevation.expires_at > now()
     WHERE users.id = $1::uuid
     FOR UPDATE OF users, sessions, elevation`,
    [
      input.actorUserId,
      input.actorSessionId,
      input.actorElevationTokenHash,
    ],
  );
  if (
    result.rowCount !== 1 ||
    result.rows[0].role !== "admin" ||
    result.rows[0].status !== "active"
  ) {
    throw communityError("AUTH_ADMIN_FORBIDDEN");
  }
  return result.rows[0];
}

async function insertAdminAudit(client, input, action, targetType, targetId, metadata) {
  await client.query(
    `INSERT INTO admin_audit_events (
       actor_user_id, actor_role, session_id, action,
       target_type, target_id, request_id, ip_hash, user_agent_hash, metadata
     ) VALUES (
       $1::uuid, 'admin', $2::uuid, $3, $4, $5, $6::uuid, $7, $8, $9::jsonb
     )`,
    [
      input.actorUserId,
      input.actorSessionId,
      action,
      targetType,
      String(targetId),
      input.requestId,
      input.ipHash,
      input.userAgentHash,
      JSON.stringify(metadata),
    ],
  );
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

async function assertCommunityAccountAllowed(client, userId, { rejectBan = true } = {}) {
  const result = await client.query(
    `SELECT
       users.status,
       EXISTS (
         SELECT 1
         FROM community_user_sanctions AS sanctions
         WHERE sanctions.user_id = users.id
           AND sanctions.sanction_type = 'ban'
           AND sanctions.revoked_at IS NULL
           AND sanctions.starts_at <= now()
           AND (sanctions.expires_at IS NULL OR sanctions.expires_at > now())
       ) AS banned
     FROM app_users AS users
     WHERE users.id = $1::uuid
     FOR UPDATE OF users`,
    [userId],
  );
  if (
    result.rowCount !== 1 ||
    result.rows[0].status !== "active" ||
    (rejectBan && result.rows[0].banned)
  ) {
    throw communityError("COMMUNITY_ACTION_FORBIDDEN");
  }
}

async function assertInteractionTarget(client, targetType, targetId, userId) {
  const result = targetType === "topic"
    ? await client.query(
        `SELECT
           topics.id,
           topics.author_user_id,
           topics.status,
           EXISTS (
             SELECT 1 FROM community_user_blocks AS blocks
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
        [targetId, userId],
      )
    : await client.query(
        `SELECT
           comments.id,
           comments.author_user_id,
           comments.status,
           topics.author_user_id AS topic_author_user_id,
           topics.status AS topic_status,
           EXISTS (
             SELECT 1 FROM community_user_blocks AS blocks
             WHERE (
               blocks.blocker_user_id = $2::uuid AND
               blocks.blocked_user_id IN (
                 comments.author_user_id, topics.author_user_id
               )
             ) OR (
               blocks.blocked_user_id = $2::uuid AND
               blocks.blocker_user_id IN (
                 comments.author_user_id, topics.author_user_id
               )
             )
           ) AS blocked
         FROM community_comments AS comments
         JOIN community_topics AS topics ON topics.id = comments.topic_id
         WHERE comments.id = $1::uuid
         FOR SHARE OF comments, topics`,
        [targetId, userId],
      );
  const target = result.rows[0];
  if (
    !target ||
    target.status !== "published" ||
    (targetType === "comment" && target.topic_status !== "published") ||
    target.blocked
  ) {
    throw communityError("COMMUNITY_CONTENT_UNAVAILABLE");
  }
  return target;
}

async function assertReportTarget(client, targetType, targetId, userId) {
  if (targetType === "user") {
    if (String(targetId) === String(userId)) {
      throw communityError("COMMUNITY_REPORT_SELF");
    }
    const result = await client.query(
      `SELECT id FROM app_users WHERE id = $1::uuid AND status = 'active' FOR SHARE`,
      [targetId],
    );
    if (result.rowCount !== 1) {
      throw communityError("COMMUNITY_CONTENT_UNAVAILABLE");
    }
    return;
  }
  const result = targetType === "topic"
    ? await client.query(
        `SELECT id, author_user_id, status
         FROM community_topics
         WHERE id = $1::uuid
         FOR SHARE`,
        [targetId],
      )
    : await client.query(
        `SELECT
           comments.id,
           comments.author_user_id,
           comments.status,
           topics.status AS topic_status
         FROM community_comments AS comments
         JOIN community_topics AS topics ON topics.id = comments.topic_id
         WHERE comments.id = $1::uuid
         FOR SHARE OF comments, topics`,
        [targetId],
      );
  const target = result.rows[0];
  if (
    !target ||
    target.status !== "published" ||
    (targetType === "comment" && target.topic_status !== "published")
  ) {
    throw communityError("COMMUNITY_CONTENT_UNAVAILABLE");
  }
  if (String(target.author_user_id) === String(userId)) {
    throw communityError("COMMUNITY_REPORT_SELF");
  }
}

async function communityReportEvidence(client, targetType, targetId) {
  const result = targetType === "topic"
    ? await client.query(
        `SELECT topics.title AS evidence_title,
                topics.body AS evidence_body,
                COALESCE(authors.display_name, authors.username, '已注销用户') AS evidence_author_label
         FROM community_topics AS topics
         LEFT JOIN app_users AS authors ON authors.id = topics.author_user_id
         WHERE topics.id = $1::uuid`,
        [targetId],
      )
    : targetType === "comment"
      ? await client.query(
          `SELECT NULL::text AS evidence_title,
                  comments.body AS evidence_body,
                  COALESCE(authors.display_name, authors.username, '已注销用户') AS evidence_author_label
           FROM community_comments AS comments
           LEFT JOIN app_users AS authors ON authors.id = comments.author_user_id
           WHERE comments.id = $1::uuid`,
          [targetId],
        )
      : await client.query(
          `SELECT COALESCE(users.display_name, users.username) AS evidence_title,
                  NULL::text AS evidence_body,
                  COALESCE(users.display_name, users.username, '已注销用户') AS evidence_author_label
           FROM app_users AS users
           WHERE users.id = $1::uuid`,
          [targetId],
        );
  if (result.rowCount !== 1) {
    throw communityError("COMMUNITY_CONTENT_UNAVAILABLE");
  }
  return result.rows[0];
}

function mentionUsernames(body) {
  const usernames = new Set();
  const pattern = /(^|[^\p{L}\p{N}_-])@([\p{L}\p{N}_-]{3,24})/gu;
  for (const match of body.matchAll(pattern)) {
    usernames.add(
      match[2].normalize("NFKC").toLocaleLowerCase("en-US"),
    );
    if (usernames.size >= 10) break;
  }
  return [...usernames];
}

async function insertMentionNotifications(
  client,
  {
    actorUserId,
    topicId,
    commentId = null,
    body,
    excludedUserIds = [],
  },
) {
  const usernames = mentionUsernames(body);
  if (usernames.length === 0) return;
  const contentType = commentId ? "comment" : "topic";
  const fallbackPath = `/community/topics/${topicId}`;
  await client.query(
    `WITH recipients AS (
       SELECT users.id
       FROM app_users AS users
       WHERE users.normalized_username = ANY($1::text[])
         AND users.status = 'active'
         AND users.id <> $2::uuid
         AND NOT (users.id = ANY($7::uuid[]))
         AND NOT EXISTS (
           SELECT 1 FROM community_user_blocks AS blocks
           WHERE (
             blocks.blocker_user_id = $2::uuid AND
             blocks.blocked_user_id = users.id
           ) OR (
             blocks.blocker_user_id = users.id AND
             blocks.blocked_user_id = $2::uuid
           )
         )
     ), inserted_mentions AS (
       INSERT INTO community_mentions (
         mentioned_user_id, actor_user_id, topic_id, comment_id
       )
       SELECT id, $2::uuid, $3::uuid, $4::uuid
       FROM recipients
       ON CONFLICT DO NOTHING
       RETURNING mentioned_user_id
     )
     INSERT INTO community_notifications (
       recipient_user_id, actor_user_id, notification_type,
       topic_id, comment_id, title, body, fallback_path, dedupe_key
     )
     SELECT
       mentioned_user_id,
       $2::uuid,
       'mention',
       $3::uuid,
       $4::uuid,
       '有人在社区中提到了你',
       left($5, 500),
       $6,
       'mention:${contentType}:' || ${commentId ? "$4::uuid" : "$3::uuid"}::text || ':' || mentioned_user_id::text
     FROM inserted_mentions
     ON CONFLICT DO NOTHING`,
    [
      usernames,
      actorUserId,
      topicId,
      commentId,
      body,
      fallbackPath,
      excludedUserIds,
    ],
  );
}

async function insertReplyNotification(
  client,
  { recipientUserId, actorUserId, topicId, commentId, replyType, body },
) {
  if (!recipientUserId || String(recipientUserId) === String(actorUserId)) return;
  await client.query(
    `INSERT INTO community_notifications (
       recipient_user_id, actor_user_id, notification_type,
       topic_id, comment_id, title, body, fallback_path, dedupe_key
     )
     SELECT
       users.id,
       $2::uuid,
       $5,
       $3::uuid,
       $4::uuid,
       CASE
         WHEN $5 = 'topic_reply' THEN '有人回复了你的主题'
         ELSE '有人回复了你的评论'
       END,
       left($6, 500),
       '/community/topics/' || $3::uuid::text,
       'reply:' || $4::uuid::text || ':' || users.id::text
     FROM app_users AS users
     WHERE users.id = $1::uuid
       AND users.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM community_user_blocks AS blocks
         WHERE (
           blocks.blocker_user_id = $2::uuid AND
           blocks.blocked_user_id = users.id
         ) OR (
           blocks.blocker_user_id = users.id AND
           blocks.blocked_user_id = $2::uuid
         )
       )
     ON CONFLICT DO NOTHING`,
    [
      recipientUserId,
      actorUserId,
      topicId,
      commentId,
      replyType,
      body,
    ],
  );
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

function reportResult(row) {
  return {
    id: String(row.id),
    targetType: row.target_type,
    targetId: String(row.target_id),
    reasonCode: row.reason_code,
    status: row.status,
    created: Boolean(row.created),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function notificationResult(row) {
  return {
    id: String(row.id),
    type: row.notification_type,
    topicId: row.topic_id ? String(row.topic_id) : null,
    commentId: row.comment_id ? String(row.comment_id) : null,
    title: row.title,
    body: row.body,
    fallbackPath: row.fallback_path,
    actor: row.actor_user_id && (row.actor_username || row.actor_display_name)
      ? {
          id: String(row.actor_user_id),
          username: row.actor_username,
          displayName: row.actor_display_name,
          avatarUrl: row.actor_avatar_url,
        }
      : null,
    read: Boolean(row.read_at),
    createdAt: iso(row.created_at),
    readAt: iso(row.read_at),
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
    async getCommunityUserProfile({ userId, viewerUserId = null }) {
      const result = await pool.query(
        `SELECT
           users.id,
           users.username,
           users.display_name,
           users.avatar_url,
           users.created_at,
           (
             SELECT count(*)
             FROM community_topics AS topics
             WHERE topics.author_user_id = users.id
               AND topics.status = 'published'
               AND topics.visibility = 'public'
           ) AS topic_count,
           (
             SELECT count(*)
             FROM community_comments AS comments
             JOIN community_topics AS topics ON topics.id = comments.topic_id
             WHERE comments.author_user_id = users.id
               AND comments.status = 'published'
               AND topics.status = 'published'
               AND topics.visibility = 'public'
           ) AS comment_count
         FROM app_users AS users
         WHERE users.id = $2::uuid
           AND users.status = 'active'
           AND NOT EXISTS (
             SELECT 1
             FROM community_user_blocks AS blocks
             WHERE (
               blocks.blocker_user_id = $1::uuid AND
               blocks.blocked_user_id = users.id
             ) OR (
               blocks.blocker_user_id = users.id AND
               blocks.blocked_user_id = $1::uuid
             )
           )
         LIMIT 1`,
        [viewerUserId, userId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        joinedAt: iso(row.created_at),
        topicCount: Number(row.topic_count ?? 0),
        commentCount: Number(row.comment_count ?? 0),
      };
    },

    async listCommunityUserContent({
      userId,
      viewerUserId = null,
      kind = "topics",
      cursor = null,
      limit = 20,
    }) {
      const values = [
        viewerUserId,
        userId,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ];
      const result = kind === "comments"
        ? await pool.query(
            `SELECT
               comments.id,
               comments.topic_id,
               topics.title AS topic_title,
               comments.body,
               comments.created_at,
               comments.edited_at,
               (SELECT count(*) FROM community_comment_likes AS likes WHERE likes.comment_id = comments.id) AS like_count,
               EXISTS (
                 SELECT 1 FROM community_comment_likes AS viewer_likes
                 WHERE viewer_likes.comment_id = comments.id
                   AND viewer_likes.user_id = $1::uuid
               ) AS viewer_liked
             FROM community_comments AS comments
             JOIN community_topics AS topics ON topics.id = comments.topic_id
             WHERE comments.author_user_id = $2::uuid
               AND comments.status = 'published'
               AND topics.status = 'published'
               AND topics.visibility = 'public'
               AND EXISTS (
                 SELECT 1 FROM app_users AS profile_user
                 WHERE profile_user.id = $2::uuid
                   AND profile_user.status = 'active'
               )
               AND (
                 $3::timestamptz IS NULL OR
                 (comments.created_at, comments.id) < ($3::timestamptz, $4::uuid)
               )
               AND NOT EXISTS (
                 SELECT 1 FROM community_user_blocks AS blocks
                 WHERE (
                   blocks.blocker_user_id = $1::uuid AND
                   blocks.blocked_user_id = $2::uuid
                 ) OR (
                   blocks.blocker_user_id = $2::uuid AND
                   blocks.blocked_user_id = $1::uuid
                 )
               )
             ORDER BY comments.created_at DESC, comments.id DESC
             LIMIT $5`,
            values,
          )
        : await pool.query(
            `${topicSelect}
             WHERE topics.author_user_id = $2::uuid
               AND topics.status = 'published'
               AND topics.visibility = 'public'
               AND EXISTS (
                 SELECT 1 FROM app_users AS profile_user
                 WHERE profile_user.id = $2::uuid
                   AND profile_user.status = 'active'
               )
               AND (
                 $3::timestamptz IS NULL OR
                 (topics.created_at, topics.id) < ($3::timestamptz, $4::uuid)
               )
               AND NOT EXISTS (
                 SELECT 1 FROM community_user_blocks AS blocks
                 WHERE (
                   blocks.blocker_user_id = $1::uuid AND
                   blocks.blocked_user_id = $2::uuid
                 ) OR (
                   blocks.blocker_user_id = $2::uuid AND
                   blocks.blocked_user_id = $1::uuid
                 )
               )
             ORDER BY topics.created_at DESC, topics.id DESC
             LIMIT $5`,
            values,
          );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map(kind === "comments" ? mapProfileComment : mapTopic),
        nextCursor: hasMore && last
          ? { createdAt: iso(last.created_at), id: String(last.id) }
          : null,
      };
    },

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
        await insertMentionNotifications(client, {
          actorUserId: userId,
          topicId: result.rows[0].id,
          body,
        });
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
        await insertMentionNotifications(client, {
          actorUserId: userId,
          topicId,
          body: body ?? topic.body,
        });
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
        await client.query(
          `UPDATE community_notifications
           SET title = '相关主题已删除',
               body = NULL,
               fallback_path = '/community'
           WHERE topic_id = $1::uuid`,
          [topicId],
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
        const topic = await assertTopicInteractionAllowed(
          client,
          topicId,
          userId,
        );
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
        const recipientUserId = replyToCommentId
          ? replyToUserId
          : topic.author_user_id;
        await insertReplyNotification(client, {
          recipientUserId,
          actorUserId: userId,
          topicId,
          commentId: result.rows[0].id,
          replyType: replyToCommentId ? "comment_reply" : "topic_reply",
          body,
        });
        await insertMentionNotifications(client, {
          actorUserId: userId,
          topicId,
          commentId: result.rows[0].id,
          body,
          excludedUserIds: recipientUserId ? [recipientUserId] : [],
        });
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
        await insertMentionNotifications(client, {
          actorUserId: userId,
          topicId: comment.topic_id,
          commentId,
          body,
        });
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
        await client.query(
          `UPDATE community_notifications
           SET title = '相关回复已删除',
               body = NULL,
               fallback_path = '/community'
           WHERE comment_id = $1::uuid`,
          [commentId],
        );
        return mutationComment(result.rows[0]);
      });
    },

    async setCommunityLike({ targetType, targetId, userId, active }) {
      const table = targetType === "topic"
        ? "community_topic_likes"
        : "community_comment_likes";
      const idColumn = targetType === "topic" ? "topic_id" : "comment_id";
      if (!active) {
        await pool.query(
          `DELETE FROM ${table}
           WHERE ${idColumn} = $1::uuid AND user_id = $2::uuid`,
          [targetId, userId],
        );
        return { active: false };
      }
      return withTransaction(pool, async (client) => {
        await assertCommunityAccountAllowed(client, userId);
        await assertInteractionTarget(client, targetType, targetId, userId);
        const result = await client.query(
          `WITH inserted AS (
             INSERT INTO ${table} (${idColumn}, user_id)
             VALUES ($1::uuid, $2::uuid)
             ON CONFLICT DO NOTHING
             RETURNING 1
           )
           SELECT true AS active,
                  (SELECT count(*) FROM ${table} WHERE ${idColumn} = $1::uuid) AS total`,
          [targetId, userId],
        );
        return {
          active: true,
          total: Number(result.rows[0].total),
        };
      });
    },

    async setCommunityBookmark({ topicId, userId, active }) {
      if (!active) {
        await pool.query(
          `DELETE FROM community_topic_bookmarks
           WHERE topic_id = $1::uuid AND user_id = $2::uuid`,
          [topicId, userId],
        );
        return { active: false };
      }
      return withTransaction(pool, async (client) => {
        await assertCommunityAccountAllowed(client, userId);
        await assertInteractionTarget(client, "topic", topicId, userId);
        await client.query(
          `INSERT INTO community_topic_bookmarks (topic_id, user_id)
           VALUES ($1::uuid, $2::uuid)
           ON CONFLICT DO NOTHING`,
          [topicId, userId],
        );
        return { active: true };
      });
    },

    async setCommunityBlock({ blockerUserId, blockedUserId, active }) {
      if (String(blockerUserId) === String(blockedUserId)) {
        throw communityError("COMMUNITY_BLOCK_SELF");
      }
      if (!active) {
        await pool.query(
          `DELETE FROM community_user_blocks
           WHERE blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid`,
          [blockerUserId, blockedUserId],
        );
        return { active: false };
      }
      return withTransaction(pool, async (client) => {
        await assertCommunityAccountAllowed(client, blockerUserId, {
          rejectBan: false,
        });
        const target = await client.query(
          `SELECT id FROM app_users
           WHERE id = $1::uuid AND status = 'active'
           FOR SHARE`,
          [blockedUserId],
        );
        if (target.rowCount !== 1) {
          throw communityError("COMMUNITY_CONTENT_NOT_FOUND");
        }
        await client.query(
          `INSERT INTO community_user_blocks (blocker_user_id, blocked_user_id)
           VALUES ($1::uuid, $2::uuid)
           ON CONFLICT DO NOTHING`,
          [blockerUserId, blockedUserId],
        );
        await client.query(
          `DELETE FROM community_topic_likes AS likes
           USING community_topics AS topics
           WHERE likes.topic_id = topics.id
             AND (
               (likes.user_id = $1::uuid AND topics.author_user_id = $2::uuid) OR
               (likes.user_id = $2::uuid AND topics.author_user_id = $1::uuid)
             )`,
          [blockerUserId, blockedUserId],
        );
        await client.query(
          `DELETE FROM community_comment_likes AS likes
           USING community_comments AS comments
           WHERE likes.comment_id = comments.id
             AND (
               (likes.user_id = $1::uuid AND comments.author_user_id = $2::uuid) OR
               (likes.user_id = $2::uuid AND comments.author_user_id = $1::uuid)
             )`,
          [blockerUserId, blockedUserId],
        );
        await client.query(
          `DELETE FROM community_topic_bookmarks AS bookmarks
           USING community_topics AS topics
           WHERE bookmarks.topic_id = topics.id
             AND bookmarks.user_id = $1::uuid
             AND topics.author_user_id = $2::uuid`,
          [blockerUserId, blockedUserId],
        );
        await client.query(
          `UPDATE community_notifications
           SET dismissed_at = COALESCE(dismissed_at, now())
           WHERE recipient_user_id = $1::uuid
             AND actor_user_id = $2::uuid
             AND dismissed_at IS NULL`,
          [blockerUserId, blockedUserId],
        );
        return { active: true };
      });
    },

    async createCommunityReport({
      reporterUserId,
      targetType,
      targetId,
      reasonCode,
      detail,
    }) {
      return withTransaction(pool, async (client) => {
        await assertCommunityAccountAllowed(client, reporterUserId, {
          rejectBan: false,
        });
        await assertReportTarget(
          client,
          targetType,
          targetId,
          reporterUserId,
        );
        const evidence = await communityReportEvidence(
          client,
          targetType,
          targetId,
        );
        const result = await client.query(
          `WITH inserted AS (
             INSERT INTO community_reports (
               reporter_user_id, target_type, target_id, reason_code, detail,
               evidence_title, evidence_body, evidence_author_label
             ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8)
             ON CONFLICT (reporter_user_id, target_type, target_id)
               WHERE status IN ('open', 'reviewing')
             DO NOTHING
             RETURNING id, target_type, target_id, reason_code, status,
                       created_at, updated_at, true AS created
           )
           SELECT * FROM inserted
           UNION ALL
           SELECT id, target_type, target_id, reason_code, status,
                  created_at, updated_at, false AS created
           FROM community_reports
           WHERE reporter_user_id = $1::uuid
             AND target_type = $2
             AND target_id = $3::uuid
             AND status IN ('open', 'reviewing')
             AND NOT EXISTS (SELECT 1 FROM inserted)
           LIMIT 1`,
          [
            reporterUserId,
            targetType,
            targetId,
            reasonCode,
            detail,
            evidence.evidence_title,
            evidence.evidence_body,
            evidence.evidence_author_label,
          ],
        );
        return reportResult(result.rows[0]);
      });
    },

    async listCommunityReportQueue({ status = "open", limit = 50 }) {
      const result = await pool.query(
        `SELECT
           reports.id,
           reports.target_type,
           reports.target_id,
           reports.reason_code,
           reports.detail,
           reports.status,
           reports.created_at,
           reports.updated_at,
           reporter.username AS reporter_username,
           COALESCE(reports.evidence_title, left(reports.evidence_body, 160)) AS target_label,
           reports.evidence_title,
           reports.evidence_body,
           reports.evidence_author_label,
           reports.evidence_captured_at,
           CASE
             WHEN reports.target_type = 'topic' THEN topics.status
             WHEN reports.target_type = 'comment' THEN comments.status
             ELSE target_user.status
           END AS target_status,
           active_sanction.sanction_type AS active_sanction_type,
           cases.id AS case_id,
           cases.status AS case_status
         FROM community_reports AS reports
         LEFT JOIN app_users AS reporter ON reporter.id = reports.reporter_user_id
         LEFT JOIN community_topics AS topics
           ON reports.target_type = 'topic' AND topics.id = reports.target_id
         LEFT JOIN community_comments AS comments
           ON reports.target_type = 'comment' AND comments.id = reports.target_id
         LEFT JOIN app_users AS target_user
           ON reports.target_type = 'user' AND target_user.id = reports.target_id
         LEFT JOIN LATERAL (
           SELECT sanctions.sanction_type
           FROM community_user_sanctions AS sanctions
           WHERE reports.target_type = 'user'
             AND sanctions.user_id = reports.target_id
             AND sanctions.revoked_at IS NULL
             AND sanctions.starts_at <= now()
             AND (sanctions.expires_at IS NULL OR sanctions.expires_at > now())
           ORDER BY sanctions.created_at DESC
           LIMIT 1
         ) AS active_sanction ON true
         LEFT JOIN community_case_reports AS links ON links.report_id = reports.id
         LEFT JOIN community_moderation_cases AS cases ON cases.id = links.case_id
         WHERE reports.status = $1
         ORDER BY reports.created_at ASC, reports.id ASC
         LIMIT $2`,
        [status, limit],
      );
      return result.rows.map((row) => {
        const targetStatus = row.target_status;
        const allowedActions = communityModerationAllowedActions(
          row.target_type,
          targetStatus,
          row.active_sanction_type,
        );
        return {
          id: String(row.id),
          targetType: row.target_type,
          targetId: String(row.target_id),
          targetLabel: row.target_label,
          evidenceTitle: row.evidence_title,
          evidenceBody: row.evidence_body,
          evidenceAuthorLabel: row.evidence_author_label,
          evidenceCapturedAt: iso(row.evidence_captured_at),
          targetStatus,
          activeSanctionType: row.active_sanction_type,
          allowedActions,
          reporterUsername: row.reporter_username,
          reasonCode: row.reason_code,
          detail: row.detail,
          status: row.status,
          caseId: row.case_id ? String(row.case_id) : null,
          caseStatus: row.case_status,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        };
      });
    },

    async openCommunityModerationCase(input) {
      return withTransaction(pool, async (client) => {
        const actor = await assertElevatedAdmin(client, input);
        const reportResultQuery = await client.query(
          `SELECT id, target_type, target_id, status
           FROM community_reports
           WHERE id = $1::uuid
           FOR UPDATE`,
          [input.reportId],
        );
        const report = reportResultQuery.rows[0];
        if (!report || !["open", "reviewing"].includes(report.status)) {
          throw communityError("COMMUNITY_REPORT_NOT_FOUND");
        }
        let caseResult = await client.query(
          `INSERT INTO community_moderation_cases (
             target_type, target_id, assigned_moderator_id
           ) VALUES ($1, $2::uuid, $3::uuid)
           ON CONFLICT (target_type, target_id)
             WHERE status IN ('open', 'reviewing', 'appealed')
           DO NOTHING
           RETURNING id, target_type, target_id, status, assigned_moderator_id,
                     opened_at, updated_at, true AS created`,
          [report.target_type, report.target_id, input.actorUserId],
        );
        if (caseResult.rowCount === 0) {
          caseResult = await client.query(
            `SELECT id, target_type, target_id, status, assigned_moderator_id,
                    opened_at, updated_at, false AS created
             FROM community_moderation_cases
             WHERE target_type = $1
               AND target_id = $2::uuid
               AND status IN ('open', 'reviewing', 'appealed')
             FOR UPDATE`,
            [report.target_type, report.target_id],
          );
        }
        const moderationCase = caseResult.rows[0];
        const link = await client.query(
          `INSERT INTO community_case_reports (case_id, report_id)
           VALUES ($1::uuid, $2::uuid)
           ON CONFLICT DO NOTHING
           RETURNING report_id`,
          [moderationCase.id, input.reportId],
        );
        if (link.rowCount === 0) {
          return {
            id: String(moderationCase.id),
            targetType: moderationCase.target_type,
            targetId: String(moderationCase.target_id),
            status: moderationCase.status,
            created: false,
          };
        }
        await client.query(
          `UPDATE community_reports
           SET status = 'reviewing'
           WHERE id = $1::uuid AND status = 'open'`,
          [input.reportId],
        );
        await client.query(
          `UPDATE community_moderation_cases
           SET status = 'reviewing', assigned_moderator_id = $2::uuid
           WHERE id = $1::uuid`,
          [moderationCase.id, input.actorUserId],
        );
        const moderationAction = moderationCase.created
          ? "case_opened"
          : "assigned";
        await client.query(
          `INSERT INTO community_moderation_actions (
             case_id, actor_user_id, actor_label, actor_role, action,
             target_type, target_id, reason, metadata, request_id
           ) VALUES (
             $1::uuid, $2::uuid, $3, 'admin', $4,
             $5, $6::uuid, $7, $8::jsonb, $9::uuid
           )`,
          [
            moderationCase.id,
            input.actorUserId,
            actor.actor_label,
            moderationAction,
            report.target_type,
            report.target_id,
            input.reason,
            JSON.stringify({ reportId: String(input.reportId) }),
            input.requestId,
          ],
        );
        await insertAdminAudit(
          client,
          input,
          "admin.community.case_opened",
          report.target_type,
          report.target_id,
          {
            caseId: String(moderationCase.id),
            reportId: String(input.reportId),
            reason: input.reason,
          },
        );
        return {
          id: String(moderationCase.id),
          targetType: report.target_type,
          targetId: String(report.target_id),
          status: "reviewing",
          created: Boolean(moderationCase.created),
        };
      });
    },

    async applyCommunityModerationAction(input) {
      return withTransaction(pool, async (client) => {
        const actor = await assertElevatedAdmin(client, input);
        const caseResult = await client.query(
          `SELECT id, target_type, target_id, status
           FROM community_moderation_cases
           WHERE id = $1::uuid
           FOR UPDATE`,
          [input.caseId],
        );
        const moderationCase = caseResult.rows[0];
        if (
          !moderationCase ||
          !["open", "reviewing", "appealed"].includes(moderationCase.status)
        ) {
          throw communityError("COMMUNITY_CASE_NOT_FOUND");
        }
        if (
          ["suspend", "ban", "unban"].includes(input.action) &&
          moderationCase.target_type !== "user"
        ) {
          throw communityError("COMMUNITY_MODERATION_ACTION_INVALID");
        }
        if (
          ["hide", "restore", "delete"].includes(input.action) &&
          !["topic", "comment"].includes(moderationCase.target_type)
        ) {
          throw communityError("COMMUNITY_MODERATION_ACTION_INVALID");
        }
        if (
          String(moderationCase.target_id) === String(input.actorUserId) &&
          ["suspend", "ban"].includes(input.action)
        ) {
          throw communityError("COMMUNITY_MODERATION_SELF_FORBIDDEN");
        }

        let recipientUserId = null;
        let topicId = null;
        let commentId = null;
        if (["topic", "comment"].includes(moderationCase.target_type)) {
          const table = moderationCase.target_type === "topic"
            ? "community_topics"
            : "community_comments";
          const target = await client.query(
            `SELECT id, author_user_id, status${
              moderationCase.target_type === "comment" ? ", topic_id" : ""
            }
             FROM ${table}
             WHERE id = $1::uuid
             FOR UPDATE`,
            [moderationCase.target_id],
          );
          if (target.rowCount !== 1) {
            throw communityError("COMMUNITY_CASE_NOT_FOUND");
          }
          const allowedActions = communityModerationAllowedActions(
            moderationCase.target_type,
            target.rows[0].status,
          );
          if (!allowedActions.includes(input.action)) {
            throw communityError("COMMUNITY_MODERATION_STATE_CONFLICT");
          }
          recipientUserId = target.rows[0].author_user_id;
          topicId = moderationCase.target_type === "topic"
            ? moderationCase.target_id
            : target.rows[0].topic_id;
          commentId = moderationCase.target_type === "comment"
            ? moderationCase.target_id
            : null;
          if (input.action === "hide") {
            if (target.rows[0].status !== "published") {
              throw communityError("COMMUNITY_MODERATION_STATE_CONFLICT");
            }
            await client.query(
              `UPDATE ${table}
               SET status = 'hidden', version = version + 1, updated_at = now()
               WHERE id = $1::uuid`,
              [moderationCase.target_id],
            );
            await client.query(
              `UPDATE community_notifications
               SET title = '相关内容正在审核', body = NULL,
                   fallback_path = '/community'
               WHERE ${moderationCase.target_type === "topic" ? "topic_id" : "comment_id"} = $1::uuid`,
              [moderationCase.target_id],
            );
          } else if (input.action === "restore") {
            if (target.rows[0].status !== "hidden") {
              throw communityError("COMMUNITY_MODERATION_STATE_CONFLICT");
            }
            await client.query(
              `UPDATE ${table}
               SET status = 'published', version = version + 1,
                   updated_at = now(), deleted_at = NULL
               WHERE id = $1::uuid`,
              [moderationCase.target_id],
            );
          } else if (input.action === "delete") {
            if (target.rows[0].status === "deleted") {
              throw communityError("COMMUNITY_MODERATION_STATE_CONFLICT");
            }
            await client.query(
              `UPDATE ${table}
               SET status = 'deleted', version = version + 1,
                   updated_at = now(), deleted_at = now()
               WHERE id = $1::uuid`,
              [moderationCase.target_id],
            );
            await client.query(
              `UPDATE community_notifications
               SET title = '相关内容已被处理', body = NULL,
                   fallback_path = '/community'
               WHERE ${moderationCase.target_type === "topic" ? "topic_id" : "comment_id"} = $1::uuid`,
              [moderationCase.target_id],
            );
          }
        } else {
          const targetUser = await client.query(
            `SELECT id, status
             FROM app_users
             WHERE id = $1::uuid
             FOR UPDATE`,
            [moderationCase.target_id],
          );
          if (targetUser.rowCount !== 1) {
            throw communityError("COMMUNITY_CASE_NOT_FOUND");
          }
          const activeSanction = await client.query(
            `SELECT sanction_type
             FROM community_user_sanctions
             WHERE user_id = $1::uuid
               AND revoked_at IS NULL
               AND starts_at <= now()
               AND (expires_at IS NULL OR expires_at > now())
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [moderationCase.target_id],
          );
          const allowedActions = communityModerationAllowedActions(
            "user",
            targetUser.rows[0].status,
            activeSanction.rows[0]?.sanction_type ?? null,
          );
          if (!allowedActions.includes(input.action)) {
            throw communityError("COMMUNITY_MODERATION_STATE_CONFLICT");
          }
          recipientUserId = moderationCase.target_id;
        }

        if (["suspend", "ban"].includes(input.action)) {
          const expiresAt = input.durationHours
            ? new Date(Date.now() + input.durationHours * 60 * 60 * 1_000)
            : null;
          await client.query(
            `INSERT INTO community_user_sanctions (
               user_id, sanction_type, reason, expires_at, created_by_user_id
             ) VALUES ($1::uuid, $2, $3, $4, $5::uuid)`,
            [
              moderationCase.target_id,
              input.action === "suspend" ? "posting_suspension" : "ban",
              input.reason,
              expiresAt,
              input.actorUserId,
            ],
          );
        } else if (input.action === "unban") {
          const revoked = await client.query(
            `UPDATE community_user_sanctions
             SET revoked_at = now(), revoked_by_user_id = $2::uuid
             WHERE user_id = $1::uuid AND revoked_at IS NULL`,
            [moderationCase.target_id, input.actorUserId],
          );
          if (revoked.rowCount === 0) {
            throw communityError("COMMUNITY_MODERATION_STATE_CONFLICT");
          }
        }

        const remainsReviewing = ["hide", "suspend", "ban"].includes(input.action);
        const reportStatus = remainsReviewing
          ? "reviewing"
          : input.action === "dismiss"
            ? "dismissed"
            : "resolved";
        const caseStatus = remainsReviewing
          ? "reviewing"
          : input.action === "dismiss"
            ? "closed"
            : "resolved";
        await client.query(
          `UPDATE community_reports AS reports
           SET status = $2
           FROM community_case_reports AS links
           WHERE links.case_id = $1::uuid
             AND reports.id = links.report_id
             AND reports.status IN ('open', 'reviewing')`,
          [input.caseId, reportStatus],
        );
        await client.query(
          `UPDATE community_moderation_cases
           SET status = $2, assigned_moderator_id = $3::uuid
           WHERE id = $1::uuid`,
          [input.caseId, caseStatus, input.actorUserId],
        );
        await client.query(
          `INSERT INTO community_moderation_actions (
             case_id, actor_user_id, actor_label, actor_role, action,
             target_type, target_id, reason, metadata, request_id
           ) VALUES (
             $1::uuid, $2::uuid, $3, 'admin', $4,
             $5, $6::uuid, $7, $8::jsonb, $9::uuid
           )`,
          [
            input.caseId,
            input.actorUserId,
            actor.actor_label,
            input.action,
            moderationCase.target_type,
            moderationCase.target_id,
            input.reason,
            JSON.stringify({ durationHours: input.durationHours ?? null }),
            input.requestId,
          ],
        );
        await insertAdminAudit(
          client,
          input,
          `admin.community.${input.action}`,
          moderationCase.target_type,
          moderationCase.target_id,
          {
            caseId: String(input.caseId),
            reason: input.reason,
            durationHours: input.durationHours ?? null,
          },
        );
        if (
          recipientUserId &&
          String(recipientUserId) !== String(input.actorUserId)
        ) {
          await client.query(
            `INSERT INTO community_notifications (
               recipient_user_id, actor_user_id, notification_type,
               topic_id, comment_id, title, body, fallback_path, dedupe_key
             ) VALUES (
               $1::uuid, $2::uuid, 'content_moderated',
               $3::uuid, $4::uuid, '你的社区内容有新的处理结果',
               $5, '/community', 'moderation:' || $6::uuid::text
             )
             ON CONFLICT DO NOTHING`,
            [
              recipientUserId,
              input.actorUserId,
              topicId,
              commentId,
              input.reason,
              input.requestId,
            ],
          );
        }
        return {
          id: String(input.caseId),
          targetType: moderationCase.target_type,
          targetId: String(moderationCase.target_id),
          status: caseStatus,
          action: input.action,
        };
      });
    },

    async listCommunityNotifications({
      userId,
      cursor = null,
      limit = 20,
    }) {
      const result = await pool.query(
        `SELECT
           notifications.id,
           notifications.notification_type,
           notifications.topic_id,
           notifications.comment_id,
           notifications.title,
           notifications.body,
           notifications.fallback_path,
           notifications.actor_user_id,
           notifications.created_at,
           notifications.read_at,
           actors.username AS actor_username,
           actors.display_name AS actor_display_name,
           actors.avatar_url AS actor_avatar_url
         FROM community_notifications AS notifications
         LEFT JOIN app_users AS actors ON actors.id = notifications.actor_user_id
         WHERE notifications.recipient_user_id = $1::uuid
           AND notifications.dismissed_at IS NULL
           AND (
             $2::timestamptz IS NULL OR
             (notifications.created_at, notifications.id) <
               ($2::timestamptz, $3::uuid)
           )
           AND NOT EXISTS (
             SELECT 1 FROM community_user_blocks AS blocks
             WHERE notifications.actor_user_id IS NOT NULL
               AND (
                 (blocks.blocker_user_id = $1::uuid AND
                  blocks.blocked_user_id = notifications.actor_user_id) OR
                 (blocks.blocker_user_id = notifications.actor_user_id AND
                  blocks.blocked_user_id = $1::uuid)
               )
           )
         ORDER BY notifications.created_at DESC, notifications.id DESC
         LIMIT $4`,
        [userId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map(notificationResult),
        nextCursor: hasMore && last
          ? { createdAt: iso(last.created_at), id: String(last.id) }
          : null,
      };
    },

    async getCommunityUnreadCount(userId) {
      const result = await pool.query(
        `SELECT count(*) AS total
         FROM community_notifications AS notifications
         WHERE notifications.recipient_user_id = $1::uuid
           AND notifications.read_at IS NULL
           AND notifications.dismissed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM community_user_blocks AS blocks
             WHERE notifications.actor_user_id IS NOT NULL
               AND (
                 (blocks.blocker_user_id = $1::uuid AND
                  blocks.blocked_user_id = notifications.actor_user_id) OR
                 (blocks.blocker_user_id = notifications.actor_user_id AND
                  blocks.blocked_user_id = $1::uuid)
               )
           )`,
        [userId],
      );
      return Number(result.rows[0]?.total ?? 0);
    },

    async markCommunityNotificationRead({ userId, notificationId }) {
      const result = await pool.query(
        `UPDATE community_notifications
         SET read_at = COALESCE(read_at, now())
         WHERE id = $1::uuid
           AND recipient_user_id = $2::uuid
           AND dismissed_at IS NULL
         RETURNING id, read_at`,
        [notificationId, userId],
      );
      return result.rowCount === 1
        ? { id: String(result.rows[0].id), readAt: iso(result.rows[0].read_at) }
        : null;
    },

    async markAllCommunityNotificationsRead(userId) {
      const result = await pool.query(
        `UPDATE community_notifications
         SET read_at = COALESCE(read_at, now())
         WHERE recipient_user_id = $1::uuid
           AND read_at IS NULL
           AND dismissed_at IS NULL`,
        [userId],
      );
      return { updated: result.rowCount };
    },

    async dismissCommunityNotification({ userId, notificationId }) {
      const result = await pool.query(
        `UPDATE community_notifications
         SET read_at = COALESCE(read_at, now()),
             dismissed_at = COALESCE(dismissed_at, now())
         WHERE id = $1::uuid
           AND recipient_user_id = $2::uuid
           AND dismissed_at IS NULL
         RETURNING id`,
        [notificationId, userId],
      );
      return result.rowCount === 1;
    },
  };
}
