"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { DialogBackdrop } from "./DialogBackdrop";
import { useModalFocus } from "./use-modal-focus";
import { feedbackContext, feedbackError, feedbackLabels, feedbackRequest, FeedbackApiError, isReceipt,
  type FeedbackContext, type FeedbackReceipt, type FeedbackTarget } from "./feedback/client";
import styles from "./data-feedback.module.css";

// Only pass public catalogue objects. No personal course/schedule object is accepted.
export function DataFeedback({ target, className = "" }: { target: FeedbackTarget; className?: string }) {
  const [context, setContext] = useState<FeedbackContext | null>(null);
  const close = useCallback(() => setContext(null), []);
  const valid = feedbackContext(target);
  return <>
    <button type="button" className={`${styles.trigger} ${className}`} disabled={!valid}
      aria-label={`${feedbackLabels[target.type]}：反馈问题`} onClick={() => setContext(valid)}>反馈问题</button>
    {context && createPortal(<DataFeedbackDialog context={context} onClose={close} />, document.body)}
  </>;
}

export function DataFeedbackDialog({ context, onClose }: { context: FeedbackContext; onClose: () => void }) {
  const id = useId();
  const [auth, setAuth] = useState<"loading" | "ready" | "anonymous" | "error">("loading");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null);
  const attempt = useRef<{ message: string; requestKey: string } | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);
  const dialog = useModalFocus<HTMLElement>(true, onClose, busy);
  const checkSession = useCallback(async () => {
    try {
      const result = await feedbackRequest<{ authenticated: boolean }>("/api/auth/data-feedback/session");
      if (result.authenticated !== true) throw new Error("invalid_response");
      if (active.current) { setAuth("ready"); setError(""); }
    } catch (cause) {
      if (active.current) { setReceipt(null); setAuth(cause instanceof FeedbackApiError && cause.status === 401 ? "anonymous" : "error"); setError(feedbackError(cause)); }
    }
  }, []);
  useEffect(() => {
    active.current = true;
    const frame = window.requestAnimationFrame(() => { void checkSession(); });
    return () => { active.current = false; window.cancelAnimationFrame(frame); };
  }, [checkSession]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || auth !== "ready" || receipt || message.trim().length < 2) return;
    inFlight.current = true;
    setBusy(true); setError("");
    const text = message.trim();
    try {
      if (!attempt.current || attempt.current.message !== text) attempt.current = { message: text, requestKey: crypto.randomUUID() };
      const data = await feedbackRequest<{ feedback: FeedbackReceipt }>("/api/auth/data-feedback", {
        method: "POST", body: JSON.stringify({ ...context, ...attempt.current }),
      });
      if (!isReceipt(data.feedback) || data.feedback.path !== context.path || data.feedback.message !== text) throw new Error("invalid_response");
      if (active.current) setReceipt(data.feedback);
    } catch (cause) {
      if (active.current) {
        setError(feedbackError(cause));
        if (cause instanceof FeedbackApiError && cause.status === 401) setAuth("anonymous");
      }
    } finally { inFlight.current = false; if (active.current) setBusy(false); }
  }

  return <DialogBackdrop onDismiss={onClose} dismissDisabled={busy} priority="critical">
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-privacy`} className={styles.dialog}>
      <header className={styles.heading}><h2 id={`${id}-title`}>反馈问题</h2><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
      <p id={`${id}-privacy`} className={styles.hint}>仅附上公开课程、教室或资料标识。不会读取个人课表、学校账号、密码或学校 Cookie。请勿在描述中填写这些信息。</p>
      <dl className={styles.context}><dt>{feedbackLabels[context.type]}</dt><dd>{context.courseId || context.materialId || context.room}{context.meetingId && <><br />{context.meetingId}</>}</dd><dt>相关页面</dt><dd>{context.path}</dd></dl>
      {receipt ? <div className={styles.receipt} role="status"><h3>反馈已收到</h3><p>回执编号：<code>{receipt.id}</code></p><p>可在“我的反馈”查看处理状态。</p><Link href="/feedback">我的反馈</Link></div>
        : <form onSubmit={submit}>
          {auth === "loading" && <p role="status">正在确认登录状态…</p>}
          {auth === "anonymous" && <p>请先登录东财之影。<Link href="/?view=me#account-center-title">去登录</Link></p>}
          {auth === "error" && <button type="button" onClick={() => void checkSession()}>重试连接</button>}
          <label className={styles.field} htmlFor={`${id}-message`}>简短说明问题（2–500 字）<textarea id={`${id}-message`} value={message} minLength={2} maxLength={500} required rows={4} disabled={busy || auth !== "ready"} onChange={event => setMessage(event.target.value)} /></label>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <footer className={styles.actions}><button type="button" disabled={busy} onClick={onClose}>取消</button><button className={styles.primary} type="submit" disabled={busy || auth !== "ready" || message.trim().length < 2}>{busy ? "正在提交…" : "提交反馈"}</button></footer>
        </form>}
    </section>
  </DialogBackdrop>;
}

export default DataFeedback;
