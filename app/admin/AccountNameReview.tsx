"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { DialogActions, DialogBackdrop } from "../DialogBackdrop";
import { FormField } from "../FormField";
import { useModalFocus } from "../use-modal-focus";
import styles from "./admin.module.css";

type NameChangeRequest = {
  id: string;
  userId: string;
  username: string | null;
  displayName: string | null;
  requestedUsername: string | null;
  requestedDisplayName: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
  reviewedAt: string | null;
};
type Decision = "approve" | "reject";
type ApiError = Error & { status?: number; code?: string };

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    const error = new Error("name_change_request_failed") as ApiError;
    error.status = response.status;
    error.code = payload.error;
    throw error;
  }
  return payload;
}

function errorMessage(error: unknown) {
  switch ((error as ApiError).code) {
    case "admin_mfa_required": return "请重新验证管理员身份后再审核。";
    case "name_taken":
    case "name_conflict": return "申请的名字已被使用，请拒绝申请或请用户重新提交。";
    case "name_change_conflict": return "这条申请已发生变化，队列已刷新，请重新核对。";
    case "name_change_not_found": return "这条申请已不存在，队列已刷新。";
    case "invalid_name_change_review": return "请选择审核决定；拒绝时需填写 1–500 个字符的原因。";
    case "name_change_rate_limited":
    case "admin_rate_limited": return "审核请求过于频繁，请稍后再试。";
    default: return "改名申请暂时无法处理，请检查网络后重试。";
  }
}

function statusLabel(status: string) {
  return ({ pending: "待审核", approved: "已批准", rejected: "已拒绝", cancelled: "已取消", superseded: "已失效", expired: "已过期" } as Record<string, string>)[status] ?? "已处理";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function AccountNameReview({ onMfaExpired, onReviewed }: {
  onMfaExpired: () => void;
  onReviewed: () => Promise<void>;
}) {
  const [requests, setRequests] = useState<NameChangeRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<NameChangeRequest | null>(null);
  const [decision, setDecision] = useState<Decision>("approve");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const queueGeneration = useRef(0);
  const operationGeneration = useRef(0);
  const queueController = useRef<AbortController | null>(null);
  const reviewInFlight = useRef(false);
  const closeSelected = useCallback(() => { setSelected(null); setReason(""); setFeedback(""); }, []);
  const dialogRef = useModalFocus<HTMLFormElement>(Boolean(selected), closeSelected, busy);

  const loadQueue = useCallback(async (append = false, cursor: string | null = null) => {
    const generation = ++queueGeneration.current;
    queueController.current?.abort();
    const controller = new AbortController();
    queueController.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const payload = await requestJson<{ requests: NameChangeRequest[]; nextCursor: string | null }>(`/api/admin/name-changes?${params}`, { signal: controller.signal });
      if (generation !== queueGeneration.current || controller.signal.aborted) return false;
      setRequests((current) => append ? [...current, ...payload.requests.filter((item) => !current.some((existing) => existing.id === item.id))] : payload.requests);
      setNextCursor(payload.nextCursor);
      return true;
    } catch (error) {
      if (generation !== queueGeneration.current || controller.signal.aborted) return false;
      setLoadError(errorMessage(error));
      if ((error as ApiError).code === "admin_mfa_required") onMfaExpired();
      return false;
    } finally {
      if (generation === queueGeneration.current && !controller.signal.aborted) setLoading(false);
    }
  }, [onMfaExpired]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void loadQueue(); });
    return () => {
      window.cancelAnimationFrame(frame);
      queueGeneration.current += 1;
      operationGeneration.current += 1;
      queueController.current?.abort();
    };
  }, [loadQueue]);

  function openRequest(item: NameChangeRequest) {
    setSelected(item);
    setDecision("approve");
    setReason("");
    setFeedback("");
  }

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || selected.status !== "pending" || reviewInFlight.current) return;
    const reviewReason = reason.trim();
    const reasonLength = Array.from(reviewReason).length;
    if (reasonLength > 500 || (decision === "reject" && reasonLength === 0)) return;
    const generation = ++operationGeneration.current;
    reviewInFlight.current = true;
    setBusy(true);
    setFeedback("");
    try {
      await requestJson<{ request: NameChangeRequest }>(`/api/admin/name-changes/${encodeURIComponent(selected.id)}/review`, {
        method: "POST",
        body: JSON.stringify({ decision, ...(reviewReason ? { reason: reviewReason } : {}) }),
      });
      if (generation !== operationGeneration.current) return;
      setSelected(null);
      setReason("");
      const refreshed = await loadQueue();
      if (generation !== operationGeneration.current) return;
      let dashboardRefreshed = true;
      try { await onReviewed(); } catch { dashboardRefreshed = false; }
      if (generation !== operationGeneration.current) return;
      const result = decision === "approve" ? "改名已批准。" : "申请已拒绝，用户原名字保留。";
      setFeedback(refreshed && dashboardRefreshed ? result : `${result}列表刷新失败，请刷新查看；无需重复审核。`);
    } catch (error) {
      if (generation !== operationGeneration.current) return;
      setFeedback(errorMessage(error));
      if ((error as ApiError).code === "admin_mfa_required") {
        setSelected(null);
        onMfaExpired();
      } else if (["name_change_conflict", "name_change_not_found"].includes((error as ApiError).code ?? "")) {
        setSelected(null);
        await loadQueue();
      }
    } finally {
      reviewInFlight.current = false;
      if (generation === operationGeneration.current) setBusy(false);
    }
  }

  const reasonLength = Array.from(reason.trim()).length;
  return <section className={styles.moderationDesk} aria-labelledby="account-name-review-title">
    <header>
      <div><h2 id="account-name-review-title">改名申请</h2><p>核对当前名字与申请内容，再批准或拒绝。</p></div>
      <nav aria-label="改名队列操作"><button type="button" disabled={busy} onClick={() => { void loadQueue(); }}>刷新申请</button></nav>
    </header>
    {feedback && !selected && <p className={styles.moderationFeedback} role="status">{feedback}</p>}
    {loadError && <p className={styles.moderationFeedback} role="alert">{loadError}</p>}
    {loading && <p className={styles.moderationState} role="status">正在读取改名申请…</p>}
    {!loading && !loadError && requests.length === 0 && <p className={styles.empty}>暂无改名申请。</p>}
    <ol className={styles.reportQueue}>
      {requests.map((item) => <li key={item.id}>
        <button type="button" disabled={busy} aria-label={`审核改名申请：${item.displayName || item.username || item.userId.slice(0, 8)}`} onClick={() => openRequest(item)}>
          <span>{statusLabel(item.status)}</span>
          <b>{item.displayName || item.username || "未设置昵称"} → {item.requestedDisplayName ?? item.displayName ?? "未设置昵称"}</b>
          <p>@{item.username || "未设置用户名"} → @{item.requestedUsername ?? item.username ?? "未设置用户名"}</p>
          <small>用户 {item.userId.slice(0, 8)}… · 申请于 {formatDate(item.createdAt)}</small>
        </button>
      </li>)}
    </ol>
    {nextCursor && <button className={styles.queueMore} disabled={loading || busy} onClick={() => { void loadQueue(true, nextCursor); }}>加载更多改名申请</button>}
    {selected && <DialogBackdrop onDismiss={closeSelected} dismissDisabled={busy}>
      <form ref={dialogRef} className={`${styles.actionSheet} ${styles.caseSheet}`} role="dialog" aria-modal="true" aria-labelledby="name-change-review-title" onSubmit={review}>
        <span>改名审核 · {statusLabel(selected.status)}</span>
        <h2 id="name-change-review-title">审核改名申请</h2>
        <dl>
          <div><dt>当前用户名</dt><dd>@{selected.username || "未设置"}</dd></div>
          <div><dt>申请用户名</dt><dd>@{selected.requestedUsername ?? selected.username ?? "未设置"}</dd></div>
          <div><dt>当前昵称</dt><dd>{selected.displayName || "未设置"}</dd></div>
          <div><dt>申请昵称</dt><dd>{selected.requestedDisplayName ?? selected.displayName ?? "未设置"}</dd></div>
        </dl>
        {selected.status === "pending" ? <>
          <FormField label="审核决定" className={styles.caseField}><select value={decision} disabled={busy} onChange={(event) => setDecision(event.target.value as Decision)}><option value="approve">批准改名</option><option value="reject">拒绝申请</option></select></FormField>
          <p>{decision === "approve" ? "确认后按申请更新名字，账号与个人数据保留。" : "确认后拒绝这条申请，用户原名字保留。"}</p>
          <FormField label={decision === "reject" ? "拒绝原因" : "审核备注（选填）"} hint="最多 500 个字符" className={styles.caseField} counter={`${Array.from(reason).length}/500`}><textarea required={decision === "reject"} disabled={busy} maxLength={1000} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></FormField>
        </> : <p>{selected.reason || "这条申请已处理，不能重复审核。"}</p>}
        {feedback && <p className={styles.caseFeedback} role="alert">{feedback}</p>}
        <DialogActions><button type="button" disabled={busy} onClick={closeSelected}>取消</button>{selected.status === "pending" && <button disabled={busy || reasonLength > 500 || (decision === "reject" && reasonLength === 0)}>{busy ? "正在审核" : decision === "approve" ? "确认批准" : "确认拒绝"}</button>}</DialogActions>
      </form>
    </DialogBackdrop>}
  </section>;
}
