"use client";

import Link from "next/link";
import Image from "next/image";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useModalFocus } from "../use-modal-focus";
import {
  authorName,
  communityErrorMessage,
  communityRequest,
  formatCommunityTime,
  reportReasons,
  type CommunityAuthor,
  type CommunityNotification,
  type CommunitySession,
} from "./community-api";
import styles from "./community.module.css";

export function CommunityHeader({
  session,
  unread,
  onOpenNotifications,
}: {
  session: CommunitySession | null;
  unread: number;
  onOpenNotifications: () => void;
}) {
  return (
    <header className={styles.siteHeader}>
      <Link href="/" className={styles.wordmark} aria-label="返回东财之影首页">
        <b>东财之影</b>
        <span>DUFE STUDENT DESK</span>
      </Link>
      <nav aria-label="校园回廊导航">
        <Link href="/community" aria-current="page">回廊</Link>
        <Link href="/materials">资料</Link>
        <Link href="/?view=schedule">课表</Link>
        {session?.authenticated ? (
          <button type="button" onClick={onOpenNotifications}>
            通知{unread > 0 ? <i aria-label={`${unread} 条未读`}>{unread > 99 ? "99+" : unread}</i> : null}
          </button>
        ) : (
          <Link href="/?view=me">登录</Link>
        )}
      </nav>
    </header>
  );
}

export function AuthorBadge({ author }: { author: CommunityAuthor | null }) {
  return (
    <span className={styles.authorBadge}>
      {author?.avatarUrl ? (
        <Image src={author.avatarUrl} alt="" width={34} height={34} unoptimized />
      ) : (
        <i aria-hidden="true">{authorName(author).slice(0, 1)}</i>
      )}
      <span>
        <b>{authorName(author)}</b>
        <small>{author?.username ? `@${author.username}` : "账号已注销"}</small>
      </span>
    </span>
  );
}

export function Feedback({ message }: { message: string }) {
  return message ? <div className={styles.feedback} role="status">{message}</div> : null;
}

export function ReportDialog({
  target,
  onClose,
  onReported,
}: {
  target: { type: "topic" | "comment" | "user"; id: string; label: string } | null;
  onClose: () => void;
  onReported: (message: string) => void;
}) {
  const [reasonCode, setReasonCode] = useState<(typeof reportReasons)[number][0]>("harassment");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closeDialog = useCallback(() => onClose(), [onClose]);
  const dialogRef = useModalFocus<HTMLFormElement>(Boolean(target), closeDialog, busy);

  function resetAndClose() {
    setReasonCode("harassment");
    setDetail("");
    setError("");
    onClose();
  }

  if (!target) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (detail.trim().length > 0 && detail.trim().length < 8) {
      setError("补充说明如需填写，请至少写 8 个字。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload: Record<string, string> = {
        targetType: target.type,
        targetId: target.id,
        reasonCode,
      };
      if (detail.trim()) payload.detail = detail.trim();
      const result = await communityRequest<{ report: { created: boolean } }>(
        "/api/community/reports",
        { method: "POST", body: JSON.stringify(payload) },
      );
      resetAndClose();
      onReported(result.report.created ? "举报已提交，审核记录已经建立。" : "这条举报已经在审核中，没有重复提交。");
    } catch (caught) {
      setError(communityErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) resetAndClose(); }}>
      <form
        ref={dialogRef}
        className={styles.reportSheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="community-report-title"
        onSubmit={submit}
        onKeyDown={(event) => { if (event.key === "Escape" && !busy) resetAndClose(); }}
      >
        <span>社区安全</span>
        <h2 id="community-report-title">举报“{target.label}”</h2>
        <p>举报不会通知对方。审核员会看到你选择的原因和补充说明。</p>
        <label>
          <span>问题类型</span>
          <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as typeof reasonCode)}>
            {reportReasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>补充说明{reasonCode === "other" ? "（至少 8 个字）" : "（可选）"}</span>
          <textarea value={detail} onChange={(event) => setDetail(event.target.value)} maxLength={1000} rows={5} />
        </label>
        {error && <p className={styles.formError} role="alert">{error}</p>}
        <div>
          <button type="button" onClick={resetAndClose} disabled={busy}>取消</button>
          <button disabled={busy || (detail.trim().length > 0 && detail.trim().length < 8) || (reasonCode === "other" && detail.trim().length < 8)}>{busy ? "正在提交" : "提交举报"}</button>
        </div>
      </form>
    </div>
  );
}

function safePath(path: string) {
  return path.startsWith("/") && !path.startsWith("//") ? path : "/community";
}

export function NotificationsPanel({
  open,
  onClose,
  unread,
  onUnreadChange,
}: {
  open: boolean;
  onClose: () => void;
  unread: number;
  onUnreadChange: (count: number) => void;
}) {
  const [items, setItems] = useState<CommunityNotification[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const closePanel = useCallback(() => onClose(), [onClose]);
  const panelRef = useModalFocus<HTMLElement>(open, closePanel);

  const loadNotifications = useCallback(async (cursor?: string, append = false, signal?: AbortSignal) => {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const payload = await communityRequest<{ items: CommunityNotification[]; nextCursor: string | null }>(`/api/community/notifications?limit=30${suffix}`, { signal });
    setItems((current) => append ? [...current, ...payload.items.filter((item) => !current.some((existing) => existing.id === item.id))] : payload.items);
    setNextCursor(payload.nextCursor);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const frame = window.requestAnimationFrame(() => {
      setStatus("loading");
      void loadNotifications(undefined, false, controller.signal)
        .then(() => setStatus("ready"))
        .catch((error: Error) => { if (error.name !== "AbortError") setStatus("error"); });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [loadNotifications, open]);

  if (!open) return null;

  async function refreshUnread() {
    const count = await communityRequest<{ unread: number }>("/api/community/notifications/unread-count");
    onUnreadChange(count.unread);
  }

  async function markAll() {
    setBusy("all");
    try {
      await communityRequest("/api/community/notifications/read-all", { method: "PUT" });
      setItems((current) => current.map((item) => ({ ...item, read: true })));
      onUnreadChange(0);
    } finally {
      setBusy("");
    }
  }

  async function openItem(item: CommunityNotification) {
    if (!item.read) {
      setBusy(item.id);
      try {
        await communityRequest(`/api/community/notifications/${item.id}`, { method: "PUT" });
        onUnreadChange(Math.max(0, unread - 1));
      } catch {
        // Navigation remains useful even if marking read fails.
      }
    }
    window.location.assign(safePath(item.fallbackPath));
  }

  async function dismiss(item: CommunityNotification) {
    setBusy(item.id);
    try {
      await communityRequest(`/api/community/notifications/${item.id}`, { method: "DELETE" });
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      if (!item.read) await refreshUnread();
    } finally {
      setBusy("");
    }
  }

  return (
    <div className={styles.panelBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside ref={panelRef} className={styles.notificationsPanel} role="dialog" aria-modal="true" aria-labelledby="notifications-title">
        <header>
          <div><span>回声</span><h2 id="notifications-title">通知</h2></div>
          <button onClick={onClose} aria-label="关闭通知">×</button>
        </header>
        {status === "loading" && <p className={styles.panelState} role="status">正在取回通知…</p>}
        {status === "error" && <p className={styles.panelState} role="alert">通知暂时没有加载成功。关闭后可以再试一次。</p>}
        {status === "ready" && items.length === 0 && <p className={styles.panelState}>这里还没有新消息。有人回复或提到你时，会出现在这里。</p>}
        {status === "ready" && items.length > 0 && (
          <>
            <button className={styles.readAll} onClick={markAll} disabled={busy === "all"}>全部标为已读</button>
            <ol>
              {items.map((item) => (
                <li key={item.id} data-unread={!item.read}>
                  <button className={styles.notificationMain} onClick={() => void openItem(item)} disabled={busy === item.id}>
                    <span>{item.title}</span>
                    {item.body && <p>{item.body}</p>}
                    <small>{item.actor ? authorName(item.actor) : "系统通知"} · {formatCommunityTime(item.createdAt)}</small>
                  </button>
                  <button className={styles.dismiss} onClick={() => void dismiss(item)} disabled={busy === item.id} aria-label={`隐藏通知：${item.title}`}>隐藏</button>
                </li>
              ))}
            </ol>
            {nextCursor && <button className={styles.panelMore} onClick={() => { setBusy("more"); void loadNotifications(nextCursor, true).then(() => setBusy(""), () => { setBusy(""); setStatus("error"); }); }} disabled={busy === "more"}>{busy === "more" ? "正在加载" : "继续读取通知"}</button>}
          </>
        )}
      </aside>
    </div>
  );
}
