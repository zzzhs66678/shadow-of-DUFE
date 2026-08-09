"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { DialogBackdrop } from "../DialogBackdrop";
import { useModalFocus } from "../use-modal-focus";
import styles from "./admin.module.css";

type ModerationAction = "hide" | "restore" | "delete" | "warn" | "suspend" | "ban" | "unban" | "dismiss";

type CommunityReport = {
  id: string;
  targetType: "topic" | "comment" | "user";
  targetId: string;
  targetLabel: string | null;
  targetStatus: string | null;
  activeSanctionType: string | null;
  allowedActions: ModerationAction[];
  reporterUsername: string | null;
  reasonCode: string;
  detail: string | null;
  status: "open" | "reviewing";
  caseId: string | null;
  caseStatus: string | null;
  evidenceTitle: string | null;
  evidenceBody: string | null;
  evidenceAuthorLabel: string | null;
  evidenceCapturedAt: string;
  createdAt: string;
  updatedAt: string;
};

type ApiError = Error & { status?: number; code?: string };

const reasonLabels: Record<string, string> = {
  harassment: "骚扰或人身攻击",
  privacy: "泄露隐私",
  spam: "广告或刷屏",
  misinformation: "明显误导",
  illegal: "违法违规",
  self_harm: "自伤风险",
  other: "其他",
};

const actionLabels: Record<ModerationAction, string> = {
  hide: "隐藏内容，继续审核",
  restore: "恢复内容并结案",
  delete: "删除内容并结案",
  warn: "警告并结案",
  suspend: "限时停发，继续审核",
  ban: "封禁，继续审核",
  unban: "解除制裁并结案",
  dismiss: "驳回举报并结案",
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

function moderationError(error: unknown) {
  switch ((error as ApiError).code) {
    case "admin_mfa_required": return "本次值守凭证已失效，请重新验证后继续。";
    case "community_moderation_state_conflict": return "目标状态刚刚发生变化，队列已刷新。";
    case "community_report_not_found": return "举报已被其他值守人员处理，队列已刷新。";
    case "community_case_not_found": return "案件已经结案或不可用，队列已刷新。";
    case "invalid_community_moderation_action": return "该动作不适用于当前目标，请重新选择。";
    default: return "治理请求没有完成。检查网络后重试。";
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function ModerationDesk({
  onMfaExpired,
  onAuditChanged,
}: {
  onMfaExpired: () => void;
  onAuditChanged: () => Promise<void>;
}) {
  const [queueStatus, setQueueStatus] = useState<"open" | "reviewing">("open");
  const [reports, setReports] = useState<CommunityReport[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selected, setSelected] = useState<CommunityReport | null>(null);
  const [caseReason, setCaseReason] = useState("");
  const [action, setAction] = useState<ModerationAction>("warn");
  const [actionReason, setActionReason] = useState("");
  const [durationHours, setDurationHours] = useState("24");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const closeSelected = useCallback(() => setSelected(null), []);
  const caseRef = useModalFocus<HTMLFormElement>(Boolean(selected), closeSelected, Boolean(busy));

  const loadQueue = useCallback(async (nextStatus: "open" | "reviewing") => {
    setStatus("loading");
    try {
      const payload = await adminRequest<{ reports: CommunityReport[] }>(`/api/admin/community/reports?status=${nextStatus}`);
      setReports(payload.reports);
      setStatus("ready");
      return payload.reports;
    } catch (error) {
      if ((error as ApiError).code === "admin_mfa_required") onMfaExpired();
      setStatus("error");
      return null;
    }
  }, [onMfaExpired]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void loadQueue(queueStatus); });
    return () => window.cancelAnimationFrame(frame);
  }, [loadQueue, queueStatus]);

  function chooseReport(report: CommunityReport) {
    setSelected(report);
    setCaseReason("");
    setAction(report.allowedActions[0] ?? "warn");
    setActionReason("");
    setDurationHours("24");
    setFeedback("");
  }

  async function openCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || caseReason.trim().length < 8) return;
    setBusy("case");
    try {
      const payload = await adminRequest<{ case: { id: string } }>(`/api/admin/community/reports/${selected.id}/case`, {
        method: "POST",
        body: JSON.stringify({ reason: caseReason.trim() }),
      });
      setQueueStatus("reviewing");
      const reviewing = await loadQueue("reviewing");
      const updated = reviewing?.find((report) => report.id === selected.id);
      setSelected(updated ?? { ...selected, status: "reviewing", caseId: payload.case.id, caseStatus: "reviewing" });
      setAction(updated?.allowedActions[0] ?? selected.allowedActions[0] ?? "warn");
      const refreshFailures = [];
      if (reviewing === null) refreshFailures.push("举报队列");
      try {
        await onAuditChanged();
      } catch {
        refreshFailures.push("审计列表");
      }
      setFeedback(refreshFailures.length > 0
        ? `举报已成功入案，但${refreshFailures.join("和")}刷新失败；请勿重复入案，稍后刷新页面。`
        : "举报已进入案件，接下来选择与当前状态匹配的动作。");
    } catch (error) {
      setFeedback(moderationError(error));
      if ((error as ApiError).code === "admin_mfa_required") onMfaExpired();
    } finally {
      setBusy("");
    }
  }

  async function applyAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected?.caseId || actionReason.trim().length < 8) return;
    const numericDuration = Number.parseInt(durationHours, 10);
    if (action === "suspend" && (!Number.isSafeInteger(numericDuration) || numericDuration < 1 || numericDuration > 8760)) {
      setFeedback("限时停发必须填写 1—8760 小时。" );
      return;
    }
    setBusy("action");
    try {
      const body: { action: ModerationAction; reason: string; durationHours?: number } = { action, reason: actionReason.trim() };
      if (action === "suspend" || (action === "ban" && durationHours.trim())) body.durationHours = numericDuration;
      const payload = await adminRequest<{ case: { status: string; action: ModerationAction } }>(`/api/admin/community/cases/${selected.caseId}/actions`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const reviewing = await loadQueue("reviewing");
      const updated = reviewing?.find((report) => report.id === selected.id) ?? null;
      const refreshFailures = [];
      if (reviewing === null) refreshFailures.push("举报队列");
      try {
        await onAuditChanged();
      } catch {
        refreshFailures.push("审计列表");
      }
      setSelected(reviewing === null ? null : updated);
      setFeedback(refreshFailures.length > 0
        ? `处置已经生效，但${refreshFailures.join("和")}刷新失败；请勿重复操作，稍后刷新页面。`
        : payload.case.status === "reviewing"
          ? "动作已写入审计，案件仍在审核中，可继续恢复、删除或解封。"
          : "治理动作已写入审计，案件已经结案。");
    } catch (error) {
      setFeedback(moderationError(error));
      if ((error as ApiError).code === "admin_mfa_required") onMfaExpired();
      if (["community_moderation_state_conflict", "community_case_not_found"].includes((error as ApiError).code ?? "")) {
        const refreshed = await loadQueue("reviewing");
        setSelected(refreshed?.find((report) => report.id === selected.id) ?? null);
      }
    } finally {
      setBusy("");
    }
  }

  return (
    <section className={styles.moderationDesk} aria-labelledby="moderation-title">
      <header>
        <div><span>社区举报</span><h2 id="moderation-title">举报案卷</h2><p>先核对提交时保存的证据，再入案和处置。每一步都会写入两套不可变审计。</p></div>
        <nav aria-label="举报队列">
          <button aria-pressed={queueStatus === "open"} onClick={() => setQueueStatus("open")}>待入案</button>
          <button aria-pressed={queueStatus === "reviewing"} onClick={() => setQueueStatus("reviewing")}>审核中</button>
        </nav>
      </header>

      {feedback && <p className={styles.moderationFeedback} role="status">{feedback}</p>}
      {status === "loading" && <p className={styles.moderationState} role="status">正在读取举报队列…</p>}
      {status === "error" && <p className={styles.moderationState} role="alert">举报队列没有加载成功。账号值守区不受影响。<button onClick={() => void loadQueue(queueStatus)}>重试</button></p>}
      {status === "ready" && reports.length === 0 && <p className={styles.moderationState}>当前队列为空。新的举报会按提交时间进入这里。</p>}
      {status === "ready" && reports.length > 0 && (
        <ol className={styles.reportQueue}>
          {reports.map((report) => (
            <li key={report.id}>
              <button onClick={() => chooseReport(report)}>
                <span data-status={report.status}>{report.status === "open" ? "待入案" : "审核中"}</span>
                <b>{report.evidenceTitle || report.targetLabel || `${report.targetType} ${report.targetId.slice(0, 8)}…`}</b>
                <p>{report.evidenceBody || "该举报对象为用户账号，没有正文证据。"}</p>
                <small>{reasonLabels[report.reasonCode] || report.reasonCode} · {formatDate(report.createdAt)} · 举报人 @{report.reporterUsername || "已注销"}</small>
              </button>
            </li>
          ))}
        </ol>
      )}

      {selected && (
        <DialogBackdrop onDismiss={closeSelected} dismissDisabled={Boolean(busy)} priority="critical">
          <form ref={caseRef} className={styles.caseSheet} role="dialog" aria-modal="true" aria-labelledby="case-title" onSubmit={selected.caseId ? applyAction : openCase}>
            <header><div><span>{selected.caseId ? "审核中案件" : "待入案举报"}</span><h2 id="case-title">{selected.evidenceTitle || selected.targetLabel || "社区举报"}</h2></div><button type="button" onClick={closeSelected} disabled={Boolean(busy)} aria-label="关闭案卷">×</button></header>
            <dl>
              <div><dt>目标</dt><dd>{selected.targetType} · {selected.targetStatus || "状态未知"}</dd></div>
              <div><dt>作者/用户</dt><dd>{selected.evidenceAuthorLabel || "已注销用户"}</dd></div>
              <div><dt>证据留存</dt><dd>{formatDate(selected.evidenceCapturedAt)}</dd></div>
              <div><dt>举报原因</dt><dd>{reasonLabels[selected.reasonCode] || selected.reasonCode}</dd></div>
            </dl>
            {selected.evidenceBody && <blockquote>{selected.evidenceBody}</blockquote>}
            {selected.detail && <p className={styles.reportDetail}><b>举报补充</b>{selected.detail}</p>}
            {!selected.caseId ? (
              <label><span>入案原因（至少 8 个字）</span><textarea value={caseReason} onChange={(event) => setCaseReason(event.target.value)} maxLength={1000} rows={4} /></label>
            ) : (
              <>
                <label><span>治理动作</span><select value={action} onChange={(event) => setAction(event.target.value as ModerationAction)}>{selected.allowedActions.map((item) => <option key={item} value={item}>{actionLabels[item]}</option>)}</select></label>
                {(action === "suspend" || action === "ban") && <label><span>{action === "suspend" ? "停发时长（小时，必填）" : "封禁时长（小时，留空为长期）"}</span><input type="number" min="1" max="8760" value={durationHours} onChange={(event) => setDurationHours(event.target.value)} required={action === "suspend"} /></label>}
                <label><span>处置原因（至少 8 个字）</span><textarea value={actionReason} onChange={(event) => setActionReason(event.target.value)} maxLength={1000} rows={4} /></label>
              </>
            )}
            {feedback && <p className={styles.caseFeedback} role="status">{feedback}</p>}
            <footer><button type="button" onClick={closeSelected} disabled={Boolean(busy)}>取消</button><button disabled={Boolean(busy) || (selected.caseId ? actionReason.trim().length < 8 : caseReason.trim().length < 8)}>{busy ? "正在写入审计" : selected.caseId ? actionLabels[action] : "建立审核案件"}</button></footer>
          </form>
        </DialogBackdrop>
      )}
    </section>
  );
}
