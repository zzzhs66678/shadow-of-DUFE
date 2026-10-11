"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { feedbackDate, feedbackError, feedbackLabels, feedbackRequest, FeedbackApiError, isReceipt, loadFeedbackPage,
  statusLabels, type FeedbackDetail, type FeedbackReceipt } from "./client";
import styles from "../data-feedback.module.css";

export function AdminDataFeedback() {
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [items, setItems] = useState<FeedbackReceipt[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expiry, setExpiry] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const sequence = useRef(0);
  const lock = useRef(false);
  const clear = useCallback(() => { setItems([]); setCursor(null); setDetail(null); setNote(""); setNotice(""); }, []);
  const expired = useCallback(() => {
    sequence.current++; clear(); setExpiry(null); setDenied(true); setBusy(false);
    setError("管理员验证已过期，请回值守台完成二次验证。");
  }, [clear]);
  function acceptExpiry(value?: string) {
    if (!value || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw new FeedbackApiError(403, "admin_mfa_required");
    setExpiry(value);
  }
  const load = useCallback(async (filter: "open" | "resolved", next?: string) => {
    const request = ++sequence.current;
    clear(); setBusy(true); setError(""); setDenied(false);
    try {
      const result = await loadFeedbackPage(`/api/admin/data-feedback?status=${filter}&limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
      if (request !== sequence.current) return;
      acceptExpiry(result.elevatedUntil); setItems(result.items); setCursor(result.nextCursor);
    } catch (cause) {
      if (request !== sequence.current) return;
      clear(); setError(feedbackError(cause)); setDenied(cause instanceof FeedbackApiError && [401, 403].includes(cause.status));
    } finally { if (request === sequence.current) setBusy(false); }
  }, [clear]);
  useEffect(() => {
    const refresh = () => { if (!lock.current) void load(status); };
    const visibility = () => { if (document.visibilityState === "visible") refresh(); };
    refresh(); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visibility);
    const invalidate = () => { sequence.current++; };
    return () => { invalidate(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visibility); };
  }, [load, status]);
  useEffect(() => {
    if (!expiry) return;
    const timer = window.setTimeout(expired, Math.max(0, Date.parse(expiry) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiry, expired]);

  async function open(item: FeedbackReceipt) {
    const request = ++sequence.current;
    setBusy(true); setDetail(null); setNote(""); setNotice(""); setError("");
    try {
      const result = await feedbackRequest<{ feedback: FeedbackDetail; elevatedUntil: string }>(`/api/admin/data-feedback/${item.id}`);
      if (request !== sequence.current) return;
      if (!isReceipt(result.feedback) || !Array.isArray(result.feedback.actions)) throw new Error("invalid_response");
      acceptExpiry(result.elevatedUntil); setDetail(result.feedback);
    } catch (cause) { if (request === sequence.current) { clear(); setError(feedbackError(cause)); setDenied(cause instanceof FeedbackApiError && [401, 403].includes(cause.status)); } }
    finally { if (request === sequence.current) setBusy(false); }
  }
  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || lock.current || note.trim().length < 2) return;
    lock.current = true;
    const request = ++sequence.current;
    setBusy(true); setError(""); setNotice("");
    const nextStatus = detail.status === "open" ? "resolved" : "open";
    try {
      const result = await feedbackRequest<{ feedback: FeedbackReceipt; elevatedUntil: string }>(`/api/admin/data-feedback/${detail.id}`, {
        method: "PATCH", body: JSON.stringify({ status: nextStatus, version: detail.version, note: note.trim() }),
      });
      if (request !== sequence.current) return;
      if (!isReceipt(result.feedback) || result.feedback.id !== detail.id || result.feedback.status !== nextStatus || result.feedback.version !== detail.version + 1) throw new Error("invalid_response");
      acceptExpiry(result.elevatedUntil);
      setItems(current => current.filter(item => item.id !== detail.id)); setDetail(null); setNote("");
      setNotice(nextStatus === "resolved" ? "已标为已处理，处理记录已保存。" : "已重新打开，处理记录已保存。");
    } catch (cause) {
      if (request === sequence.current) {
        setError(feedbackError(cause));
        if (cause instanceof FeedbackApiError && [401, 403].includes(cause.status)) { clear(); setDenied(true); }
      }
    } finally { lock.current = false; if (request === sequence.current) setBusy(false); }
  }
  return <main className={styles.page}>
    <Link href="/admin">返回值守台</Link><h1>数据问题反馈</h1>
    <div className={styles.filters}><label>处理状态 <select value={status} disabled={busy} onChange={event => setStatus(event.target.value as "open" | "resolved")}><option value="open">待处理</option><option value="resolved">已处理</option></select></label><button disabled={busy} onClick={() => void load(status)}>刷新</button></div>
    {busy && <p role="status">正在读取或保存…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {denied && <p><Link href="/admin">去值守台登录或完成二次验证</Link>，完成后返回并刷新。</p>}
    {notice && <p role="status" className={styles.receipt}>{notice}</p>}
    {!busy && !error && !items.length && <p>没有{statusLabels[status]}的反馈。</p>}
    <ul className={styles.list}>{items.map(item => <li className={styles.item} key={item.id}>
      <div className={styles.heading}><strong>{feedbackLabels[item.type]}</strong><span className={styles.status}>{statusLabels[item.status]}</span></div><p>{item.message}</p><p className={styles.meta}>{feedbackDate(item.createdAt)} · {item.id}</p>
      <button disabled={busy} onClick={() => void open(item)}>查看与处理</button>
    </li>)}</ul>
    {cursor && <button disabled={busy} onClick={() => void load(status, cursor)}>下一页</button>}
    {detail && <section className={styles.details} aria-label="反馈详情">
      <div className={styles.heading}><h2>{feedbackLabels[detail.type]} · {statusLabels[detail.status]}</h2><button disabled={busy} onClick={() => { setDetail(null); setNote(""); }}>关闭详情</button></div>
      <p>{detail.message}</p><dl className={styles.context}><dt>对象标识</dt><dd>{detail.courseId || detail.materialId || detail.room}{detail.meetingId && <><br />{detail.meetingId}</>}</dd><dt>回执</dt><dd>{detail.id}</dd></dl><Link href={detail.path}>查看相关页面</Link>
      <h3>处理记录</h3>{!detail.actions.length ? <p>尚无处理记录。</p> : <ol className={styles.log}>{detail.actions.map(action => <li key={action.id}><span className={styles.meta}>{feedbackDate(action.createdAt)} · {statusLabels[action.fromStatus]} → {statusLabels[action.toStatus]}</span><br />{action.note}</li>)}</ol>}
      <form onSubmit={resolve}><label className={styles.field}>处理说明（必填，2–500 字）<textarea rows={3} minLength={2} maxLength={500} value={note} disabled={busy} required onChange={event => setNote(event.target.value)} /></label><p className={styles.hint}>只更新反馈状态，不会自动修改课程、教室或资料。</p><button className={styles.primary} disabled={busy || note.trim().length < 2}>{detail.status === "open" ? "标为已处理" : "重新打开"}</button></form>
    </section>}
  </main>;
}
