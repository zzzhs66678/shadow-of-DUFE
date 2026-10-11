"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { DialogActions, DialogBackdrop } from "../DialogBackdrop";
import { useModalFocus } from "../use-modal-focus";
import { useWallDraft, useWallUnsaved } from "../community/use-wall-unsaved";
import { BoardError, boardDate, boardError, boardExpired, boardRequest, chinaInput, chinaISO, type BoardCopy, type WhiteboardEntry } from "./client";
import { WhiteboardCard } from "./WhiteboardCard";
import styles from "./whiteboard.module.css";

const emptyCopy: BoardCopy = { kind: "note", title: "", body: "", guest: "", guestBio: "", location: "", startsAt: null, endsAt: null, expiresAt: null };
type Draft = BoardCopy & { baseVersion: number | null };
const blank: Draft = { ...emptyCopy, baseVersion: null };
const hasDraft = (draft: Draft) => Boolean(draft.body || draft.title || draft.guest || draft.location || draft.startsAt || draft.endsAt || draft.guestBio || draft.expiresAt);
type AdminList = { items: WhiteboardEntry[]; viewerId: string; elevatedUntil: string; nextCursor?: string | null };
function asDraft(entry: WhiteboardEntry | null): Draft {
  if (!entry) return blank;
  const { kind, title, body, guest, guestBio, location, startsAt, endsAt, expiresAt, version } = entry;
  return { kind, title, body, guest, guestBio, location, startsAt, endsAt, expiresAt, baseVersion: version };
}

export function WhiteboardDesk({ onMfaExpired, onAuditChanged }: { onMfaExpired: () => void; onAuditChanged: () => Promise<void> }) {
  const [items, setItems] = useState<WhiteboardEntry[]>([]);
  const [owner, setOwner] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<WhiteboardEntry | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const ownerRef = useRef("");
  const lock = useRef(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const expired = useCallback(() => {
    generation.current++; ownerRef.current = ""; setOwner(""); setItems([]); setSelected(null); setExpiry("");
    onMfaExpired();
  }, [onMfaExpired]);
  const load = useCallback(async (next?: string) => {
    const request = ++generation.current;
    setLoading(true); setError("");
    try {
      const result = await boardRequest<AdminList>(`/api/admin/whiteboard${next ? `?cursor=${encodeURIComponent(next)}` : ""}`);
      if (request !== generation.current) return;
      if (!Array.isArray(result.items) || !result.viewerId || !result.elevatedUntil || Date.parse(result.elevatedUntil) <= Date.now()) throw new BoardError(403, "admin_mfa_required");
      const changed = Boolean(ownerRef.current && ownerRef.current !== result.viewerId);
      if (changed) { setSelected(null); setNotice(""); }
      else if (!next) setSelected(current => current ? result.items.find(item => item.id === current.id) || current : null);
      ownerRef.current = result.viewerId; setOwner(result.viewerId); setExpiry(result.elevatedUntil);
      setItems(current => next && !changed ? [...current, ...result.items.filter(item => !current.some(old => old.id === item.id))] : result.items);
      setCursor(result.nextCursor || null);
    } catch (cause) {
      if (request !== generation.current) return;
      if (cause instanceof BoardError && [401, 403].includes(cause.status)) expired();
      else setError(boardError(cause));
    } finally { if (request === generation.current) setLoading(false); }
  }, [expired]);
  useEffect(() => {
    const refresh = () => { if (!lock.current && document.visibilityState === "visible") void load(); };
    const frame = requestAnimationFrame(refresh);
    const invalidate = () => { generation.current++; };
    window.addEventListener("focus", refresh); window.addEventListener("dufesh:auth-changed", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { invalidate(); cancelAnimationFrame(frame); window.removeEventListener("focus", refresh); window.removeEventListener("dufesh:auth-changed", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
  useEffect(() => {
    if (!expiry) return;
    const timer = setTimeout(expired, Math.max(0, Date.parse(expiry) - Date.now()));
    return () => clearTimeout(timer);
  }, [expiry, expired]);
  const saved = (entry: WhiteboardEntry) => {
    setItems(current => [entry, ...current.filter(item => item.id !== entry.id)]); setSelected(entry); setEditorEpoch(value => value + 1);
    setNotice(entry.status === "published" ? boardExpired(entry) ? "已发布到往期，不占用首页。" : "已放上白板，所有访客都能看到。" : "草稿已保存，访客暂时看不到。");
    void onAuditChanged().catch(() => {});
  };
  async function withdraw(item: WhiteboardEntry) {
    if (lock.current || !window.confirm("从公开白板撤下这条内容？记录会保留。")) return;
    lock.current = true; setBusy(true); setError("");
    const requestOwner = ownerRef.current;
    try {
      const { baseVersion: version, ...copy } = asDraft(item);
      const result = await boardRequest<{ entry: WhiteboardEntry }>(`/api/admin/whiteboard/${item.id}`, { method: "PATCH", headers: { "X-Whiteboard-Owner": requestOwner }, body: JSON.stringify({ ...copy, version, status: "withdrawn", mutationId: crypto.randomUUID() }) });
      if (requestOwner !== ownerRef.current) return;
      setItems(current => current.map(old => old.id === item.id ? result.entry : old));
      if (selected?.id === item.id) { setSelected(result.entry); setEditorEpoch(value => value + 1); }
      setNotice("已撤下，公开页面不再显示。"); void onAuditChanged().catch(() => {});
    } catch (cause) {
      if (requestOwner !== ownerRef.current) return;
      setError(boardError(cause));
      if (cause instanceof BoardError && [401, 403].includes(cause.status)) expired();
    } finally { lock.current = false; setBusy(false); }
  }
  return <section className={styles.desk} aria-label="管理小白板">
    <div className={styles.deskHeading}><p>讲座、消息，或几句想说的话。</p><Link href="/whiteboard" target="_blank" rel="noopener noreferrer">看公开白板 ↗</Link></div>
    {error && <p role="alert" className={`${styles.feedback} ${styles.error}`}>{error}<button className={styles.textButton} disabled={busy || loading} onClick={() => void load()}>刷新记录</button></p>}
    {notice && <p role="status" className={styles.feedback}>{notice}</p>}
    {!owner && loading && <p role="status">正在打开白板…</p>}
    {owner && <WhiteboardEditor key={`${owner}:${selected?.id || "new"}:${editorEpoch}`} owner={owner} entry={selected} onSaved={saved} onExpired={expired} onReload={() => void load()} onBusy={value => { lock.current = value; setBusy(value); }} />}
    {owner && <section className={styles.history} aria-label="白板记录"><div className={styles.deskHeading}><h2>写过的内容</h2><button className={styles.secondary} disabled={busy} onClick={() => { setSelected(null); setEditorEpoch(value => value + 1); setNotice(""); }}>＋ 写一条</button></div>
      {!items.length && <p>还没有保存的内容。</p>}
      <ul>{items.map(item => <li key={item.id}><div><strong>{item.title || item.body.slice(0, 60)}</strong><small>{item.status === "draft" ? "草稿" : item.status === "withdrawn" ? "已撤下" : boardExpired(item) ? "已结束 / 往期" : "正在板上"} · {boardDate(item.updatedAt)}</small></div><div className={styles.historyActions}><button className={styles.textButton} disabled={busy} onClick={() => { setSelected(item); setEditorEpoch(value => value + 1); setNotice(""); }}>编辑</button>{item.status === "published" && <button className={styles.textButton} disabled={busy} onClick={() => void withdraw(item)}>撤下</button>}</div></li>)}</ul>
      {cursor && <button className={styles.secondary} disabled={busy || loading} onClick={() => void load(cursor)}>更早的内容</button>}
    </section>}
  </section>;
}

function WhiteboardEditor({ owner, entry, onSaved, onExpired, onBusy, onReload }: { owner: string; entry: WhiteboardEntry | null; onSaved: (entry: WhiteboardEntry) => void; onExpired: () => void; onBusy: (busy: boolean) => void; onReload: () => void }) {
  const initial = useMemo(() => asDraft(entry), [entry]);
  const parse = useCallback((value: unknown): Draft => {
    if (!value || typeof value !== "object" || !hasDraft(value as Draft)) return initial;
    const draft = value as Draft;
    if (!["note", "event"].includes(draft.kind) || ![draft.title, draft.body, draft.guest, draft.guestBio, draft.location].every(value => typeof value === "string")) return initial;
    return { ...draft, title: draft.title.slice(0, 120), body: draft.body.slice(0, 4000), guest: draft.guest.slice(0, 80), guestBio: draft.guestBio.slice(0, 1500), location: draft.location.slice(0, 160) };
  }, [initial]);
  const [draft, update, settle] = useWallDraft(`dufesh:whiteboard-draft:${owner}:${entry?.id || "new"}`, initial, parse, hasDraft);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const mounted = useRef(true);
  const pending = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const closePreview = useCallback(() => { if (!lock.current) setPreviewing(false); }, []);
  const modalRef = useModalFocus<HTMLDivElement>(previewing, closePreview, busy);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useWallUnsaved(dirty || busy);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => { update(current => ({ ...current, [key]: value })); setError(""); };
  const valid = draft.body.trim().length > 0 && (draft.kind === "note" || Boolean(draft.title.trim() && draft.location.trim() && draft.startsAt && draft.endsAt && Date.parse(draft.endsAt) > Date.parse(draft.startsAt)));
  const stale = entry && draft.baseVersion !== entry.version;
  const copy: BoardCopy = draft.kind === "note" ? { ...draft, guest: "", guestBio: "", location: "", startsAt: null, endsAt: null } : { ...draft, expiresAt: null };
  function preview(event: FormEvent) { event.preventDefault(); if (valid && !stale && !lock.current) setPreviewing(true); }
  async function save(status: "draft" | "published") {
    if (!valid || stale || lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setError("");
    const { kind, title, body, guest, guestBio, location, startsAt, endsAt, expiresAt } = copy;
    const payload = { kind, title: title.trim(), body: body.trim(), guest: guest.trim(), guestBio: guestBio.trim(), location: location.trim(), startsAt, endsAt, expiresAt, status, ...(entry ? { version: draft.baseVersion } : {}) };
    const fingerprint = JSON.stringify(payload);
    if (pending.current?.payload !== fingerprint) pending.current = { payload: fingerprint, id: crypto.randomUUID() };
    try {
      const result = await boardRequest<{ entry: WhiteboardEntry }>(`/api/admin/whiteboard${entry ? `/${entry.id}` : ""}`, { method: entry ? "PATCH" : "POST", headers: { "X-Whiteboard-Owner": owner }, body: JSON.stringify({ ...payload, mutationId: pending.current.id }) });
      settle(() => blank);
      if (mounted.current) { setPreviewing(false); onSaved(result.entry); }
    } catch (cause) {
      if (!mounted.current) return;
      setError(boardError(cause));
      if (cause instanceof BoardError && [401, 403].includes(cause.status)) onExpired();
    } finally { lock.current = false; if (mounted.current) setBusy(false); onBusy(false); }
  }
  return <div className={styles.studio}>
    <form className={styles.editor} onSubmit={preview}>
      <fieldset disabled={busy}><legend>{entry ? "编辑内容" : "今天写点什么"}</legend><div className={styles.kindPicker}><button type="button" aria-pressed={draft.kind === "note"} onClick={() => set("kind", "note")}>留句话</button><button type="button" aria-pressed={draft.kind === "event"} onClick={() => set("kind", "event")}>讲座 / 活动</button></div>
        <label className={styles.field}>{draft.kind === "event" ? "主题" : "标题（选填）"}<input value={draft.title} maxLength={120} required={draft.kind === "event"} onChange={event => set("title", event.target.value)} /></label>
        {draft.kind === "event" && <>
          <div className={styles.dateFields}><label className={styles.field}>开始时间<input type="datetime-local" value={chinaInput(draft.startsAt)} required onChange={event => set("startsAt", chinaISO(event.target.value))} /></label><label className={styles.field}>结束时间<input type="datetime-local" value={chinaInput(draft.endsAt)} required onChange={event => set("endsAt", chinaISO(event.target.value))} /></label></div>
          <label className={styles.field}>地点<input value={draft.location} maxLength={160} required onChange={event => set("location", event.target.value)} /></label>
          <label className={styles.field}>嘉宾（选填）<input value={draft.guest} maxLength={80} onChange={event => set("guest", event.target.value)} /></label>
        </>}
        <label className={styles.field}>{draft.kind === "event" ? "讲座 / 活动简介" : "想说的话"}<textarea rows={5} value={draft.body} maxLength={4000} required onChange={event => set("body", event.target.value)} /><small>{draft.body.length} / 4000</small></label>
        {draft.kind === "event" ? <details><summary>嘉宾简介（选填）</summary><label className={styles.field}>嘉宾简介<textarea rows={3} value={draft.guestBio} maxLength={1500} onChange={event => set("guestBio", event.target.value)} /></label></details> : <details><summary>到期收起（选填）</summary><label className={styles.field}>收起时间<input type="datetime-local" value={chinaInput(draft.expiresAt)} onChange={event => set("expiresAt", chinaISO(event.target.value))} /><small>不填就一直展示，直到你撤下。</small></label></details>}
      </fieldset>
      {stale && <p className={styles.error} role="alert">这份草稿基于较早版本，不能直接覆盖。请复制需要保留的文字，再<button type="button" className={styles.textButton} onClick={() => { update(() => initial); setError(""); }}>使用最新版本</button>。</p>}
      {error && !previewing && <p className={styles.error} role="alert">{error}<button type="button" className={styles.textButton} onClick={onReload} disabled={busy}>读取最新记录</button></p>}
      <div className={styles.editorActions}>{entry?.status !== "published" && <button type="button" className={styles.secondary} disabled={busy || !valid || Boolean(stale)} onClick={() => void save("draft")}>存草稿</button>}<button className={styles.primary} disabled={busy || !valid || Boolean(stale)}>{busy ? "正在保存…" : entry?.status === "published" ? "预览并更新" : "预览并发布"}</button></div>
    </form>
    <aside className={styles.preview} aria-label="小白板实时预览"><p className={styles.previewLabel}><b>白板上的样子</b><span>仅预览，尚未发布</span></p><WhiteboardCard item={copy} /><p className={styles.previewNote}>{draft.kind === "event" ? "活动结束后自动收进往期。所有时间按北京时间。" : "有空时来写两句，就很好。"}</p></aside>
    {previewing && <DialogBackdrop onDismiss={closePreview} dismissDisabled={busy}><div ref={modalRef} className={`${styles.desk} ${styles.confirm}`} role="dialog" aria-modal="true" aria-labelledby="whiteboard-confirm"><h2 id="whiteboard-confirm">{entry?.status === "published" ? "更新这条白板？" : "放上白板？"}</h2><WhiteboardCard item={copy} /><p>{boardExpired(copy) ? "这条内容的结束时间已过，发布后只出现在“往期”。" : "发布后，未登录的访客也能看到。"}</p>{error && <p role="alert" className={styles.error}>{error}</p>}<DialogActions><button type="button" disabled={busy} onClick={closePreview}>再改改</button><button type="button" disabled={busy} onClick={() => void save("published")}>{busy ? "正在发布…" : "确认发布"}</button></DialogActions></div></DialogBackdrop>}
  </div>;
}
