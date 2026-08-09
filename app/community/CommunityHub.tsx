"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { FormField } from "../FormField";
import {
  authorName,
  communityErrorMessage,
  communityRequest,
  formatCommunityTime,
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
import styles from "./community.module.css";

type FeedState = "loading" | "ready" | "error";

export function CommunityHub() {
  const [session, setSession] = useState<CommunitySession | null>(null);
  const [topics, setTopics] = useState<CommunityTopic[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [feedState, setFeedState] = useState<FeedState>("loading");
  const [sessionFailed, setSessionFailed] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"public" | "unlisted">("public");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [unread, setUnread] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<{ type: "topic" | "comment" | "user"; id: string; label: string } | null>(null);
  const [undoBlock, setUndoBlock] = useState<{ id: string; name: string } | null>(null);
  const [dateMark, setDateMark] = useState("");

  const loadTopics = useCallback(async (cursor?: string, append = false) => {
    setFeedState("loading");
    try {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const payload = await communityRequest<{ items: CommunityTopic[]; nextCursor: string | null }>(`/api/community/topics?sort=latest&limit=20${suffix}`);
      setTopics((current) => append ? [...current, ...payload.items] : payload.items);
      setNextCursor(payload.nextCursor);
      setFeedState("ready");
    } catch {
      setFeedState("error");
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const query = new URLSearchParams(window.location.search);
      if (query.get("panel") === "notifications") setNotificationsOpen(true);
      setDateMark(new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date()));
      void Promise.all([
        loadTopics(),
        communityRequest<CommunitySession>("/api/auth/session")
          .then(async (payload) => {
            setSession(payload);
            if (payload.authenticated) {
              const count = await communityRequest<{ unread: number }>("/api/community/notifications/unread-count");
              setUnread(count.unread);
            }
          })
          .catch(() => setSessionFailed(true)),
      ]);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadTopics]);

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

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim().length < 4 || !body.trim()) return;
    setBusy("publish");
    setFeedback("");
    try {
      const payload = await communityRequest<{ topic: { id: string } }>("/api/community/topics", {
        method: "POST",
        body: JSON.stringify({ title, body, visibility }),
      });
      window.location.assign(`/community/topics/${payload.topic.id}`);
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function toggleTopic(topic: CommunityTopic, action: "like" | "bookmark") {
    if (!session?.authenticated) {
      setFeedback("登录后才能点赞或收藏。可从“我的”完成登录。");
      return;
    }
    setBusy(`${action}:${topic.id}`);
    setFeedback("");
    const active = action === "like" ? topic.liked : topic.bookmarked;
    try {
      const response = await communityRequest<{ like?: { active: boolean; total?: number }; bookmark?: { active: boolean } }>(
        `/api/community/topics/${topic.id}/${action}`,
        { method: active ? "DELETE" : "PUT" },
      );
      setTopics((current) => current.map((item) => item.id === topic.id ? {
        ...item,
        ...(action === "like" ? {
          liked: response.like?.active ?? !active,
          likeCount: response.like?.total ?? Math.max(0, item.likeCount + (active ? -1 : 1)),
        } : { bookmarked: response.bookmark?.active ?? !active }),
      } : item));
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function blockAuthor(topic: CommunityTopic) {
    if (!topic.author || !window.confirm(`屏蔽 ${authorName(topic.author)} 后，你们将互相看不到对方的社区内容。确认屏蔽？`)) return;
    setBusy(`block:${topic.author.id}`);
    try {
      await communityRequest(`/api/community/users/${topic.author.id}/block`, { method: "PUT" });
      setTopics((current) => current.filter((item) => item.author?.id !== topic.author?.id));
      setUndoBlock({ id: topic.author.id, name: authorName(topic.author) });
      setFeedback(`已屏蔽 ${authorName(topic.author)}，相关内容已从当前列表移除。`);
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function undoBlockAuthor() {
    if (!undoBlock) return;
    setBusy("undo-block");
    try {
      await communityRequest(`/api/community/users/${undoBlock.id}/block`, { method: "DELETE" });
      setFeedback(`已取消屏蔽 ${undoBlock.name}。`);
      setUndoBlock(null);
      await loadTopics();
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <main className={styles.page}>
      <CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} />

      <section className={styles.feedHero} aria-labelledby="community-title">
        <div className={styles.corridorMark} aria-hidden="true"><i /><span>DUFE / VOICES</span></div>
        <div>
          <span>校园回廊 · {dateMark}</span>
          <h1 id="community-title">
            <span>让有用的话，</span>
            <span>在校园里多走一段。</span>
          </h1>
          <p>课程经验、学习方法和校园生活都可以在这里展开。主题按发布时间排序。</p>
        </div>
        <aside>
          <strong>{topics.length}</strong>
          <span>本次已读到的主题</span>
          <p>公开阅读无需登录；发布、互动与举报需要账号。</p>
        </aside>
      </section>

      <section className={styles.communityWorkspace}>
        <aside className={styles.feedRail}>
          <span>现在</span>
          <i />
          <p>按发布时间从新到旧，继续加载可以查看更早的主题。</p>
          {sessionFailed ? (
            <div className={styles.railNotice}>账号状态暂时无法确认，公开内容仍可阅读。</div>
          ) : session?.authenticated ? (
            <>
              <AuthorBadge author={session.user} />
              <button className={styles.primaryAction} onClick={() => setComposerOpen((value) => !value)}>{composerOpen ? "收起发布区" : "写一条新主题"}</button>
            </>
          ) : (
            <div className={styles.loginPrompt}><b>想加入讨论？</b><p>登录后可以发布、回复、收藏和管理通知。</p><Link href="/?view=me">去登录</Link></div>
          )}
        </aside>

        <div className={styles.feedColumn} id="community-feed">
          {composerOpen && session?.authenticated && (
            <form className={styles.composer} onSubmit={publish}>
              <header><span>发布主题</span><small>纯文本 · 支持 @用户名</small></header>
              <FormField label="标题" counter={`${title.length} / 120`} variant="display"><input value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} maxLength={120} placeholder="用一句话说清楚要讨论什么" /></FormField>
              <FormField label="正文" counter={`${body.length} / 5000`}><textarea value={body} onChange={(event) => setBody(event.target.value)} minLength={1} maxLength={5000} rows={8} placeholder="补充背景、已尝试的方法，或你真正想问的问题。" /></FormField>
              <div className={styles.composerFooter}>
                <FormField label="可见范围" className={styles.visibility}><select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}><option value="public">公开出现在回廊</option><option value="unlisted">仅通过链接访问</option></select></FormField>
                <button disabled={busy === "publish" || title.trim().length < 4 || !body.trim()}>{busy === "publish" ? "正在发布" : "发布主题"}</button>
              </div>
            </form>
          )}

          <Feedback message={feedback} />
          {undoBlock && <div className={styles.undoBar}><span>已屏蔽该用户，其内容将不再显示。</span><button onClick={() => void undoBlockAuthor()} disabled={busy === "undo-block"}>立即撤销</button></div>}

          {feedState === "loading" && topics.length === 0 && <div className={styles.feedState} role="status"><i /><b>正在听回廊里的声音</b><p>主题加载完成后会按时间出现。</p></div>}
          {feedState === "error" && topics.length === 0 && <div className={styles.feedState} role="alert"><b>回廊暂时没有回应</b><p>检查网络后重新连接，已经发布的内容不会被改动。</p><button onClick={() => void loadTopics()}>重新加载</button></div>}
          {feedState === "ready" && topics.length === 0 && <div className={styles.feedState}><b>这里还没有主题</b><p>{session?.authenticated ? "写下第一条真实有用的信息，让讨论从这里开始。" : "登录后可以发布第一条主题。"}</p>{session?.authenticated && <button onClick={() => setComposerOpen(true)}>写第一条</button>}</div>}

          <ol className={styles.topicStream} aria-label="最新主题">
            {topics.map((topic) => (
              <li key={topic.id}>
                <div className={styles.timeSpine} aria-hidden="true"><i /><span suppressHydrationWarning>{formatCommunityTime(topic.createdAt)}</span></div>
                <article className={styles.topicRow}>
                  <header><AuthorBadge author={topic.author} /><span>{topic.visibility === "unlisted" ? "仅链接" : "公开"}{topic.editedAt ? " · 已编辑" : ""}</span></header>
                  <Link href={`/community/topics/${topic.id}`} className={styles.topicLink}>
                    <h2>{topic.title}</h2>
                    <p>{topic.body}</p>
                  </Link>
                  <footer>
                    <button className={topic.liked ? styles.activeAction : undefined} onClick={() => void toggleTopic(topic, "like")} disabled={busy === `like:${topic.id}`} aria-pressed={topic.liked}>赞同 {topic.likeCount}</button>
                    <Link href={`/community/topics/${topic.id}`}>讨论 {topic.commentCount}</Link>
                    <button className={topic.bookmarked ? styles.activeAction : undefined} onClick={() => void toggleTopic(topic, "bookmark")} disabled={busy === `bookmark:${topic.id}`} aria-pressed={topic.bookmarked}>{topic.bookmarked ? "已收藏" : "收藏"}</button>
                    {session?.authenticated && topic.author?.id !== session.user?.id && <button onClick={() => setReportTarget({ type: "topic", id: topic.id, label: topic.title })}>举报</button>}
                    {session?.authenticated && topic.author && topic.author.id !== session.user?.id && <button onClick={() => setReportTarget({ type: "user", id: topic.author!.id, label: authorName(topic.author) })}>举报用户</button>}
                    {session?.authenticated && topic.author && topic.author.id !== session.user?.id && <button onClick={() => void blockAuthor(topic)} disabled={busy === `block:${topic.author.id}`}>屏蔽用户</button>}
                  </footer>
                </article>
              </li>
            ))}
          </ol>

          {nextCursor && <button className={styles.loadMore} onClick={() => void loadTopics(nextCursor, true)} disabled={feedState === "loading"}>{feedState === "loading" ? "正在继续读取" : "继续往前走"}</button>}
          {feedState === "error" && topics.length > 0 && <button className={styles.loadMore} onClick={() => void loadTopics(nextCursor ?? undefined, Boolean(nextCursor))}>这一段没有加载成功，重试</button>}
        </div>
      </section>

      <footer className={styles.communityFooter}><b>东财之影 · 校园回廊</b><p>请尊重同学隐私。课程与校园信息如有变动，以学校官方通知为准。</p><Link href="/terms">社区规则</Link></footer>

      <NotificationsPanel open={notificationsOpen} onClose={closeNotifications} unread={unread} onUnreadChange={setUnread} />
      <ReportDialog target={reportTarget} onClose={closeReport} onReported={setFeedback} />
    </main>
  );
}
