"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { DialogActions, DialogBackdrop } from "../DialogBackdrop";
import { FormField } from "../FormField";
import { useModalFocus } from "../use-modal-focus";
import styles from "./admin.module.css";

type ContentType = "topic" | "comment";
type ContentStatus = "published" | "hidden";
type ContentAction = "hide" | "restore" | "delete" | "warn" | "dismiss";
type ContentItem = {
  id: string;
  type: ContentType;
  title: string;
  body: string;
  status: ContentStatus;
  authorLabel: string;
  publicPath: string;
  caseId: string | null;
  caseStatus: string | null;
  allowedActions: ContentAction[];
  createdAt: string;
  updatedAt: string;
};
type ApiError = Error & { code?: string };

const actionLabels: Record<ContentAction, string> = {
  hide: "隐藏并继续审核",
  restore: "恢复并结案",
  delete: "软删除并结案",
  warn: "提醒作者并结案",
  dismiss: "确认无须处理",
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
    error.code = payload.error;
    throw error;
  }
  return payload;
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

function contentError(error: unknown) {
  switch ((error as ApiError).code) {
    case "admin_mfa_required": return "本次值守凭证已失效，请重新验证后继续。";
    case "community_content_not_found": return "内容已变化或不可再治理，列表已刷新。";
    case "community_moderation_state_conflict": return "内容或案件状态刚刚变化，列表已刷新。";
    case "community_case_not_found": return "案件已经结案或不可用，列表已刷新。";
    case "community_moderation_rate_limited": return "值守动作过于频繁，请稍后再继续。";
    default: return "内容治理请求没有完成，请检查网络后重试。";
  }
}

export function ActiveContentDesk({
  onMfaExpired,
  onAuditChanged,
}: {
  onMfaExpired: () => void;
  onAuditChanged: () => Promise<void>;
}) {
  const [type, setType] = useState<ContentType>("topic");
  const [contentStatus, setContentStatus] = useState<ContentStatus>("published");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ContentItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selected, setSelected] = useState<ContentItem | null>(null);
  const [caseReason, setCaseReason] = useState("");
  const [action, setAction] = useState<ContentAction>("hide");
  const [actionReason, setActionReason] = useState("");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const closeSelected = useCallback(() => setSelected(null), []);
  const dialogRef = useModalFocus<HTMLFormElement>(Boolean(selected), closeSelected, Boolean(busy));

  const loadContent = useCallback(async (cursor?: string, append = false) => {
    setStatus("loading");
    try {
      const params = new URLSearchParams({ type, status: contentStatus, limit: "20" });
      if (query) params.set("query", query);
      if (cursor) params.set("cursor", cursor);
      const payload = await adminRequest<{ items: ContentItem[]; nextCursor: string | null }>(`/api/admin/community/content?${params.toString()}`);
      setItems((current) => append ? [...current, ...payload.items] : payload.items);
      setNextCursor(payload.nextCursor);
      setStatus("ready");
      return payload.items;
    } catch (error) {
      if ((error as ApiError).code === "admin_mfa_required") onMfaExpired();
      setStatus("error");
      return null;
    }
  }, [contentStatus, onMfaExpired, query, type]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void loadContent(); });
    return () => window.cancelAnimationFrame(frame);
  }, [loadContent]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(queryDraft.normalize("NFKC").trim());
  }

  function choose(item: ContentItem) {
    setSelected(item);
    setCaseReason("");
    setAction(item.allowedActions[0] ?? (item.status === "hidden" ? "restore" : "hide"));
    setActionReason("");
    setFeedback("");
  }

  async function openCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || caseReason.trim().length < 8) return;
    setBusy("case");
    try {
      const payload = await adminRequest<{ case: { id: string; allowedActions: ContentAction[] } }>(
        `/api/admin/community/content/${selected.type}/${selected.id}/case`,
        { method: "POST", body: JSON.stringify({ reason: caseReason.trim() }) },
      );
      const allowedActions = payload.case.allowedActions.length ? payload.case.allowedActions : selected.allowedActions;
      setSelected({ ...selected, caseId: payload.case.id, caseStatus: "reviewing", allowedActions });
      setAction(allowedActions[0] ?? (selected.status === "hidden" ? "restore" : "hide"));
      setFeedback("内容已进入统一案件流程，请选择处置动作。此时尚未改变公开状态。");
      await onAuditChanged();
    } catch (error) {
      setFeedback(contentError(error));
      if ((error as ApiError).code === "admin_mfa_required") onMfaExpired();
      if (["community_content_not_found", "community_moderation_state_conflict"].includes((error as ApiError).code ?? "")) {
        await loadContent();
        setSelected(null);
      }
    } finally {
      setBusy("");
    }
  }

  async function applyAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected?.caseId || actionReason.trim().length < 8) return;
    setBusy("action");
    try {
      await adminRequest(`/api/admin/community/cases/${selected.caseId}/actions`, {
        method: "POST",
        body: JSON.stringify({ action, reason: actionReason.trim() }),
      });
      const refreshFailures = [];
      if (await loadContent() === null) refreshFailures.push("内容列表");
      try { await onAuditChanged(); } catch { refreshFailures.push("审计列表"); }
      setSelected(null);
      setFeedback(refreshFailures.length
        ? `处置已生效，但${refreshFailures.join("和")}刷新失败；请勿重复操作。`
        : "处置已生效，并已写入案件记录与管理员审计。");
    } catch (error) {
      setFeedback(contentError(error));
      if ((error as ApiError).code === "admin_mfa_required") onMfaExpired();
      if (["community_case_not_found", "community_moderation_state_conflict"].includes((error as ApiError).code ?? "")) {
        await loadContent();
        setSelected(null);
      }
    } finally {
      setBusy("");
    }
  }

  return (
    <section className={`${styles.moderationDesk} ${styles.activeContentDesk}`} aria-labelledby="active-content-title">
      <header>
        <div><span>主动巡查</span><h2 id="active-content-title">公开内容值守</h2><p>无需等待举报即可检索主题与回复；任何处置仍须先建案，并写入两套不可变审计。</p></div>
        <nav aria-label="内容类型">
          <button aria-pressed={type === "topic"} onClick={() => setType("topic")}>主题</button>
          <button aria-pressed={type === "comment"} onClick={() => setType("comment")}>回复</button>
        </nav>
      </header>
      <div className={styles.contentFilters}>
        <form role="search" onSubmit={search}>
          <FormField label="按标题或正文查找"><input type="search" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} maxLength={64} /></FormField>
          <button>查找</button>
        </form>
        <div role="group" aria-label="内容状态">
          <button aria-pressed={contentStatus === "published"} onClick={() => setContentStatus("published")}>公开中</button>
          <button aria-pressed={contentStatus === "hidden"} onClick={() => setContentStatus("hidden")}>已隐藏</button>
        </div>
      </div>

      {feedback && <p className={styles.moderationFeedback} role="status">{feedback}</p>}
      {status === "loading" && <p className={styles.moderationState} role="status">正在读取内容目录…</p>}
      {status === "error" && <p className={styles.moderationState} role="alert">内容目录没有加载成功。举报队列不受影响。<button onClick={() => void loadContent()}>重试</button></p>}
      {status === "ready" && items.length === 0 && <p className={styles.moderationState}>当前条件下没有内容。</p>}
      {status === "ready" && items.length > 0 && (
        <ol className={styles.reportQueue}>
          {items.map((item) => (
            <li key={item.id}>
              <button onClick={() => choose(item)}>
                <span data-status={item.status === "published" ? "open" : "reviewing"}>{item.status === "published" ? "公开中" : "已隐藏"}</span>
                <b>{item.title}</b>
                <p>{item.body}</p>
                <small>{item.type === "topic" ? "主题" : "回复"} · {item.authorLabel} · {formatDate(item.createdAt)}{item.caseId ? " · 已有案件" : ""}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
      {status === "ready" && nextCursor && <button className={styles.queueMore} onClick={() => void loadContent(nextCursor, true)}>继续读取内容</button>}

      {selected && (
        <DialogBackdrop onDismiss={closeSelected} dismissDisabled={Boolean(busy)} priority="critical">
          <form ref={dialogRef} className={styles.caseSheet} role="dialog" aria-modal="true" aria-labelledby="active-content-case-title" onSubmit={selected.caseId ? applyAction : openCase}>
            <header><div><span>{selected.caseId ? "统一治理案件" : "主动巡查建案"}</span><h2 id="active-content-case-title">{selected.title}</h2></div><button type="button" onClick={closeSelected} disabled={Boolean(busy)} aria-label="关闭内容案卷">×</button></header>
            <dl>
              <div><dt>类型</dt><dd>{selected.type === "topic" ? "主题" : "回复"}</dd></div>
              <div><dt>状态</dt><dd>{selected.status === "published" ? "公开中" : "已隐藏"}</dd></div>
              <div><dt>作者</dt><dd>{selected.authorLabel}</dd></div>
              <div><dt>发布时间</dt><dd>{formatDate(selected.createdAt)}</dd></div>
            </dl>
            <blockquote>{selected.body}</blockquote>
            {selected.status === "published" && <p className={styles.reportDetail}><Link href={selected.publicPath} target="_blank">在公开页面核对上下文</Link></p>}
            {!selected.caseId ? (
              <FormField label="建案依据（至少 8 个字）" counter={`${caseReason.length}/1000`} className={styles.caseField}><textarea value={caseReason} onChange={(event) => setCaseReason(event.target.value)} maxLength={1000} rows={4} /></FormField>
            ) : (
              <>
                <FormField label="治理动作" className={styles.caseField}><select value={action} onChange={(event) => setAction(event.target.value as ContentAction)}>{selected.allowedActions.map((item) => <option key={item} value={item}>{actionLabels[item]}</option>)}</select></FormField>
                <FormField label="处置依据（至少 8 个字）" counter={`${actionReason.length}/1000`} className={styles.caseField}><textarea value={actionReason} onChange={(event) => setActionReason(event.target.value)} maxLength={1000} rows={4} /></FormField>
              </>
            )}
            {feedback && <p className={styles.caseFeedback} role="status">{feedback}</p>}
            <DialogActions><button type="button" onClick={closeSelected} disabled={Boolean(busy)}>取消</button><button disabled={Boolean(busy) || (selected.caseId ? actionReason.trim().length < 8 : caseReason.trim().length < 8)}>{busy ? "正在写入审计" : selected.caseId ? actionLabels[action] : "建立治理案件"}</button></DialogActions>
          </form>
        </DialogBackdrop>
      )}
    </section>
  );
}
