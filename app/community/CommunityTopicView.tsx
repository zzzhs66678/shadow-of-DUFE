"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
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
import styles from "./community.module.css";

type PageState = "loading" | "ready" | "missing" | "error";

export function CommunityTopicView({ topicId }: { topicId: string }) {
  const [session, setSession] = useState<CommunitySession | null>(null);
  const [topic, setTopic] = useState<CommunityTopic | null>(null);
  const [comments, setComments] = useState<CommunityComment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PageState>("loading");
  const [replyTo, setReplyTo] = useState<CommunityComment | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [editingTopic, setEditingTopic] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editingComment, setEditingComment] = useState<CommunityComment | null>(null);
  const [editCommentBody, setEditCommentBody] = useState("");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [unread, setUnread] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<{ type: "topic" | "comment" | "user"; id: string; label: string } | null>(null);
  const closeEditComment = useCallback(() => setEditingComment(null), []);
  const editCommentRef = useModalFocus<HTMLFormElement>(Boolean(editingComment), closeEditComment, busy.startsWith("comment-edit:"));
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
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const payload = await communityRequest<{ items: CommunityComment[]; nextCursor: string | null }>(`/api/community/topics/${topicId}/comments?limit=20${suffix}`);
    setComments((current) => append ? [...current, ...payload.items] : payload.items);
    setNextCursor(payload.nextCursor);
  }, [topicId]);

  const loadPage = useCallback(async () => {
    setPageState("loading");
    try {
      const [topicPayload, sessionPayload] = await Promise.all([
        communityRequest<{ topic: CommunityTopic }>(`/api/community/topics/${topicId}`),
        communityRequest<CommunitySession>("/api/auth/session"),
      ]);
      setTopic(topicPayload.topic);
      setSession(sessionPayload);
      await loadComments();
      if (sessionPayload.authenticated) {
        const count = await communityRequest<{ unread: number }>("/api/community/notifications/unread-count");
        setUnread(count.unread);
      }
      setPageState("ready");
    } catch (error) {
      const status = (error as { status?: number }).status;
      setPageState(status === 404 || status === 410 ? "missing" : "error");
    }
  }, [loadComments, topicId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void loadPage(); });
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

  async function toggleTopic(action: "like" | "bookmark") {
    if (!topic) return;
    if (!session?.authenticated) {
      setFeedback("登录后才能点赞或收藏。可从“我的”完成登录。");
      return;
    }
    const active = action === "like" ? topic.liked : topic.bookmarked;
    setBusy(action);
    try {
      const response = await communityRequest<{ like?: { active: boolean; total?: number }; bookmark?: { active: boolean } }>(`/api/community/topics/${topic.id}/${action}`, { method: active ? "DELETE" : "PUT" });
      setTopic((current) => current ? {
        ...current,
        ...(action === "like" ? {
          liked: response.like?.active ?? !active,
          likeCount: response.like?.total ?? Math.max(0, current.likeCount + (active ? -1 : 1)),
        } : { bookmarked: response.bookmark?.active ?? !active }),
      } : current);
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function saveTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!topic) return;
    setBusy("edit-topic");
    try {
      await communityRequest(`/api/community/topics/${topic.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editTitle, body: editBody, visibility: topic.visibility, version: topic.version }),
      });
      setEditingTopic(false);
      await loadPage();
      setFeedback("主题已更新。");
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function deleteTopic() {
    if (!topic || !window.confirm("删除后主题会保留为不可恢复的线程墓碑。确认删除？")) return;
    setBusy("delete-topic");
    try {
      await communityRequest(`/api/community/topics/${topic.id}`, { method: "DELETE", body: JSON.stringify({ version: topic.version }) });
      window.location.assign("/community");
    } catch (error) {
      setFeedback(communityErrorMessage(error));
      setBusy("");
    }
  }

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!replyBody.trim()) return;
    setBusy("reply");
    try {
      await communityRequest(`/api/community/topics/${topicId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: replyBody, replyToCommentId: replyTo?.id ?? null }),
      });
      setReplyBody("");
      setReplyTo(null);
      await loadComments();
      setFeedback("回复已发布。");
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function toggleCommentLike(comment: CommunityComment) {
    if (!session?.authenticated) {
      setFeedback("登录后才能点赞回复。");
      return;
    }
    setBusy(`comment-like:${comment.id}`);
    try {
      const payload = await communityRequest<{ like: { active: boolean; total?: number } }>(`/api/community/comments/${comment.id}/like`, { method: comment.liked ? "DELETE" : "PUT" });
      setComments((current) => current.map((item) => item.id === comment.id ? {
        ...item,
        liked: payload.like.active,
        likeCount: payload.like.total ?? Math.max(0, item.likeCount + (comment.liked ? -1 : 1)),
      } : item));
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function saveComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingComment || !editCommentBody.trim()) return;
    setBusy(`comment-edit:${editingComment.id}`);
    try {
      await communityRequest(`/api/community/comments/${editingComment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: editCommentBody, version: editingComment.version }),
      });
      setEditingComment(null);
      await loadComments();
      setFeedback("回复已更新。");
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function deleteComment(comment: CommunityComment) {
    if (!window.confirm("删除后仍会保留一个线程位置，但正文不再显示。确认删除？")) return;
    setBusy(`comment-delete:${comment.id}`);
    try {
      await communityRequest(`/api/community/comments/${comment.id}`, { method: "DELETE", body: JSON.stringify({ version: comment.version }) });
      await loadComments();
      setFeedback("回复已删除，讨论结构仍被保留。");
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function blockAuthor(authorId: string) {
    if (!window.confirm("屏蔽后，你们将互相看不到对方的社区内容，相关旧互动也会清理。确认屏蔽？")) return;
    setBusy("block");
    try {
      await communityRequest(`/api/community/users/${authorId}/block`, { method: "PUT" });
      window.location.assign("/community");
    } catch (error) {
      setFeedback(communityErrorMessage(error));
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
        setFeedback("暂时无法自动复制。可以从浏览器地址栏复制这条讨论的链接。");
      }
    }
  }

  if (pageState === "loading") {
    return <main className={styles.page}><CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} /><div className={styles.fullState} role="status"><i /><b>正在展开这段讨论</b><p>主题和回复会一起加载。</p></div></main>;
  }

  if (pageState === "missing") {
    return <main className={styles.page}><CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} /><div className={styles.fullState}><b>这段讨论已经不可见</b><p>它可能被作者删除、进入审核，或因屏蔽关系不再向你显示。</p><Link href="/community">返回校园回廊</Link></div></main>;
  }

  if (pageState === "error" || !topic) {
    return <main className={styles.page}><CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} /><div className={styles.fullState} role="alert"><b>讨论暂时没有加载成功</b><p>检查网络后重试，页面不会替你提交任何操作。</p><button onClick={() => void loadPage()}>重新加载</button></div></main>;
  }

  return (
    <main className={styles.page}>
      <CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} />
      <div className={styles.topicCrumb}><Link href="/community">校园回廊</Link><span>/</span><b>{topic.title}</b></div>

      <article className={styles.topicReading}>
        <div className={styles.readingSpine} aria-hidden="true"><i /><span suppressHydrationWarning>{formatCommunityTime(topic.createdAt)}</span></div>
        <header><span>{topic.visibility === "unlisted" ? "仅链接可见" : "公开主题"}</span><h1>{topic.title}</h1><AuthorBadge author={topic.author} /></header>
        <div className={styles.topicBody}>{topic.body}</div>
        <footer>
          <button className={topic.liked ? styles.activeAction : undefined} onClick={() => void toggleTopic("like")} disabled={busy === "like"} aria-pressed={topic.liked}>赞同 {topic.likeCount}</button>
          <button className={topic.bookmarked ? styles.activeAction : undefined} onClick={() => void toggleTopic("bookmark")} disabled={busy === "bookmark"} aria-pressed={topic.bookmarked}>{topic.bookmarked ? "已收藏" : "收藏"}</button>
          <button onClick={() => void shareTopic()}>分享链接</button>
          <span>{topic.commentCount} 条讨论</span>
          {isOwner ? (
            <><button onClick={() => { setEditTitle(topic.title); setEditBody(topic.body); setEditingTopic(true); }}>编辑</button><button onClick={() => void deleteTopic()} disabled={busy === "delete-topic"}>删除</button></>
          ) : session?.authenticated ? (
            <><button onClick={() => setReportTarget({ type: "topic", id: topic.id, label: topic.title })}>举报主题</button>{topic.author && <button onClick={() => void blockAuthor(topic.author!.id)} disabled={busy === "block"}>屏蔽作者</button>}</>
          ) : null}
        </footer>
      </article>

      {editingTopic && (
        <form className={styles.inlineEditor} onSubmit={saveTopic}>
          <header><b>编辑主题</b><button type="button" onClick={() => setEditingTopic(false)}>取消</button></header>
          <FormField label="标题" counter={`${editTitle.length} / 120`} variant="display"><input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} minLength={4} maxLength={120} autoFocus /></FormField>
          <FormField label="正文" counter={`${editBody.length} / 5000`}><textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} maxLength={5000} rows={9} /></FormField>
          <button disabled={busy === "edit-topic" || editTitle.trim().length < 4 || !editBody.trim()}>{busy === "edit-topic" ? "正在保存" : "保存更改"}</button>
        </form>
      )}

      <section className={styles.discussion} id="discussion" aria-labelledby="discussion-title">
        <header><span>讨论线</span><h2 id="discussion-title">回复与补充</h2><p>回复只展开一层。继续回复时，系统会保留你真正回应的人。</p></header>
        <Feedback message={feedback} />

        {session?.authenticated ? (
          <form className={styles.replyComposer} onSubmit={submitReply}>
            <label htmlFor="community-reply">{replyTo ? `回复 ${authorName(replyTo.author)}` : "加入讨论"}</label>
            {replyTo && <button type="button" onClick={() => setReplyTo(null)}>取消指定回复</button>}
            <textarea id="community-reply" value={replyBody} onChange={(event) => setReplyBody(event.target.value)} maxLength={3000} rows={5} placeholder={replyTo ? "写下针对这条回复的内容…" : "说清楚你的经验、问题或补充…"} />
            <div><small>{replyBody.length} / 3000</small><button disabled={busy === "reply" || !replyBody.trim()}>{busy === "reply" ? "正在发布" : "发布回复"}</button></div>
          </form>
        ) : (
          <div className={styles.discussionLogin}><b>登录后加入讨论</b><p>公开主题可以直接阅读，发布和互动需要账号。</p><Link href="/?view=me">去登录</Link></div>
        )}

        {threads.length === 0 && <div className={styles.noComments}><b>还没有回复</b><p>如果你有可靠的信息，可以从这里补上第一段。</p></div>}

        <ol className={styles.commentThreads}>
          {threads.map(({ root, replies }, threadIndex) => (
            <li key={root.id}>
              <CommentEntry
                comment={root}
                mark={`章 ${threadIndex + 1}`}
                session={session}
                busy={busy}
                onReply={setReplyTo}
                onLike={toggleCommentLike}
                onEdit={(comment) => { setEditingComment(comment); setEditCommentBody(comment.body ?? ""); }}
                onDelete={deleteComment}
                onReport={(comment) => setReportTarget({ type: "comment", id: comment.id, label: `回复 ${comment.body?.slice(0, 24) || "已删除内容"}` })}
              />
              {replies.length > 0 && <ol className={styles.replies}>{replies.map((reply) => <li key={reply.id}><CommentEntry comment={reply} mark="回应" session={session} busy={busy} onReply={setReplyTo} onLike={toggleCommentLike} onEdit={(comment) => { setEditingComment(comment); setEditCommentBody(comment.body ?? ""); }} onDelete={deleteComment} onReport={(comment) => setReportTarget({ type: "comment", id: comment.id, label: `回复 ${comment.body?.slice(0, 24) || "已删除内容"}` })} /></li>)}</ol>}
            </li>
          ))}
        </ol>

        {nextCursor && <button className={styles.loadMore} onClick={() => void loadComments(nextCursor, true)}>继续读取更早的讨论</button>}
      </section>

      {editingComment && (
        <DialogBackdrop onDismiss={closeEditComment} dismissDisabled={Boolean(busy)}>
          <form ref={editCommentRef} className={styles.reportSheet} role="dialog" aria-modal="true" aria-labelledby="edit-comment-title" onSubmit={saveComment}>
            <span>修改回复</span><h2 id="edit-comment-title">编辑这条回复</h2>
            <FormField label="回复正文" counter={`${editCommentBody.length} / 3000`}><textarea value={editCommentBody} onChange={(event) => setEditCommentBody(event.target.value)} maxLength={3000} rows={8} autoFocus /></FormField>
            <DialogActions><button type="button" onClick={() => setEditingComment(null)}>取消</button><button disabled={busy === `comment-edit:${editingComment.id}` || !editCommentBody.trim()}>保存更改</button></DialogActions>
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
  mark,
  session,
  busy,
  onReply,
  onLike,
  onEdit,
  onDelete,
  onReport,
}: {
  comment: CommunityComment;
  mark: string;
  session: CommunitySession | null;
  busy: string;
  onReply: (comment: CommunityComment) => void;
  onLike: (comment: CommunityComment) => Promise<void>;
  onEdit: (comment: CommunityComment) => void;
  onDelete: (comment: CommunityComment) => Promise<void>;
  onReport: (comment: CommunityComment) => void;
}) {
  const own = Boolean(comment.author?.id && comment.author.id === session?.user?.id);
  const unavailable = comment.status !== "published" || !comment.body;
  return (
    <article className={unavailable ? styles.commentUnavailable : styles.commentEntry}>
      <div className={styles.commentNode} aria-hidden="true"><i /><span>{mark}</span></div>
      <header><AuthorBadge author={comment.author} /><time suppressHydrationWarning dateTime={comment.createdAt}>{formatCommunityTime(comment.createdAt)}{comment.editedAt ? " · 已编辑" : ""}</time></header>
      <p>{unavailable ? (comment.status === "blocked" ? "这条回复因屏蔽关系不再显示。" : "这条回复已不可见，讨论位置仍被保留。") : comment.body}</p>
      {!unavailable && <footer>
        <button className={comment.liked ? styles.activeAction : undefined} onClick={() => void onLike(comment)} disabled={busy === `comment-like:${comment.id}`} aria-pressed={comment.liked}>赞同 {comment.likeCount}</button>
        {session?.authenticated && <button onClick={() => onReply(comment)}>回复</button>}
        {own ? <><button onClick={() => onEdit(comment)}>编辑</button><button onClick={() => void onDelete(comment)} disabled={busy === `comment-delete:${comment.id}`}>删除</button></> : session?.authenticated ? <button onClick={() => onReport(comment)}>举报</button> : null}
      </footer>}
    </article>
  );
}
