export type CommunityAuthor = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type CommunityTopic = {
  id: string;
  title: string;
  body: string;
  status: "published" | "hidden" | "deleted" | "blocked";
  visibility: "public" | "unlisted";
  version: number;
  author: CommunityAuthor | null;
  likeCount: number;
  commentCount: number;
  liked: boolean;
  bookmarked: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
};

export type CommunityComment = {
  id: string;
  topicId: string;
  parentCommentId: string | null;
  rootCommentId: string | null;
  replyToUserId: string | null;
  body: string | null;
  status: "published" | "hidden" | "deleted" | "blocked";
  version: number;
  author: CommunityAuthor | null;
  likeCount: number;
  liked: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
};

export type CommunityPublicProfile = CommunityAuthor & {
  joinedAt: string;
  topicCount: number;
  commentCount: number;
};

export type CommunityProfileComment = {
  id: string;
  topicId: string;
  topicTitle: string;
  body: string;
  likeCount: number;
  liked: boolean;
  createdAt: string;
  editedAt: string | null;
};

export type CommunityNotification = {
  id: string;
  type: "topic_reply" | "comment_reply" | "mention" | "teacher_review_reply" | "content_moderated" | "system_announcement";
  topicId: string | null;
  commentId: string | null;
  teacherReviewId?: string | null;
  teacherReviewCommentId?: string | null;
  title: string;
  body: string | null;
  fallbackPath: string;
  actor: CommunityAuthor | null;
  read: boolean;
  createdAt: string;
  readAt: string | null;
};

export type CommunitySession = {
  authenticated: boolean;
  user: null | (CommunityAuthor & { role: "user" | "moderator" | "admin" });
};

export type CommunityApiError = Error & {
  status?: number;
  code?: string;
  currentVersion?: number;
};

export async function communityRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: init?.body
      ? { "Content-Type": "application/json", Accept: "application/json", ...init.headers }
      : { Accept: "application/json", ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    currentVersion?: number;
  };
  if (!response.ok) {
    const error = new Error(payload.error || "request_failed") as CommunityApiError;
    error.status = response.status;
    error.code = payload.error;
    error.currentVersion = payload.currentVersion;
    throw error;
  }
  return payload;
}

export function communityErrorMessage(error: unknown) {
  const apiError = error as CommunityApiError;
  switch (apiError.code) {
    case "authentication_required":
      return "登录后才能完成这项操作。";
    case "community_posting_forbidden":
      return "当前账号暂时不能发布内容。可在通知中查看处理结果。";
    case "community_action_forbidden":
      return "当前账号暂时不能完成这项互动。";
    case "community_content_unavailable":
    case "community_topic_unavailable":
      return "这条内容已不可用，列表已为你刷新。";
    case "community_version_conflict":
      return "内容刚刚在别处更新。请刷新后再编辑，避免覆盖新版本。";
    case "community_write_rate_limited":
    case "teacher_review_rate_limit_exceeded":
      return "操作有些频繁，请稍后再试。";
    case "community_report_rate_limited":
      return "举报提交较频繁，请稍后再试；已经提交的举报不会丢失。";
    case "invalid_community_target":
      return "不能对自己的内容或账号执行这项操作。";
    default:
      return "请求没有完成。检查网络后再试一次。";
  }
}

export function authorName(author: CommunityAuthor | null) {
  return author?.displayName || author?.username || "已注销用户";
}

export function formatCommunityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = Date.now();
  const distance = now - date.getTime();
  if (distance >= 0 && distance < 60_000) return "刚刚";
  if (distance >= 0 && distance < 3_600_000) return `${Math.floor(distance / 60_000)} 分钟前`;
  if (distance >= 0 && distance < 86_400_000) return `${Math.floor(distance / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export const reportReasons = [
  ["harassment", "骚扰或人身攻击"],
  ["privacy", "泄露隐私"],
  ["spam", "广告或刷屏"],
  ["misinformation", "明显误导"],
  ["illegal", "违法违规"],
  ["self_harm", "自伤风险"],
  ["other", "其他"],
] as const;
