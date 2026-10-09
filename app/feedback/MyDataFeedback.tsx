"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { feedbackDate, feedbackError, feedbackLabels, FeedbackApiError, loadFeedbackPage, statusLabels, type FeedbackReceipt } from "./client";
import styles from "../data-feedback.module.css";

export function MyDataFeedback() {
  const [items, setItems] = useState<FeedbackReceipt[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async (next?: string) => {
    const request = ++sequence.current;
    setBusy(true); setError(""); setAnonymous(false);
    // Replace pages instead of appending, so a switched account never inherits old items.
    setItems([]); setCursor(null);
    try {
      const page = await loadFeedbackPage(`/api/auth/data-feedback?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
      if (request !== sequence.current) return;
      setItems(page.items); setCursor(page.nextCursor);
    } catch (cause) {
      if (request !== sequence.current) return;
      setError(feedbackError(cause)); setAnonymous(cause instanceof FeedbackApiError && cause.status === 401);
    } finally { if (request === sequence.current) setBusy(false); }
  }, []);
  useEffect(() => {
    const refresh = () => { void load(); };
    const visibility = () => { if (document.visibilityState === "visible") refresh(); };
    refresh(); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visibility);
    const invalidate = () => { sequence.current++; };
    return () => { invalidate(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visibility); };
  }, [load]);
  return <main className={styles.page}>
    <Link href="/?view=me">返回我的</Link><h1>我的反馈</h1><p className={styles.hint}>只有你和管理员能查看；这里显示实际处理状态。</p>
    <button type="button" disabled={busy} onClick={() => void load()}>刷新</button>
    {busy && <p role="status">正在读取反馈…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {anonymous && <Link href="/?view=me#account-center-title">去登录</Link>}
    {!busy && !error && !items.length && <p>还没有反馈。在课程、教室或资料页点击“反馈问题”即可提交。</p>}
    <ul className={styles.list}>{items.map(item => <li className={styles.item} key={item.id}>
      <div className={styles.heading}><strong>{feedbackLabels[item.type]}</strong><span className={styles.status}>{statusLabels[item.status]}</span></div>
      <p>{item.message}</p><p className={styles.meta}>回执：{item.id}<br />提交于 {feedbackDate(item.createdAt)}</p><Link href={item.path}>查看相关页面</Link>
    </li>)}</ul>
    {cursor && <button disabled={busy} onClick={() => void load(cursor)}>下一页</button>}
  </main>;
}
