"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { boardDeadline, boardExpired, boardRequest, type WhiteboardEntry } from "./client";
import { BoardPublishedDate, WhiteboardCard } from "./WhiteboardCard";
import styles from "./whiteboard.module.css";

export function Whiteboard({ compact = false }: { compact?: boolean }) {
  const [scope, setScope] = useState<"active" | "archive">("active");
  const [items, setItems] = useState<WhiteboardEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState("loading");
  const sequence = useRef(0);
  const load = useCallback(async (next?: string) => {
    const request = ++sequence.current;
    setState("loading");
    try {
      const result = await boardRequest<{ items: WhiteboardEntry[]; nextCursor?: string | null }>(`/api/community/whiteboard?scope=${scope}&limit=${compact ? 1 : 20}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
      if (request !== sequence.current) return;
      if (!Array.isArray(result.items)) throw new Error("invalid_response");
      const rows = result.items.filter(item => scope === "archive" ? boardExpired(item) : !boardExpired(item));
      setItems(current => next ? [...current, ...rows.filter(row => !current.some(old => old.id === row.id))] : rows);
      setCursor(result.nextCursor || null); setState("ready");
    } catch { if (request === sequence.current) { setState("error"); if (compact) setItems([]); } }
  }, [scope, compact]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { setItems([]); void load(); });
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 60_000);
    const invalidate = () => { sequence.current++; };
    window.addEventListener("pageshow", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { invalidate(); cancelAnimationFrame(frame); clearInterval(timer); window.removeEventListener("pageshow", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
  useEffect(() => {
    if (scope !== "active") return;
    const deadlines = items.map(item => Date.parse(boardDeadline(item) || "")).filter(Number.isFinite);
    if (!deadlines.length) return;
    const timer = setTimeout(() => { setItems(current => current.filter(item => !boardExpired(item))); void load(); }, Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - Date.now()) + 30));
    return () => clearTimeout(timer);
  }, [items, load, scope]);
  if (compact) {
    const item = items[0];
    if (!item || boardExpired(item)) return null;
    return <section className={styles.gateway} id="whiteboard-entry" aria-label="小白板"><Link href={`/whiteboard#note-${item.id}`} className={styles.gatewayLink}>
      <WhiteboardCard item={item} compact /><span className={styles.openBoard}>打开白板 <span aria-hidden="true">↗</span></span>
    </Link></section>;
  }
  return <main className={styles.page}>
    <header className={styles.pageNav}><Link href="/?view=home#whiteboard-entry">← 返回今日</Link><span>东财之影</span></header>
    <div className={styles.pageHeading}><div><h1>小白板</h1><p>写在这里，留给路过的你。</p></div><nav aria-label="白板内容"><button aria-pressed={scope === "active"} onClick={() => { if (scope !== "active") { setItems([]); setScope("active"); } }}>正在板上</button><button aria-pressed={scope === "archive"} onClick={() => { if (scope !== "archive") { setItems([]); setScope("archive"); } }}>往期</button></nav></div>
    {state === "loading" && !items.length && <p role="status">正在读取…</p>}
    {state === "error" && <p role="alert">白板暂时没读取到。<button className={styles.textButton} onClick={() => void load()}>重试</button></p>}
    {state === "ready" && !items.length && <div className={styles.empty}>{scope === "active" ? "暂时没有新留言。" : "还没有往期内容。"}</div>}
    <div className={styles.notes}>{items.map(item => <article id={`note-${item.id}`} key={item.id}><WhiteboardCard item={item} archived={scope === "archive"} /><BoardPublishedDate value={item.publishedAt} /></article>)}</div>
    {cursor && <button className={styles.secondary} disabled={state === "loading"} onClick={() => void load(cursor)}>再看一些</button>}
  </main>;
}
