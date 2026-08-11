"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { DialogActions, DialogBackdrop } from "../DialogBackdrop";
import { FormField } from "../FormField";
import { useModalFocus } from "../use-modal-focus";
import styles from "./admin.module.css";

type CandidateStatus = "pending" | "approved" | "rejected" | "rolled_back";
type Decision = "approve" | "reject";

type TeacherReviewCandidate = {
  id: string;
  teacher: { id: string; displayName: string; collegeName: string };
  body: string;
  riskFlags: string[];
  status: CandidateStatus;
  moderationReason: string | null;
  moderatedAt: string | null;
  publicReviewId: string | null;
  createdAt: string;
};

type CandidateCursor = { createdAt: string; id: string };
type ApiError = Error & { status?: number; code?: string };

const statusLabels: Record<CandidateStatus, string> = {
  pending: "待审核",
  approved: "已公开",
  rejected: "已拒绝",
  rolled_back: "已回滚",
};

const riskLabels: Record<string, string> = {
  attack: "可能含攻击表达",
  contact: "曾含联系方式",
  other_teacher: "可能涉及其他教师",
  time_sensitive: "含时效性陈述",
};

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: init?.body
      ? { "Content-Type": "application/json", Accept: "application/json", ...init.headers }
      : { Accept: "application/json", ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    const error = new Error(payload.error || "request_failed") as ApiError;
    error.status = response.status;
    error.code = payload.error;
    throw error;
  }
  return payload;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function errorMessage(error: unknown) {
  switch ((error as ApiError).code) {
    case "admin_mfa_required":
      return "本次值守凭证已失效，请重新验证后继续。";
    case "teacher_review_candidate_conflict":
      return "这条候选已经被其他值守人员处理，队列已刷新。";
    case "teacher_review_candidate_not_found":
      return "这条候选已不存在或已回滚，队列已刷新。";
    case "teacher_review_moderation_rate_limited":
      return "审核操作过于频繁，请一分钟后再继续。";
    default:
      return "教师评价队列没有完成操作，请检查网络后重试。";
  }
}

export function TeacherReviewDesk({
  onMfaExpired,
  onAuditChanged,
}: {
  onMfaExpired: () => void;
  onAuditChanged: () => Promise<void>;
}) {
  const [queueStatus, setQueueStatus] = useState<CandidateStatus>("pending");
  const [candidates, setCandidates] = useState<TeacherReviewCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<CandidateCursor | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selected, setSelected] = useState<TeacherReviewCandidate | null>(null);
  const [decision, setDecision] = useState<Decision>("approve");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const closeSelected = useCallback(() => setSelected(null), []);
  const dialogRef = useModalFocus<HTMLFormElement>(Boolean(selected), closeSelected, busy);

  const loadQueue = useCallback(async (nextStatus: CandidateStatus, append = false, cursor: CandidateCursor | null = null) => {
    setStatus("loading");
    try {
      const params = new URLSearchParams({ status: nextStatus, limit: "20" });
      if (cursor) {
        params.set("afterCreatedAt", cursor.createdAt);
        params.set("afterId", cursor.id);
      }
      const payload = await adminRequest<{
        candidates: TeacherReviewCandidate[];
        nextCursor: CandidateCursor | null;
      }>(`/api/admin/teacher-reviews/candidates?${params}`);
      setCandidates((current) => append ? [...current, ...payload.candidates] : payload.candidates);
      setNextCursor(payload.nextCursor);
      setStatus("ready");
      return payload.candidates;
    } catch (error) {
      if ((error as ApiError).code === "admin_mfa_required") onMfaExpired();
      setStatus("error");
      return null;
    }
  }, [onMfaExpired]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setFeedback("");
      void loadQueue(queueStatus);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadQueue, queueStatus]);

  function openCandidate(candidate: TeacherReviewCandidate) {
    setSelected(candidate);
    setDecision("approve");
    setReason("");
    setFeedback("");
  }

  async function moderate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || selected.status !== "pending" || reason.normalize("NFKC").trim().length < 8) return;
    setBusy(true);
    setFeedback("");
    try {
      await adminRequest(`/api/admin/teacher-reviews/candidates/${selected.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision, reason: reason.normalize("NFKC").trim() }),
      });
      setSelected(null);
      const refreshFailures: string[] = [];
      if (await loadQueue("pending") === null) refreshFailures.push("候选队列");
      try {
        await onAuditChanged();
      } catch {
        refreshFailures.push("审计列表");
      }
      setFeedback(refreshFailures.length
        ? `${decision === "approve" ? "评价已公开" : "候选已拒绝"}，但${refreshFailures.join("和")}刷新失败；请勿重复操作。`
        : decision === "approve"
          ? "历史评价已作为“历史整理内容”公开，并写入审计。"
          : "候选已拒绝且不会公开，决定已写入审计。");
    } catch (error) {
      setFeedback(errorMessage(error));
      if ((error as ApiError).code === "admin_mfa_required") {
        setSelected(null);
        onMfaExpired();
      } else if (["teacher_review_candidate_conflict", "teacher_review_candidate_not_found"].includes((error as ApiError).code ?? "")) {
        setSelected(null);
        await loadQueue("pending");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.moderationDesk} aria-labelledby="teacher-review-desk-title">
      <header>
        <div>
          <span>历史评价</span>
          <h2 id="teacher-review-desk-title">教师评价复核</h2>
          <p>候选正文已经过自动脱敏，但只有人工核对后才能公开；决定不可覆盖，并会进入管理员审计。</p>
        </div>
        <nav className={styles.teacherReviewTabs} aria-label="教师评价候选状态">
          {(Object.keys(statusLabels) as CandidateStatus[]).map((item) => (
            <button key={item} aria-pressed={queueStatus === item} onClick={() => setQueueStatus(item)}>{statusLabels[item]}</button>
          ))}
        </nav>
      </header>

      {feedback && <p className={styles.moderationFeedback} role="status">{feedback}</p>}
      {status === "loading" && <p className={styles.moderationState} role="status">正在读取教师评价候选…</p>}
      {status === "error" && <p className={styles.moderationState} role="alert">教师评价候选没有加载成功。其他值守功能不受影响。<button onClick={() => void loadQueue(queueStatus)}>重试</button></p>}
      {status === "ready" && candidates.length === 0 && <p className={styles.moderationState}>当前没有{statusLabels[queueStatus]}的候选。</p>}
      {status === "ready" && candidates.length > 0 && (
        <ol className={styles.reportQueue}>
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <button onClick={() => openCandidate(candidate)}>
                <span data-status={candidate.status}>{statusLabels[candidate.status]}</span>
                <b>{candidate.teacher.displayName}</b>
                <p>{candidate.body}</p>
                <small>{candidate.teacher.collegeName} · {candidate.riskFlags.length ? candidate.riskFlags.map((flag) => riskLabels[flag] || flag).join(" / ") : "未标记风险"} · {formatDate(candidate.createdAt)}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
      {status === "ready" && nextCursor && (
        <button className={styles.queueMore} onClick={() => void loadQueue(queueStatus, true, nextCursor)}>继续读取</button>
      )}

      {selected && (
        <DialogBackdrop onDismiss={closeSelected} dismissDisabled={busy} priority="critical">
          <form ref={dialogRef} className={styles.caseSheet} role="dialog" aria-modal="true" aria-labelledby="teacher-review-candidate-title" onSubmit={moderate}>
            <header>
              <div><span>{statusLabels[selected.status]}</span><h2 id="teacher-review-candidate-title">{selected.teacher.displayName}</h2></div>
              <button type="button" onClick={closeSelected} disabled={busy} aria-label="关闭教师评价候选">×</button>
            </header>
            <dl>
              <div><dt>学院</dt><dd>{selected.teacher.collegeName}</dd></div>
              <div><dt>教师 ID</dt><dd>{selected.teacher.id.slice(0, 8)}…</dd></div>
              <div><dt>进入队列</dt><dd>{formatDate(selected.createdAt)}</dd></div>
              <div><dt>风险标记</dt><dd>{selected.riskFlags.length ? selected.riskFlags.map((flag) => riskLabels[flag] || flag).join(" / ") : "无"}</dd></div>
            </dl>
            <blockquote>{selected.body}</blockquote>
            {selected.status === "pending" ? (
              <>
                <FormField label="审核决定" className={styles.caseField}>
                  <select value={decision} onChange={(event) => setDecision(event.target.value as Decision)}>
                    <option value="approve">核对无误，公开为历史整理内容</option>
                    <option value="reject">不公开这条候选</option>
                  </select>
                </FormField>
                <FormField label="决定依据（至少 8 个字）" counter={`${reason.normalize("NFKC").trim().length}/1000`} className={styles.caseField}>
                  <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={4} />
                </FormField>
              </>
            ) : (
              <p className={styles.reportDetail}><b>已记录的决定依据</b>{selected.moderationReason || "未提供"}<br />处理时间：{formatDate(selected.moderatedAt)}</p>
            )}
            <DialogActions>
              <button type="button" onClick={closeSelected} disabled={busy}>关闭</button>
              {selected.status === "pending" && <button disabled={busy || reason.normalize("NFKC").trim().length < 8}>{busy ? "正在写入审计" : decision === "approve" ? "确认公开" : "确认拒绝"}</button>}
            </DialogActions>
          </form>
        </DialogBackdrop>
      )}
    </section>
  );
}
