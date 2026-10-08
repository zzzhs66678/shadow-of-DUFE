"use client";

import { useEffect, useState } from "react";
import { DialogBackdrop } from "../DialogBackdrop";
import { useModalFocus } from "../use-modal-focus";
import styles from "./user-registration.module.css";

type Registration = {
  username: string | null; displayName: string | null; email: string | null;
  emailVerified: boolean; schoolAccount: string | null; schoolAccountVerified: boolean;
  avatarUrl: string | null; registeredVia: string; createdAt: string; lastLoginAt: string | null;
  role: string; status: string;
  profile: null | { entranceYear: number | null; college: string | null; majorId: string | null; className: string | null; updatedAt: string };
};

type Activity = { id: string; title?: string; topicTitle?: string; body: string; publicPath: string; createdAt: string };
type ActivityPage = { items: Activity[]; nextCursor: string | null; profile: { topicCount: number; commentCount: number } };

export function UserRegistration({ userId, elevatedUntil, onClose, onExpired }: {
  userId: string; elevatedUntil: string | null; onClose: () => void; onExpired: () => void;
}) {
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState("");
  const [tab, setTab] = useState("account");
  const [activity, setActivity] = useState<ActivityPage | null>(null);
  const [activityError, setActivityError] = useState("");
  const [activityLoading, setActivityLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const dialogRef = useModalFocus<HTMLElement>(true, onClose);

  useEffect(() => {
    const controller = new AbortController();
    const remaining = elevatedUntil ? new Date(elevatedUntil).getTime() - Date.now() : 0;
    const expire = () => { controller.abort(); setRegistration(null); onExpired(); };
    if (remaining <= 0) { expire(); return; }
    const timer = window.setTimeout(expire, remaining);
    void (async () => {
      try {
        const response = await fetch(`/api/admin/users/${userId}/registration`, {
          method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: "{}",
        });
        if (response.status === 401 || response.status === 403) { expire(); return; }
        if (!response.ok) throw new Error(response.status === 404 ? "账号已不存在。" : "资料暂时无法读取，请关闭后重试。");
        const result = await response.json() as { registration: Registration };
        if (!controller.signal.aborted) setRegistration(result.registration);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "资料暂时无法读取。");
      }
    })();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [userId, elevatedUntil, onExpired]);

  useEffect(() => {
    if (tab === "account") return;
    const controller = new AbortController();
    void (async () => {
      setActivityLoading(true);
      setActivityError("");
      try {
        const query = new URLSearchParams({ kind: tab, limit: "10" });
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`/api/admin/users/${userId}/public-profile?${query}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (response.status === 401 || response.status === 403) { onExpired(); return; }
        if (!response.ok) throw new Error("内容加载失败，请重试。");
        const result = await response.json() as ActivityPage;
        if (!controller.signal.aborted) setActivity(previous => ({ ...result, items: cursor ? [...(previous?.items ?? []), ...result.items] : result.items }));
      } catch (failure) {
        if (!controller.signal.aborted) setActivityError(failure instanceof Error ? failure.message : "内容加载失败。");
      } finally { if (!controller.signal.aborted) setActivityLoading(false); }
    })();
    return () => controller.abort();
  }, [userId, tab, cursor, retry, onExpired]);

  function switchTab(next: string) {
    if (next === tab) return;
    setTab(next); setCursor(null); setActivity(null); setActivityError("");
  }
  const show = (value: string | number | null | undefined) => value ?? "未填写";
  const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-CN") : "暂无记录";
  const sections = registration ? [
    { title: "联系方式", fields: [["邮箱", show(registration.email)], ["邮箱状态", registration.emailVerified ? "已验证" : "未验证"]] },
    { title: "校园资料", fields: [["校园账号", show(registration.schoolAccount)], ["学号状态", registration.schoolAccountVerified ? "已验证" : "未验证"], ["入学年份", show(registration.profile?.entranceYear)], ["学院", show(registration.profile?.college)], ["专业", show(registration.profile?.majorId)], ["班级", show(registration.profile?.className)]] },
    { title: "账号记录", fields: [["注册时间", date(registration.createdAt)], ["最近登录", date(registration.lastLoginAt)], ["资料同步", date(registration.profile?.updatedAt)], ["注册方式", registration.registeredVia === "credential" ? "邮箱注册" : registration.registeredVia === "oauth" ? "第三方登录" : registration.registeredVia]] },
  ] : [];

  return <DialogBackdrop onDismiss={onClose}>
    <section ref={dialogRef} className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="registration-title">
      <header><span>用户资料</span><button type="button" onClick={onClose}>关闭</button></header>
      {error ? <p role="alert">{error}</p> : !registration ? <p role="status">正在读取…</p> : <>
        <div className={styles.identity}>
          <i aria-hidden="true">{registration.avatarUrl?.startsWith("/api/auth/avatars/") ? <img src={registration.avatarUrl} alt="" width={50} height={56} /> : (registration.displayName || registration.username || "?").slice(0, 1)}</i>
          <div><h2 id="registration-title">{registration.displayName || registration.username || "未设置昵称"}</h2><p>@{registration.username || "未设置用户名"}</p></div>
          <span>{registration.status === "active" ? "正常" : "已停用"} · {registration.role === "admin" ? "管理员" : registration.role === "moderator" ? "审核员" : "普通用户"}</span>
        </div>
        <nav className={styles.tabs} aria-label="用户资料分类">
          {[["account", "账号资料"], ["topics", "主题"], ["comments", "回复"]].map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => switchTab(key)}>{label}</button>)}
        </nav>
        {tab === "account" ? <>
          {sections.map(({title,fields}) => <section className={styles.group} key={title}><h3>{title}</h3><dl>{fields.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            {title === "联系方式" && registration.email && <div className={styles.actions}>
              <button type="button" onClick={async () => {
                try { await navigator.clipboard.writeText(registration.email!); setCopyState("邮箱已复制"); }
                catch { setCopyState("请长按邮箱复制。"); }
              }}>复制邮箱</button><a href={`mailto:${encodeURIComponent(registration.email)}`}>用邮件应用联系</a>
            </div>}
            {title === "校园资料" && !registration.profile && <p className={styles.note}>尚未同步校园资料。</p>}
          </section>)}
          <p className={styles.note} role="status">{copyState || "资料访问已记录"}</p>
        </> : <div className={styles.activity}>
          {activity && <p className={styles.note}>{tab === "topics" ? activity.profile.topicCount : activity.profile.commentCount} 条公开{tab === "topics" ? "主题" : "回复"}</p>}
          {activityLoading && <p role="status">正在加载…</p>}
          {activityError && <p role="alert">{activityError}<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
          {!activityLoading && !activityError && activity?.items.length === 0 && <p>暂无公开{tab === "topics" ? "主题" : "回复"}。</p>}
          <ol>{activity?.items.map(item => <li key={item.id}><time dateTime={item.createdAt}>{date(item.createdAt)}</time><a href={item.publicPath} target="_blank" rel="noreferrer">{tab === "topics" ? item.title : `回复于 ${item.topicTitle || "主题"}`} ↗</a><p>{item.body}</p></li>)}</ol>
          {activity?.nextCursor && <button disabled={activityLoading} onClick={() => setCursor(activity.nextCursor)}>加载更多</button>}
        </div>}
      </>}
      {!registration && <h2 id="registration-title" className="sr-only">用户资料</h2>}
    </section>
  </DialogBackdrop>;
}
