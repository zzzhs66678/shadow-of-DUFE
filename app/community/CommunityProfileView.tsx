"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  authorName,
  communityRequest,
  formatCommunityTime,
  type CommunityApiError,
  type CommunityProfileComment,
  type CommunityPublicProfile,
  type CommunitySession,
  type CommunityTopic,
} from "./community-api";
import { AuthorBadge, CommunityHeader } from "./CommunityShared";
import styles from "./community.module.css";

type ProfileKind = "topics" | "comments";
type ProfileState = "loading" | "ready" | "missing" | "error";

function joinedLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "加入时间未知";
  return `${new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
  }).format(date)}加入`;
}

export function CommunityProfileView({ userId }: { userId: string }) {
  const [session, setSession] = useState<CommunitySession | null>(null);
  const [unread, setUnread] = useState(0);
  const [profile, setProfile] = useState<CommunityPublicProfile | null>(null);
  const [kind, setKind] = useState<ProfileKind>("topics");
  const [items, setItems] = useState<(CommunityTopic | CommunityProfileComment)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<ProfileState>("loading");
  const requestSequence = useRef(0);

  const load = useCallback(async (
    requestedKind: ProfileKind,
    cursor?: string,
    append = false,
  ) => {
    const requestId = ++requestSequence.current;
    setState("loading");
    try {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const payload = await communityRequest<{
        profile: CommunityPublicProfile;
        kind: ProfileKind;
        items: (CommunityTopic | CommunityProfileComment)[];
        nextCursor: string | null;
      }>(`/api/community/users/${userId}?kind=${requestedKind}&limit=20${suffix}`);
      if (requestId !== requestSequence.current) return;
      setProfile(payload.profile);
      setKind(payload.kind);
      setItems((current) => append ? [...current, ...payload.items] : payload.items);
      setNextCursor(payload.nextCursor);
      setState("ready");
    } catch (error) {
      if (requestId !== requestSequence.current) return;
      if ((error as CommunityApiError).status === 404) {
        setProfile(null);
        setItems([]);
        setNextCursor(null);
        setState("missing");
        return;
      }
      setState("error");
    }
  }, [userId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void load("topics");
      void communityRequest<CommunitySession>("/api/auth/session")
        .then(async (payload) => {
          setSession(payload);
          if (payload.authenticated) {
            const count = await communityRequest<{ unread: number }>(
              "/api/community/notifications/unread-count",
            );
            setUnread(count.unread);
          }
        })
        .catch(() => setSession({ authenticated: false, user: null }));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      requestSequence.current += 1;
    };
  }, [load]);

  function selectKind(nextKind: ProfileKind) {
    if (nextKind === kind && state !== "error") return;
    setItems([]);
    setNextCursor(null);
    void load(nextKind);
  }

  return (
    <main className={styles.page}>
      <CommunityHeader
        session={session}
        unread={unread}
        onOpenNotifications={() => window.location.assign("/community?panel=notifications")}
      />

      {profile ? (
        <>
          <section className={styles.profileHero} aria-labelledby="profile-title">
            <span>COMMUNITY / PUBLIC RECORD</span>
            <AuthorBadge author={profile} />
            <h1 id="profile-title">{authorName(profile)}</h1>
            <p>{profile.username ? `@${profile.username}` : "站内用户"} · {joinedLabel(profile.joinedAt)}</p>
            <dl>
              <div><dt>公开主题</dt><dd>{profile.topicCount}</dd></div>
              <div><dt>公开回复</dt><dd>{profile.commentCount}</dd></div>
            </dl>
          </section>

          <section className={styles.profileWorkspace} id="public-records">
            <header>
              <div>
                <span>公开记录</span>
                <h2>{kind === "topics" ? "主题" : "回复"}</h2>
              </div>
              <div className={styles.profileTabs} role="group" aria-label="公开内容类型">
                <button type="button" aria-pressed={kind === "topics"} onClick={() => selectKind("topics")}>主题 {profile.topicCount}</button>
                <button type="button" aria-pressed={kind === "comments"} onClick={() => selectKind("comments")}>回复 {profile.commentCount}</button>
              </div>
            </header>

            {state === "loading" && items.length === 0 && <div className={styles.feedState} role="status"><i /><b>正在整理公开记录</b></div>}
            {state === "error" && items.length === 0 && <div className={styles.feedState} role="alert"><b>公开记录暂时没有载入</b><p>检查网络后可以重新读取。</p><button onClick={() => void load(kind)}>重新加载</button></div>}
            {state === "ready" && items.length === 0 && <div className={styles.feedState}><b>这里还没有公开{kind === "topics" ? "主题" : "回复"}</b><p>未公开、已删除或仅链接可见的内容不会出现在个人主页。</p></div>}

            <ol className={styles.profileRecords} aria-label={`公开${kind === "topics" ? "主题" : "回复"}`}>
              {items.map((item) => kind === "topics" ? (
                <li key={item.id}>
                  <time dateTime={item.createdAt} suppressHydrationWarning>{formatCommunityTime(item.createdAt)}</time>
                  <Link href={`/community/topics/${item.id}`}>
                    <h3>{(item as CommunityTopic).title}</h3>
                    <p>{(item as CommunityTopic).body}</p>
                    <small>赞同 {(item as CommunityTopic).likeCount} · 讨论 {(item as CommunityTopic).commentCount}</small>
                  </Link>
                </li>
              ) : (
                <li key={item.id}>
                  <time dateTime={item.createdAt} suppressHydrationWarning>{formatCommunityTime(item.createdAt)}</time>
                  <Link href={`/community/topics/${(item as CommunityProfileComment).topicId}`}>
                    <small>回复于《{(item as CommunityProfileComment).topicTitle}》</small>
                    <p>{(item as CommunityProfileComment).body}</p>
                    <b>赞同 {(item as CommunityProfileComment).likeCount}</b>
                  </Link>
                </li>
              ))}
            </ol>

            {nextCursor && <button className={styles.loadMore} onClick={() => void load(kind, nextCursor, true)} disabled={state === "loading"}>{state === "loading" ? "正在加载" : "继续查看"}</button>}
          </section>
        </>
      ) : state === "missing" ? (
        <section className={styles.fullState}><b>这份公开档案不可用</b><p>账号已停用、注销，或你们之间存在屏蔽关系。私人资料不会在这里显示。</p><Link href="/community">返回校园回廊</Link></section>
      ) : state === "error" ? (
        <section className={styles.fullState}><b>公开档案暂时没有载入</b><p>检查网络后可以重新读取。</p><button onClick={() => void load(kind)}>重新加载</button></section>
      ) : (
        <section className={styles.fullState} role="status"><i /><b>正在打开公开档案</b></section>
      )}
    </main>
  );
}
