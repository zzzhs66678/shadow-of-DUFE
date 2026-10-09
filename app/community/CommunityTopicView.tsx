"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DialogActions, DialogBackdrop } from "../DialogBackdrop";
import { FormField } from "../FormField";
import {
  authorName,
  communityErrorMessage,
  communityRequest,
  formatCommunityTime,
  type CommunityComment,
  type CommunitySession,
  type CommunityTopic,
} from "./community-api";
import {
  AuthorBadge,
  CommunityHeader,
  Feedback,
  NotificationsPanel,
  ReportDialog,
} from "./CommunityShared";
import { useModalFocus } from "../use-modal-focus";
import { hasDistinctTitle, PostMenu, WallIcon } from "./WallPrimitives";
import { useWallDraft, useWallSending, useWallUnsaved } from "./use-wall-unsaved";
import styles from "./community.module.css";

type PageState = "loading" | "ready" | "missing" | "error";
type ReplyTarget = Pick<CommunityComment, "id" | "author">;
type TopicDraft = {
  replyBody: string;
  replyTo: ReplyTarget | null;
  topicEdit: { title: string; body: string; originalTitle: string; originalBody: string; version: number; visibility: CommunityTopic["visibility"] } | null;
  commentEdit: { id: string; body: string; originalBody: string; version: number } | null;
};
const EMPTY_DRAFT: TopicDraft = { replyBody: "", replyTo: null, topicEdit: null, commentEdit: null };
function hasDraft(draft: TopicDraft) {
  return Boolean(draft.replyBody.trim() ||
    (draft.topicEdit && (draft.topicEdit.title !== draft.topicEdit.originalTitle || draft.topicEdit.body !== draft.topicEdit.originalBody)) ||
    (draft.commentEdit && draft.commentEdit.body !== draft.commentEdit.originalBody));
}
function parseDraft(value: unknown): TopicDraft {
  if (!value || typeof value !== "object") return EMPTY_DRAFT;
  const draft = value as TopicDraft;
  const text = (input: unknown, limit: number) => typeof input === "string" && input.length <= limit;
  const version = (input: unknown) => Number.isSafeInteger(input) && Number(input) > 0;
  const replyTo = draft.replyTo;
  const topicEdit = draft.topicEdit;
  const commentEdit = draft.commentEdit;
  return {
    replyBody: text(draft.replyBody, 3000) ? draft.replyBody : "",
    replyTo: replyTo && text(replyTo.id, 200) && (!replyTo.author || (text(replyTo.author.id, 200) &&
      [replyTo.author.username, replyTo.author.displayName, replyTo.author.avatarUrl].every((item) => item === null || text(item, 2000)))) ? replyTo : null,
    topicEdit: topicEdit && text(topicEdit.title, 120) && text(topicEdit.body, 5000) && text(topicEdit.originalTitle, 120) && text(topicEdit.originalBody, 5000) && version(topicEdit.version) &&
      ["public", "unlisted"].includes(topicEdit.visibility) ? topicEdit : null,
    commentEdit: commentEdit && text(commentEdit.id, 200) && text(commentEdit.body, 3000) && text(commentEdit.originalBody, 3000) && version(commentEdit.version) ? commentEdit : null,
  };
}
function normalizedTitle(value: string) { return value.normalize("NFKC").replace(/\s+/gu, " ").trim(); }

export function CommunityTopicView({ topicId }: { topicId: string }) {
  const [session, setSession] = useState<CommunitySession | null>(null);
  const [sessionError, setSessionError] = useState(false);
  const sessionRequest = useRef(0);
  const refreshSession = useCallback(async () => {
    const request = ++sessionRequest.current;
    try {
      const next = await communityRequest<CommunitySession>("/api/auth/session");
      if (request !== sessionRequest.current) return;
      setSession(next);
      setSessionError(false);
    } catch {
      if (request === sessionRequest.current) setSessionError(true);
    }
  }, []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") void refreshSession(); };
    const invalidate = () => { sessionRequest.current++; };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      invalidate();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshSession]);
  if (!session) return <main className={styles.page}><CommunityHeader session={null} unread={0} onOpenNotifications={() => {}} /><div className={styles.fullState} role="status">{sessionError ? <><b>登录状态加载失败</b><button onClick={() => void refreshSession()}>重试</button></> : "正在加载讨论…"}</div></main>;
  return <TopicContent key={JSON.stringify([session.authenticated ? session.user?.id : null, topicId])} topicId={topicId} session={session} refreshSession={refreshSession} />;
}

function TopicContent({ topicId, session, refreshSession }: { topicId: string; session: CommunitySession; refreshSession: () => Promise<void> }) {
  const [topic, setTopic] = useState<CommunityTopic | null>(null);
  const [comments, setComments] = useState<CommunityComment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PageState>("loading");
  const draftKey = session.authenticated && session.user ? `dufe:wall:topic-draft:v1:${encodeURIComponent(session.user.id)}:${encodeURIComponent(topicId)}` : null;
  const [draft, updateDraft, settleDraft] = useWallDraft(draftKey, EMPTY_DRAFT, parseDraft, hasDraft);
  const { replyTo, replyBody, topicEdit: editingTopic, commentEdit: editingComment } = draft;
  const editTitle = editingTopic?.title ?? "";
  const editBody = editingTopic?.body ?? "";
  const editCommentBody = editingComment?.body ?? "";
  const setReplyBody = (body: string) => updateDraft((current) => ({ ...current, replyBody: body }));
  const setReplyTo = (target: ReplyTarget | null) => updateDraft((current) => ({ ...current, replyTo: target }));
  const startTopicEdit = () => {
    if (!topic || editingTopic) return;
    updateDraft((current) => ({ ...current, topicEdit: { title: topic.title, body: topic.body, originalTitle: topic.title, originalBody: topic.body, version: topic.version, visibility: topic.visibility } }));
  };
  const startCommentEdit = (comment: CommunityComment) => {
    if (editPending.current || editSending) return;
    updateDraft((current) => ({ ...current, commentEdit: { id: comment.id, body: comment.body ?? "", originalBody: comment.body ?? "", version: comment.version } }));
  };
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [backTo, setBackTo] = useState("/community");
  const replyPending = useRef(false);
  const [replySending, setReplySending] = useWallSending(`${draftKey}:reply`);
  const editPending = useRef(false);
  const [editSending, setEditSending] = useWallSending(`${draftKey}:edit`);
  const alive = useRef(true);
  const pageRequest = useRef(0);
  const commentsRequest = useRef(0);
  useLayoutEffect(() => {
    alive.current = true;
    const invalidate = () => { pageRequest.current++; commentsRequest.current++; };
    return () => { alive.current = false; invalidate(); };
  }, []);
  const ownerHeaders = { "X-Community-Owner": session?.user?.id ?? "" };
  const [unread, setUnread] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [collapsedThreadIds, setCollapsedThreadIds] = useState<Set<string>>(() => new Set());
  const [reportTarget, setReportTarget] = useState<{ type: "topic" | "comment" | "user"; id: string; label: string } | null>(null);
  const closeEditComment = useCallback(() => {
    if (editSending) return;
    if (editingComment && editingComment.body !== editingComment.originalBody && !window.confirm("放弃这次修改？")) return;
    updateDraft((current) => ({ ...current, commentEdit: null }));
  }, [editingComment, editSending, updateDraft]);
  useWallUnsaved(hasDraft(draft));
  const editCommentRef = useModalFocus<HTMLFormElement>(Boolean(editingComment), closeEditComment, editSending);
  function reportError(error: unknown) {
    if (!alive.current) return;
    setFeedback(communityErrorMessage(error));
    if ((error as { code?: string }).code === "community_account_changed") void refreshSession();
  }
  const openNotifications = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("panel", "notifications");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    setNotificationsOpen(true);
  }, []);
  const closeNotifications = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("panel");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    setNotificationsOpen(false);
  }, []);
  const closeReport = useCallback(() => setReportTarget(null), []);

  const loadComments = useCallback(async (cursor?: string, append = false) => {
    const request = ++commentsRequest.current;
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const payload = await communityRequest<{ items: CommunityComment[]; nextCursor: string | null }>(`/api/community/topics/${topicId}/comments?limit=20${suffix}`);
    if (!alive.current || request !== commentsRequest.current) return;
    setComments((current) => append ? [...current, ...payload.items.filter((item) => !current.some((old) => old.id === item.id))] : payload.items);
    setNextCursor(payload.nextCursor);
  }, [topicId]);

  const loadPage = useCallback(async () => {
    const request = ++pageRequest.current;
    setPageState("loading");
    try {
      const topicPayload = await communityRequest<{ topic: CommunityTopic }>(`/api/community/topics/${topicId}`);
      if (!alive.current || request !== pageRequest.current) return;
      setTopic(topicPayload.topic);
      await loadComments();
      if (!alive.current || request !== pageRequest.current) return;
      if (session.authenticated) {
        void communityRequest<{ unread: number }>("/api/community/notifications/unread-count").then((count) => { if (alive.current && request === pageRequest.current) setUnread(count.unread); }).catch(() => {});
      }
      setPageState("ready");
    } catch (error) {
      if (!alive.current || request !== pageRequest.current) return;
      const status = (error as { status?: number }).status;
      setPageState(status === 404 || status === 410 ? "missing" : "error");
    }
  }, [loadComments, topicId, session.authenticated]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setBackTo(new URLSearchParams(window.location.search).get("from") === "replied" ? "/community?sort=replied" : "/community");
      void loadPage();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadPage]);

  const threads = useMemo(() => {
    const roots = comments.filter((comment) => !comment.parentCommentId);
    const replies = new Map<string, CommunityComment[]>();
    for (const comment of comments) {
      if (!comment.rootCommentId) continue;
      replies.set(comment.rootCommentId, [...(replies.get(comment.rootCommentId) ?? []), comment]);
    }
    return roots.map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
  }, [comments]);

  const isOwner = Boolean(topic?.author?.id && topic.author.id === session?.user?.id);

  function setThreadCollapsed(threadId: string, collapsed: boolean) {
    setCollapsedThreadIds((current) => {
      const next = new Set(current);
      if (collapsed) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  }

  async function toggleTopic(action: "like" | "bookmark") {
    if (!topic) return;
    if (!session?.authenticated) {
      setFeedback("登录后就能点赞和收藏。");
      return;
    }
    const active = action === "like" ? topic.liked : topic.bookmarked;
    setBusy(action);
    try {
      const response = await communityRequest<{ like?: { active: boolean; total?: number }; bookmark?: { active: boolean } }>(`/api/community/topics/${topic.id}/${action}`, { method: active ? "DELETE" : "PUT", headers: ownerHeaders });
      if (!alive.current) return;
      setTopic((current) => current ? {
        ...current,
        ...(action === "like" ? {
          liked: response.like?.active ?? !active,
          likeCount: response.like?.total ?? Math.max(0, current.likeCount + (active ? -1 : 1)),
        } : { bookmarked: response.bookmark?.active ?? !active }),
      } : current);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy("");
    }
  }

  async function saveTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!topic || !editingTopic || editPending.current || editSending || !editBody.trim()) return;
    const title = normalizedTitle(editTitle);
    const titleChanged = editTitle !== editingTopic.originalTitle;
    if (titleChanged && ([...title].length < 4 || title.length > 120)) {
      setFeedback("标题至少需要 4 个字符，且不能超过 120 字符长度。");
      return;
    }
    editPending.current = true;
    setEditSending(true);
    setBusy("edit-topic");
    try {
      await communityRequest(`/api/community/topics/${topic.id}`, {
        method: "PATCH",
        headers: ownerHeaders,
        body: JSON.stringify({ ...(titleChanged ? { title } : {}), body: editBody, visibility: editingTopic.visibility, version: editingTopic.version }),
      });
      settleDraft((current) => JSON.stringify(current.topicEdit) === JSON.stringify(editingTopic) ? { ...current, topicEdit: null } : current);
      if (!alive.current) return;
      await loadPage();
      if (!alive.current) return;
      setFeedback("帖子已更新。");
    } catch (error) {
      reportError(error);
    } finally {
      editPending.current = false;
      setEditSending(false);
      setBusy("");
    }
  }

  async function deleteTopic() {
    if (!topic || !window.confirm("确定删除这条帖子？正文无法恢复。")) return;
    setBusy("delete-topic");
    try {
      await communityRequest(`/api/community/topics/${topic.id}`, { method: "DELETE", headers: ownerHeaders, body: JSON.stringify({ version: topic.version }) });
      if (!alive.current) return;
      window.location.assign(backTo);
    } catch (error) {
      reportError(error);
      setBusy("");
    }
  }

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.authenticated || !replyBody.trim() || replyPending.current || replySending) return;
    replyPending.current = true;
    setReplySending(true);
    setBusy("reply");
    try {
      await communityRequest(`/api/community/topics/${topicId}/comments`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ body: replyBody, replyToCommentId: replyTo?.id ?? null }),
      });
      settleDraft((current) => current.replyBody === replyBody && current.replyTo?.id === replyTo?.id ? { ...current, replyBody: "", replyTo: null } : current);
      if (!alive.current) return;
      await loadComments();
      if (!alive.current) return;
      setTopic((current) => current ? { ...current, commentCount: current.commentCount + 1 } : current);
      setFeedback("回复已发布。");
    } catch (error) {
      reportError(error);
    } finally {
      replyPending.current = false;
      setReplySending(false);
      setBusy("");
    }
  }

  function chooseReply(comment: CommunityComment) {
    if (replyPending.current || replySending) return;
    setReplyTo({ id: comment.id, author: comment.author });
    const field = document.getElementById("community-reply");
    field?.focus({ preventScroll: true });
    field?.scrollIntoView({ block: "center" });
  }

  async function toggleCommentLike(comment: CommunityComment) {
    if (!session?.authenticated) {
      setFeedback("登录后就能点赞。");
      return;
    }
    setBusy(`comment-like:${comment.id}`);
    try {
      const payload = await communityRequest<{ like: { active: boolean; total?: number } }>(`/api/community/comments/${comment.id}/like`, { method: comment.liked ? "DELETE" : "PUT", headers: ownerHeaders });
      if (!alive.current) return;
      setComments((current) => current.map((item) => item.id === comment.id ? {
        ...item,
        liked: payload.like.active,
        likeCount: payload.like.total ?? Math.max(0, item.likeCount + (comment.liked ? -1 : 1)),
      } : item));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy("");
    }
  }

  async function saveComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingComment || !editCommentBody.trim() || editPending.current || editSending) return;
    editPending.current = true;
    setEditSending(true);
    setBusy(`comment-edit:${editingComment.id}`);
    try {
      await communityRequest(`/api/community/comments/${editingComment.id}`, {
        method: "PATCH",
        headers: ownerHeaders,
        body: JSON.stringify({ body: editCommentBody, version: editingComment.version }),
      });
      settleDraft((current) => JSON.stringify(current.commentEdit) === JSON.stringify(editingComment) ? { ...current, commentEdit: null } : current);
      if (!alive.current) return;
      await loadComments();
      if (!alive.current) return;
      setFeedback("回复已更新。");
    } catch (error) {
      reportError(error);
    } finally {
      editPending.current = false;
      setEditSending(false);
      setBusy("");
    }
  }

  async function deleteComment(comment: CommunityComment) {
    if (!window.confirm("删除后正文不再显示，讨论位置仍保留。确认删除回复？")) return;
    setBusy(`comment-delete:${comment.id}`);
    try {
      await communityRequest(`/api/community/comments/${comment.id}`, { method: "DELETE", headers: ownerHeaders, body: JSON.stringify({ version: comment.version }) });
      if (!alive.current) return;
      await loadComments();
      if (!alive.current) return;
      setFeedback("回复已删除。");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy("");
    }
  }

  async function blockAuthor(authorId: string) {
    if (!window.confirm("屏蔽后，你们将互相看不到对方的社区内容，相关旧互动也会清理。确认屏蔽？")) return;
    setBusy("block");
    try {
      await communityRequest(`/api/community/users/${authorId}/block`, { method: "PUT", headers: ownerHeaders });
      if (!alive.current) return;
      window.location.assign("/community");
    } catch (error) {
      reportError(error);
      setBusy("");
    }
  }

  async function shareTopic() {
    if (!topic) return;
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: topic.title, url });
        setFeedback("已打开系统分享。");
        return;
      }
      await navigator.clipboard.writeText(url);
      setFeedback("讨论链接已复制。");
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      try {
        const field = document.createElement("textarea");
        field.value = url;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand("copy");
        field.remove();
        if (!copied) throw new Error("copy_failed");
        setFeedback("讨论链接已复制。");
      } catch {
        setFeedback("复制失败，请从浏览器地址栏复制链接。");
      }
    }
  }

  if (pageState === "loading") {
    return <main className={styles.page}><CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} /><div className={styles.fullState} role="status"><i /><b>正在加载讨论…</b></div></main>;
  }

  if (pageState === "missing") {
    return <main className={styles.page}><CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} /><div className={styles.fullState}><b>帖子暂不可见</b><p>它可能已被删除、隐藏，或因屏蔽关系无法查看。</p><Link href={backTo}>返回东财墙</Link></div></main>;
  }

  if (pageState === "error" || !topic) {
    return <main className={styles.page}><CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} /><div className={styles.fullState} role="alert"><b>讨论加载失败</b><p>检查网络后重试。</p><button onClick={() => void loadPage()}>重新加载</button></div></main>;
  }

  return (
    <main className={styles.page}>
      <CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} />
      <div className={styles.topicCrumb}><Link href={backTo}><WallIcon name="back" />返回东财墙</Link></div>

      <article className={styles.topicReading}>
        <header className={styles.postIdentity}><AuthorBadge author={topic.author} /><PostMenu>
          {isOwner ? <><button onClick={startTopicEdit} disabled={editSending}>编辑帖子</button><button onClick={() => void deleteTopic()} disabled={busy === "delete-topic"}>删除帖子</button></> : session?.authenticated ? <><button onClick={() => setReportTarget({ type: "topic", id: topic.id, label: topic.title })}>举报帖子</button>{topic.author && <button onClick={() => void blockAuthor(topic.author!.id)} disabled={busy === "block"}>屏蔽作者</button>}</> : <Link href="/?view=me">登录</Link>}
        </PostMenu></header>
        <h1 className={hasDistinctTitle(topic) ? undefined : styles.srOnly}>{hasDistinctTitle(topic) ? topic.title : "帖子详情"}</h1>
        <div className={styles.topicBody}>{topic.body}</div>
        <div className={styles.postMeta}><time dateTime={topic.createdAt} suppressHydrationWarning>{formatCommunityTime(topic.createdAt)}</time>{topic.editedAt ? " · 已编辑" : ""}{topic.visibility === "unlisted" ? " · 仅链接可见" : ""}</div>
        <footer className={styles.postActions}>
          <a href="#community-reply" onClick={() => document.getElementById("community-reply")?.focus()}><WallIcon name="reply" />{topic.commentCount} 回复</a>
          <button className={topic.liked ? styles.activeAction : undefined} onClick={() => void toggleTopic("like")} disabled={busy === "like"} aria-pressed={topic.liked} aria-label={`${topic.liked ? "取消点赞" : "点赞"} ${topic.likeCount}`}><WallIcon name="heart" />{topic.likeCount || "赞"}</button>
          <button className={topic.bookmarked ? styles.activeAction : undefined} onClick={() => void toggleTopic("bookmark")} disabled={busy === "bookmark"} aria-pressed={topic.bookmarked}><WallIcon name="bookmark" />{topic.bookmarked ? "已收藏" : "收藏"}</button>
          <button onClick={() => void shareTopic()} aria-label="分享帖子"><WallIcon name="share" /></button>
        </footer>
      </article>

      {editingTopic && (
        <form className={styles.inlineEditor} onSubmit={saveTopic}>
          <header><b>编辑帖子</b><button type="button" disabled={editSending} onClick={() => { if (editPending.current) return; if ((editTitle === editingTopic.originalTitle && editBody === editingTopic.originalBody) || window.confirm("放弃这次修改？")) updateDraft((current) => ({ ...current, topicEdit: null })); }}>取消</button></header>
          <FormField label="标题" counter={`${[...normalizedTitle(editTitle)].length} 字符`} hint="修改标题需至少 4 个字符。" variant="display"><input value={editTitle} disabled={editSending} onChange={(event) => updateDraft((current) => ({ ...current, topicEdit: current.topicEdit ? { ...current.topicEdit, title: event.target.value } : null }))} maxLength={120} /></FormField>
          <FormField label="正文" counter={`${editBody.length} / 5000`}><textarea value={editBody} disabled={editSending} onChange={(event) => updateDraft((current) => ({ ...current, topicEdit: current.topicEdit ? { ...current.topicEdit, body: event.target.value } : null }))} maxLength={5000} rows={9} /></FormField>
          <button disabled={editSending || (editTitle !== editingTopic.originalTitle && ([...normalizedTitle(editTitle)].length < 4 || normalizedTitle(editTitle).length > 120)) || !editBody.trim()}>{editSending ? "正在保存" : "保存更改"}</button>
        </form>
      )}

      <section className={styles.discussion} id="discussion" aria-labelledby="discussion-title">
        <header><h2 id="discussion-title">回复 {topic.commentCount || ""}</h2></header>
        <Feedback message={feedback} />

        {session?.authenticated ? (
          <form className={styles.replyComposer} onSubmit={submitReply}>
            <label htmlFor="community-reply">{replyTo ? `回复 ${authorName(replyTo.author)}` : "说说你的想法"}</label>
            {replyTo && <button type="button" disabled={replySending} onClick={() => { if (!replyPending.current) setReplyTo(null); }}>取消指定回复</button>}
            <textarea id="community-reply" name="reply-body" autoComplete="off" value={replyBody} disabled={replySending} onChange={(event) => { if (!replyPending.current) setReplyBody(event.target.value); }} maxLength={3000} rows={2} required placeholder="写回复…" />
            <div><small>{replyBody.length ? `${replyBody.length} / 3000` : ""}</small><button disabled={replySending}>{replySending ? "发布中…" : "回复"}</button></div>
          </form>
        ) : (
          <div className={styles.discussionLogin}><b>登录后加入讨论</b><Link href="/?view=me">去登录</Link></div>
        )}

        {threads.length === 0 && <div className={styles.noComments}><b>还没有回复</b></div>}

        <ol className={styles.commentThreads}>
          {threads.map(({ root, replies }) => (
            <li key={root.id}>
              <div className={styles.threadContent} id={`community-thread-${root.id}`} hidden={collapsedThreadIds.has(root.id)}>
                <CommentEntry
                  comment={root}
                  session={session}
                  busy={busy}
                  replyDisabled={replySending}
                  onReply={chooseReply}
                  onLike={toggleCommentLike}
                  onEdit={startCommentEdit}
                  onDelete={deleteComment}
                  onReport={(comment) => setReportTarget({ type: "comment", id: comment.id, label: `回复 ${comment.body?.slice(0, 24) || "已删除内容"}` })}
                  onCollapse={() => setThreadCollapsed(root.id, true)}
                  collapseControls={`community-thread-${root.id}`}
                />
                {replies.length > 0 && <ol className={styles.replies}>{replies.map((reply) => <li key={reply.id}><CommentEntry comment={reply} session={session} busy={busy} replyDisabled={replySending} onReply={chooseReply} onLike={toggleCommentLike} onEdit={startCommentEdit} onDelete={deleteComment} onReport={(comment) => setReportTarget({ type: "comment", id: comment.id, label: `回复 ${comment.body?.slice(0, 24) || "已删除内容"}` })} /></li>)}</ol>}
              </div>
              {collapsedThreadIds.has(root.id) && (
                <article className={styles.foldedThread}>
                  <header><AuthorBadge author={root.author} /><time suppressHydrationWarning dateTime={root.createdAt}>{formatCommunityTime(root.createdAt)}</time></header>
                  <button aria-expanded="false" aria-controls={`community-thread-${root.id}`} onClick={() => setThreadCollapsed(root.id, false)}>展开回复{replies.length > 0 ? ` · ${replies.length} 条` : ""}</button>
                </article>
              )}
            </li>
          ))}
        </ol>

        {nextCursor && <button className={styles.loadMore} onClick={() => void loadComments(nextCursor, true)}>加载更多回复</button>}
      </section>

      {editingComment && (
        <DialogBackdrop onDismiss={closeEditComment} dismissDisabled={editSending}>
          <form ref={editCommentRef} className={styles.reportSheet} role="dialog" aria-modal="true" aria-labelledby="edit-comment-title" onSubmit={saveComment}>
            <h2 id="edit-comment-title">修改回复</h2>
            <FormField label="回复正文" counter={`${editCommentBody.length} / 3000`}><textarea value={editCommentBody} disabled={editSending} onChange={(event) => updateDraft((current) => ({ ...current, commentEdit: current.commentEdit ? { ...current.commentEdit, body: event.target.value } : null }))} maxLength={3000} rows={5} /></FormField>
            <DialogActions><button type="button" onClick={closeEditComment} disabled={editSending}>取消</button><button disabled={editSending || !editCommentBody.trim()}>保存更改</button></DialogActions>
          </form>
        </DialogBackdrop>
      )}

      <NotificationsPanel open={notificationsOpen} onClose={closeNotifications} unread={unread} onUnreadChange={setUnread} />
      <ReportDialog target={reportTarget} onClose={closeReport} onReported={setFeedback} />
    </main>
  );
}

function CommentEntry({
  comment,
  session,
  busy,
  replyDisabled,
  onReply,
  onLike,
  onEdit,
  onDelete,
  onReport,
  onCollapse,
  collapseControls,
}: {
  comment: CommunityComment;
  session: CommunitySession | null;
  busy: string;
  replyDisabled: boolean;
  onReply: (comment: CommunityComment) => void;
  onLike: (comment: CommunityComment) => Promise<void>;
  onEdit: (comment: CommunityComment) => void;
  onDelete: (comment: CommunityComment) => Promise<void>;
  onReport: (comment: CommunityComment) => void;
  onCollapse?: () => void;
  collapseControls?: string;
}) {
  const own = Boolean(comment.author?.id && comment.author.id === session?.user?.id);
  const unavailable = comment.status !== "published" || !comment.body;
  return (
    <article className={unavailable ? styles.commentUnavailable : styles.commentEntry}>
      <header><AuthorBadge author={comment.author} /><time suppressHydrationWarning dateTime={comment.createdAt}>{formatCommunityTime(comment.createdAt)}{comment.editedAt ? " · 已编辑" : ""}</time></header>
      <p>{unavailable ? (comment.status === "blocked" ? "这条回复因屏蔽关系不再显示。" : "这条回复已不可见，讨论位置仍被保留。") : comment.body}</p>
      {!unavailable && <footer>
        <button className={comment.liked ? styles.activeAction : undefined} onClick={() => void onLike(comment)} disabled={busy === `comment-like:${comment.id}`} aria-pressed={comment.liked} aria-label={`${comment.liked ? "取消点赞回复" : "点赞回复"} ${comment.likeCount}`}><WallIcon name="heart" />{comment.likeCount || "赞"}</button>
        {session?.authenticated && <button disabled={replyDisabled} onClick={() => onReply(comment)}><WallIcon name="reply" />回复</button>}
        {(own || session?.authenticated || onCollapse) && <PostMenu label="回复更多操作">
          {own ? <><button onClick={() => onEdit(comment)}>编辑</button><button onClick={() => void onDelete(comment)} disabled={busy === `comment-delete:${comment.id}`}>删除</button></> : session?.authenticated ? <button onClick={() => onReport(comment)}>举报回复</button> : null}
          {onCollapse && <button aria-expanded="true" aria-controls={collapseControls} onClick={onCollapse}>收起回复</button>}
        </PostMenu>}
      </footer>}
    </article>
  );
}
