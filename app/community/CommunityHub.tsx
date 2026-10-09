"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { authorName, communityErrorMessage, communityRequest, formatCommunityTime, type CommunitySession, type CommunityTopic } from "./community-api";
import { AuthorBadge, CommunityHeader, Feedback, NotificationsPanel, ReportDialog } from "./CommunityShared";
import { WallComposer } from "./WallComposer";
import { hasDistinctTitle, PostMenu, shareWallPost, WallIcon } from "./WallPrimitives";
import styles from "./community.module.css";

type FeedState = "loading" | "ready" | "error";
type FeedSort = "latest" | "replied";
const readSort = () => new URLSearchParams(window.location.search).get("sort") === "replied" ? "replied" as const : "latest" as const;

export function CommunityHub() {
  const [session, setSession] = useState<CommunitySession | null>(null);
  const [topics, setTopics] = useState<CommunityTopic[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [feedState, setFeedState] = useState<FeedState>("loading");
  const [sort, setSort] = useState<FeedSort>("latest");
  const [sessionFailed, setSessionFailed] = useState(false);
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [unread, setUnread] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<{ type: "topic" | "comment" | "user"; id: string; label: string } | null>(null);
  const [undoBlock, setUndoBlock] = useState<{ id: string; name: string } | null>(null);
  const requestSequence = useRef(0);
  const sessionIdentity = useRef<string | null>(null);
  const pending = useRef(new Set<string>());

  const loadTopics = useCallback(async function requestTopics(requestedSort: FeedSort, cursor?: string, append = false) {
    const requestId = ++requestSequence.current;
    setFeedState("loading");
    try {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const payload = await communityRequest<{ items: CommunityTopic[]; nextCursor: string | null }>(`/api/community/topics?sort=${requestedSort}&limit=20${suffix}`);
      if (requestId !== requestSequence.current) return;
      setTopics((current) => append ? [...current, ...payload.items.filter((item) => !current.some((old) => old.id === item.id))] : payload.items);
      setNextCursor(payload.nextCursor);
      setFeedState("ready");
    } catch (error) {
      if (requestId !== requestSequence.current) return;
      if (cursor && (error as { code?: string }).code === "community_cursor_stale") {
        setFeedback("帖子有更新，已刷新列表。"); setTopics([]); setNextCursor(null);
        await requestTopics(requestedSort);
      } else setFeedState("error");
    }
  }, []);

  useEffect(() => {
    let active = true;
    let sessionSequence = 0;
    const refreshSession = async () => {
      const sequence = ++sessionSequence;
      try {
        const payload = await communityRequest<CommunitySession>("/api/auth/session");
        if (!active || sequence !== sessionSequence) return;
        const owner = payload.authenticated ? payload.user?.id ?? "anonymous" : "anonymous";
        const changed = sessionIdentity.current !== null && sessionIdentity.current !== owner;
        sessionIdentity.current = owner;
        setSession(payload); setSessionFailed(false); setUnread(0);
        if (changed) {
          setTopics([]); setNextCursor(null); setUndoBlock(null); setReportTarget(null);
          setFeedback(""); setNotificationsOpen(false); pending.current.clear(); setBusy("");
          void loadTopics(readSort());
        }
        if (payload.authenticated) void communityRequest<{ unread: number }>("/api/community/notifications/unread-count").then((count) => {
          if (active && sequence === sessionSequence) setUnread(count.unread);
        }).catch(() => {});
      } catch {
        if (active && sequence === sessionSequence) { setSession(null); setSessionFailed(true); }
      }
    };
    const checkSession = () => { if (document.visibilityState === "visible") void refreshSession(); };
    const readLocation = () => {
      const selected = readSort();
      setSort(selected); setTopics([]); setNextCursor(null);
      setNotificationsOpen(new URLSearchParams(window.location.search).get("panel") === "notifications");
      void loadTopics(selected);
    };
    const frame = requestAnimationFrame(() => {
      readLocation();
      void refreshSession();
    });
    window.addEventListener("popstate", readLocation);
    window.addEventListener("focus", checkSession);
    window.addEventListener("pageshow", checkSession);
    window.addEventListener("storage", checkSession);
    window.addEventListener("dufesh:auth-changed", checkSession);
    document.addEventListener("visibilitychange", checkSession);
    return () => {
      active = false; cancelAnimationFrame(frame); requestSequence.current += 1;
      window.removeEventListener("popstate", readLocation);
      window.removeEventListener("focus", checkSession); window.removeEventListener("pageshow", checkSession);
      window.removeEventListener("storage", checkSession); window.removeEventListener("dufesh:auth-changed", checkSession);
      document.removeEventListener("visibilitychange", checkSession);
    };
  }, [loadTopics]);

  function selectSort(nextSort: FeedSort) {
    if (nextSort === sort && feedState !== "error") return;
    const url = new URL(window.location.href);
    if (nextSort === "replied") url.searchParams.set("sort", nextSort); else url.searchParams.delete("sort");
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    setSort(nextSort); setTopics([]); setNextCursor(null); void loadTopics(nextSort);
  }
  const openNotifications = useCallback(() => {
    const url = new URL(window.location.href); url.searchParams.set("panel", "notifications");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`); setNotificationsOpen(true);
  }, []);
  const closeNotifications = useCallback(() => {
    const url = new URL(window.location.href); url.searchParams.delete("panel");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`); setNotificationsOpen(false);
  }, []);
  const closeReport = useCallback(() => setReportTarget(null), []);

  async function toggleTopic(topic: CommunityTopic, action: "like" | "bookmark") {
    if (!session?.authenticated) { setFeedback("登录后就能点赞和收藏。"); return; }
    const key = `${action}:${topic.id}`;
    if (pending.current.has(key)) return;
    pending.current.add(key); setBusy(key); setFeedback("");
    const active = action === "like" ? topic.liked : topic.bookmarked;
    try {
      const response = await communityRequest<{ like?: { active: boolean; total?: number }; bookmark?: { active: boolean } }>(`/api/community/topics/${topic.id}/${action}`, { method: active ? "DELETE" : "PUT", headers: { "X-Community-Owner": session.user?.id ?? "" } });
      if (sessionIdentity.current !== session.user?.id) return;
      setTopics((current) => current.map((item) => item.id === topic.id ? { ...item,
        ...(action === "like" ? { liked: response.like?.active ?? !active, likeCount: response.like?.total ?? Math.max(0, item.likeCount + (active ? -1 : 1)) } : { bookmarked: response.bookmark?.active ?? !active }),
      } : item));
    } catch (error) { setFeedback(communityErrorMessage(error)); }
    finally { pending.current.delete(key); setBusy(""); }
  }
  async function blockAuthor(topic: CommunityTopic) {
    if (!topic.author || !window.confirm(`屏蔽 ${authorName(topic.author)}？你们将互相看不到对方的内容。`)) return;
    setBusy(`block:${topic.author.id}`);
    try {
      await communityRequest(`/api/community/users/${topic.author.id}/block`, { method: "PUT", headers: { "X-Community-Owner": session?.user?.id ?? "" } });
      if (sessionIdentity.current !== session?.user?.id) return;
      requestSequence.current += 1;
      setTopics((current) => current.filter((item) => item.author?.id !== topic.author?.id));
      setUndoBlock({ id: topic.author.id, name: authorName(topic.author) }); setFeedback("");
      await loadTopics(readSort());
    } catch (error) { setFeedback(communityErrorMessage(error)); }
    finally { setBusy(""); }
  }
  async function undoBlockAuthor() {
    if (!undoBlock) return;
    setBusy("undo-block");
    try {
      await communityRequest(`/api/community/users/${undoBlock.id}/block`, { method: "DELETE", headers: { "X-Community-Owner": session?.user?.id ?? "" } });
      setFeedback(`已取消屏蔽 ${undoBlock.name}。`); setUndoBlock(null); await loadTopics(sort);
    } catch (error) { setFeedback(communityErrorMessage(error)); }
    finally { setBusy(""); }
  }
  async function share(topic: CommunityTopic) {
    try { await shareWallPost(topic.id, topic.title); setFeedback(typeof navigator.share === "function" ? "" : "链接已复制。"); }
    catch (error) { if ((error as Error).name !== "AbortError") setFeedback("暂时无法分享，可以打开帖子后复制地址。"); }
  }

  return <main className={styles.page}>
    <CommunityHeader session={session} unread={unread} onOpenNotifications={openNotifications} />
    <div className={styles.communityWorkspace}>
      <aside className={styles.feedRail} aria-label="东财墙快捷入口">
        <div className={styles.wallSignature} aria-hidden="true">墙<span>DUFE</span></div>
        <nav>
          <Link href="/community" aria-current="page"><WallIcon name="reply" />全部帖子</Link>
          {session?.authenticated && <><Link href="/community/saved"><WallIcon name="bookmark" />我的收藏</Link><Link href={`/community/users/${session.user!.id}`}>我的主页</Link></>}
          <Link href="/?view=me">返回我的</Link>
        </nav>
        {session?.authenticated ? <a href="#wall-body" className={styles.primaryAction} onClick={() => document.getElementById("wall-body")?.focus()}><WallIcon name="write" />写点什么</a> : <Link className={styles.primaryAction} href="/?view=me">登录发帖</Link>}
        <div className={styles.railFooter}><Link href="/terms">社区规则</Link><Link href="/privacy">隐私</Link><span>东财之影</span></div>
      </aside>
      <section className={styles.feedColumn} id="community-feed" aria-labelledby="community-title">
        <header className={styles.wallHeading}><div><span className={styles.wallLabel}>同学之间</span><h1 id="community-title">东财墙</h1></div><button className={styles.refreshFeed} disabled={feedState === "loading"} onClick={() => void loadTopics(sort)}>刷新</button></header>
        {session?.authenticated && session.user ? <WallComposer key={session.user.id} author={session.user} onPublished={(id) => window.location.assign(`/community/topics/${id}?from=latest`)} /> : <div className={styles.guestComposer}><span aria-hidden="true"><WallIcon name="write" /></span><div><b>今天有什么想说的？</b>{sessionFailed && <p>账号状态暂时无法确认，请刷新重试。</p>}</div><Link className={styles.primaryAction} href="/?view=me">登录发帖</Link></div>}
        <nav className={styles.feedSort} aria-label="帖子排序方式"><button aria-pressed={sort === "latest"} onClick={() => selectSort("latest")}>最新发布</button><button aria-pressed={sort === "replied"} onClick={() => selectSort("replied")}>最新回复</button></nav>
        <Feedback message={feedback} />
        {undoBlock && <div className={styles.undoBar}><span>已屏蔽 {undoBlock.name}</span><button onClick={() => void undoBlockAuthor()} disabled={busy === "undo-block"}>撤销</button></div>}
        {feedState === "loading" && topics.length === 0 && <div className={styles.feedState} role="status"><i /><b>正在加载帖子…</b></div>}
        {feedState === "error" && topics.length === 0 && <div className={styles.feedState} role="alert"><b>帖子暂时加载不了</b><button onClick={() => void loadTopics(sort)}>重试</button></div>}
        {feedState === "ready" && topics.length === 0 && <div className={styles.feedState}><WallIcon name="reply" /><b>还没有帖子</b><p>想问的、想分享的，都可以写在这里。</p></div>}
        <ol className={styles.topicStream} aria-label={sort === "latest" ? "最新发布的帖子" : "最新回复的帖子"}>
          {topics.map((topic) => {
            const href = `/community/topics/${topic.id}?from=${sort}`;
            return <li key={topic.id} id={`post-${topic.id}`}><article className={styles.topicRow}>
              <header><AuthorBadge author={topic.author} /><time dateTime={topic.createdAt} suppressHydrationWarning>{formatCommunityTime(topic.createdAt)}</time><PostMenu>
                <Link href={href}>打开帖子</Link>
                {session?.authenticated && topic.author?.id !== session.user?.id && <>
                  <button onClick={() => setReportTarget({ type: "topic", id: topic.id, label: topic.title })}>举报帖子</button>
                  {topic.author && <><button onClick={() => setReportTarget({ type: "user", id: topic.author!.id, label: authorName(topic.author) })}>举报用户</button><button onClick={() => void blockAuthor(topic)} disabled={busy === `block:${topic.author.id}`}>屏蔽用户</button></>}
                </>}
              </PostMenu></header>
              {sort === "replied" && topic.lastReplyAt && <p className={styles.replyActivity}>最近回复 · <time dateTime={topic.lastReplyAt} suppressHydrationWarning>{formatCommunityTime(topic.lastReplyAt)}</time></p>}
              <Link href={href} className={styles.topicLink} aria-label={`查看${authorName(topic.author)}的帖子：${topic.title}`}>
                {hasDistinctTitle(topic) && <h2>{topic.title}</h2>}<p>{topic.body}</p>
                {(topic.body.length > 220 || topic.body.split("\n").length > 6) && <span className={styles.readMore}>展开全文</span>}
              </Link>
              <footer className={styles.postActions}>
                <Link href={`${href}#discussion`} aria-label={`回复 ${topic.commentCount} 条`}><WallIcon name="reply" /><span>{topic.commentCount || "回复"}</span></Link>
                <button aria-label={`${topic.liked ? "取消点赞" : "点赞"} ${topic.likeCount}`} aria-pressed={topic.liked} className={topic.liked ? styles.activeAction : undefined} onClick={() => void toggleTopic(topic, "like")} disabled={busy === `like:${topic.id}`}><WallIcon name="heart" /><span>{topic.likeCount || "赞"}</span></button>
                <button aria-label={topic.bookmarked ? "取消收藏帖子" : "收藏帖子"} aria-pressed={topic.bookmarked} className={topic.bookmarked ? styles.activeAction : undefined} onClick={() => void toggleTopic(topic, "bookmark")} disabled={busy === `bookmark:${topic.id}`}><WallIcon name="bookmark" /><span>{topic.bookmarked ? "已收藏" : "收藏"}</span></button>
                <button aria-label="分享帖子" onClick={() => void share(topic)}><WallIcon name="share" /></button>
              </footer>
            </article></li>;
          })}
        </ol>
        {nextCursor && <button className={styles.loadMore} onClick={() => void loadTopics(sort, nextCursor, true)} disabled={feedState === "loading"}>{feedState === "loading" ? "加载中…" : "更多帖子"}</button>}
        {feedState === "error" && topics.length > 0 && <button className={styles.loadMore} onClick={() => void loadTopics(sort, nextCursor ?? undefined, Boolean(nextCursor))}>加载失败，重试</button>}
        {feedState === "ready" && topics.length > 0 && !nextCursor && <p className={styles.feedEnd}>已经看到这里了</p>}
      </section>
    </div>
    <NotificationsPanel open={notificationsOpen} onClose={closeNotifications} unread={unread} onUnreadChange={setUnread} />
    <ReportDialog target={reportTarget} onClose={closeReport} onReported={setFeedback} />
  </main>;
}
