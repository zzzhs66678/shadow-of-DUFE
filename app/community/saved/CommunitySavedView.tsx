"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  authorName,
  communityErrorMessage,
  communityRequest,
  formatCommunityTime,
  type CommunityBlockedUser,
  type CommunitySavedTopic,
  type CommunitySession,
} from "../community-api";
import { CommunityHeader, Feedback, NotificationsPanel } from "../CommunityShared";
import styles from "../community.module.css";

type SavedTab = "bookmarks" | "blocks";
type PageState = "loading" | "ready" | "error" | "anonymous";

export function CommunitySavedView() {
  const [session, setSession] = useState<CommunitySession | null>(null);
  const [tab, setTab] = useState<SavedTab>("bookmarks");
  const [bookmarks, setBookmarks] = useState<CommunitySavedTopic[]>([]);
  const [blocks, setBlocks] = useState<CommunityBlockedUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<PageState>("loading");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [unread, setUnread] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const requestSequence = useRef(0);

  const load = useCallback(async (kind: SavedTab, cursor?: string, append = false) => {
    const requestId = ++requestSequence.current;
    if (!append) setState("loading");
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    try {
      if (kind === "bookmarks") {
        const payload = await communityRequest<{ items: CommunitySavedTopic[]; nextCursor: string | null }>(`/api/community/me/bookmarks?limit=20${suffix}`);
        if (requestId !== requestSequence.current) return;
        setBookmarks((current) => append ? [...current, ...payload.items] : payload.items);
        setNextCursor(payload.nextCursor);
      } else {
        const payload = await communityRequest<{ items: CommunityBlockedUser[]; nextCursor: string | null }>(`/api/community/me/blocks?limit=20${suffix}`);
        if (requestId !== requestSequence.current) return;
        setBlocks((current) => append ? [...current, ...payload.items] : payload.items);
        setNextCursor(payload.nextCursor);
      }
      setState("ready");
    } catch (error) {
      if (requestId !== requestSequence.current) return;
      if ((error as { status?: number }).status === 401) setState("anonymous");
      else setState("error");
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void communityRequest<CommunitySession>("/api/auth/session")
        .then(async (payload) => {
          setSession(payload);
          if (!payload.authenticated) {
            setState("anonymous");
            return;
          }
          void load("bookmarks");
          void communityRequest<{ unread: number }>("/api/community/notifications/unread-count")
            .then((count) => setUnread(count.unread))
            .catch(() => undefined);
        })
        .catch(() => setState("error"));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      requestSequence.current += 1;
    };
  }, [load]);

  function selectTab(nextTab: SavedTab) {
    if (nextTab === tab) return;
    setTab(nextTab);
    setNextCursor(null);
    setFeedback("");
    void load(nextTab);
  }

  async function removeBookmark(item: CommunitySavedTopic) {
    setBusy(`bookmark:${item.topicId}`);
    setFeedback("");
    try {
      await communityRequest(`/api/community/topics/${item.topicId}/bookmark`, { method: "DELETE" });
      setBookmarks((current) => current.filter((candidate) => candidate.topicId !== item.topicId));
      setFeedback("已从收藏中移除。原主题不会受到影响。");
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function unblock(item: CommunityBlockedUser) {
    setBusy(`block:${item.user.id}`);
    setFeedback("");
    try {
      await communityRequest(`/api/community/users/${item.user.id}/block`, { method: "DELETE" });
      setBlocks((current) => current.filter((candidate) => candidate.user.id !== item.user.id));
      setFeedback(`已解除对“${authorName(item.user)}”的屏蔽。之后的新内容会重新出现在回廊中。`);
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  const empty = state === "ready" && (tab === "bookmarks" ? bookmarks.length === 0 : blocks.length === 0);

  return (
    <main className={styles.page}>
      <CommunityHeader session={session} unread={unread} onOpenNotifications={() => setNotificationsOpen(true)} current="saved" />
      <section className={styles.savedHero}>
        <span>PRIVATE INDEX · 只对你可见</span>
        <h1>我的社区存档</h1>
        <p>把想再读的讨论留在这里，也随时检查自己屏蔽过的账号。收藏与屏蔽关系不会公开展示。</p>
      </section>
      <section className={styles.savedWorkspace} id="community-saved" aria-labelledby="saved-title">
        <header>
          <div><span>整理台</span><h2 id="saved-title">留存与边界</h2></div>
          <div className={styles.savedTabs} role="group" aria-label="社区存档分类">
            <button aria-pressed={tab === "bookmarks"} onClick={() => selectTab("bookmarks")}>我的收藏</button>
            <button aria-pressed={tab === "blocks"} onClick={() => selectTab("blocks")}>已屏蔽账号</button>
          </div>
        </header>
        <Feedback message={feedback} />
        {state === "anonymous" && <div className={styles.savedState}><b>登录后才能查看私人存档</b><p>这些记录跟随账号保存在云端，不会混入匿名设备数据。</p><Link href="/?view=me">前往“我的”登录</Link></div>}
        {state === "error" && <div className={styles.savedState} role="alert"><b>存档暂时没有取回</b><p>检查网络后再试一次，现有收藏和屏蔽记录不会丢失。</p><button onClick={() => void load(tab)}>重新读取</button></div>}
        {state === "loading" && <div className={styles.savedState} role="status"><b>正在整理存档…</b></div>}
        {empty && <div className={styles.savedState}><b>{tab === "bookmarks" ? "还没有收藏主题" : "没有已屏蔽账号"}</b><p>{tab === "bookmarks" ? "在主题页点“收藏”，之后就能从这里继续阅读。" : "屏蔽是你控制阅读边界的工具，需要时再使用即可。"}</p><Link href="/community">返回校园回廊</Link></div>}
        {state === "ready" && tab === "bookmarks" && bookmarks.length > 0 && (
          <ol className={styles.savedList}>
            {bookmarks.map((item) => <li key={item.topicId}>
              <time>{formatCommunityTime(item.bookmarkedAt)}</time>
              <div>
                {item.status === "available" ? <Link href={item.publicPath}><h3>{item.title}</h3><p>{item.bodyPreview}</p><small>{authorName(item.author)} · 继续阅读</small></Link> : <div className={styles.savedUnavailable}><h3>这条收藏已不可用</h3><p>内容可能已删除、隐藏，或与当前屏蔽关系冲突。正文与作者信息不再展示。</p></div>}
                <button disabled={busy === `bookmark:${item.topicId}`} onClick={() => void removeBookmark(item)}>{busy === `bookmark:${item.topicId}` ? "正在移除" : "移出收藏"}</button>
              </div>
            </li>)}
          </ol>
        )}
        {state === "ready" && tab === "blocks" && blocks.length > 0 && (
          <ol className={styles.savedList}>
            {blocks.map((item) => <li key={item.user.id}>
              <time>{formatCommunityTime(item.blockedAt)}</time>
              <div><div className={styles.blockedIdentity}><i aria-hidden="true">{authorName(item.user).slice(0, 1)}</i><span><h3>{authorName(item.user)}</h3><small>{item.user.username ? `@${item.user.username}` : "账号"}</small></span></div><p>你不会在回廊、回复和通知中看到这个账号的新内容。</p><button disabled={busy === `block:${item.user.id}`} onClick={() => void unblock(item)}>{busy === `block:${item.user.id}` ? "正在解除" : "解除屏蔽"}</button></div>
            </li>)}
          </ol>
        )}
        {state === "ready" && nextCursor && <button className={styles.loadMore} disabled={busy === "more"} onClick={() => { setBusy("more"); void load(tab, nextCursor, true).finally(() => setBusy("")); }}>{busy === "more" ? "正在读取" : "继续读取"}</button>}
      </section>
      <NotificationsPanel open={notificationsOpen} onClose={() => setNotificationsOpen(false)} unread={unread} onUnreadChange={setUnread} />
    </main>
  );
}
