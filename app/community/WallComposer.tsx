"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AuthorBadge } from "./CommunityShared";
import { communityErrorMessage, communityRequest, type CommunityAuthor } from "./community-api";
import styles from "./community.module.css";

type Draft = { title: string; body: string; visibility: "public" | "unlisted" };
const empty: Draft = { title: "", body: "", visibility: "public" };

export function WallComposer({ author, onPublished }: { author: CommunityAuthor; onPublished: (id: string) => void }) {
  const key = `dufe:wall-draft:${author.id}`;
  const [draft, setDraft] = useState<Draft>(empty);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const published = useRef(false);
  const alive = useRef(true);
  const dirty = useRef(false);
  function changeDraft(next: Draft) {
    dirty.current = Boolean(next.title || next.body);
    setDraft(next);
    try {
      if (dirty.current) sessionStorage.setItem(key, JSON.stringify(next));
      else sessionStorage.removeItem(key);
      setSaved(true);
    } catch { setSaved(false); }
  }
  useEffect(() => {
    alive.current = true;
    const frame = requestAnimationFrame(() => {
      try {
        const stored = JSON.parse(sessionStorage.getItem(key) || "null");
        if (stored && typeof stored.body === "string" && typeof stored.title === "string") {
          setDraft({ title: stored.title.slice(0, 120), body: stored.body.slice(0, 5000), visibility: stored.visibility === "unlisted" ? "unlisted" : "public" });
          dirty.current = Boolean(stored.title || stored.body);
        }
      } catch { /* An unavailable storage must not prevent writing. */ }
      setReady(true);
    });
    return () => { alive.current = false; cancelAnimationFrame(frame); };
  }, [key]);
  useEffect(() => {
    if (!ready) return;
    try {
      if (draft.title || draft.body) sessionStorage.setItem(key, JSON.stringify(draft));
      else sessionStorage.removeItem(key);
      const frame = requestAnimationFrame(() => setSaved(true));
      return () => cancelAnimationFrame(frame);
    } catch {
      const frame = requestAnimationFrame(() => setSaved(false));
      return () => cancelAnimationFrame(frame);
    }
  }, [draft, key, ready]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (published.current || !dirty.current) return; event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!draft.body.trim() || submitting.current) { bodyRef.current?.focus(); return; }
    const title = draft.title.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (title && Array.from(title).length < 4) {
      setError("标题至少写 4 个字，也可以留空。");
      document.getElementById("wall-title")?.focus();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await communityRequest<{ topic: { id: string } }>("/api/community/topics", { method: "POST", headers: { "X-Community-Owner": author.id }, body: JSON.stringify(draft) });
      published.current = true;
      try { sessionStorage.removeItem(key); } catch { /* The post is already saved by the server. */ }
      if (!alive.current) return;
      dirty.current = false;
      setDraft(empty);
      setSaved(true);
      onPublished(result.topic.id);
    } catch (caught) { if (alive.current) setError(communityErrorMessage(caught)); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  }

  return <form className={styles.composer} id="wall-composer" aria-label="发布帖子" onSubmit={publish}>
    <AuthorBadge author={author} />
    <label className={styles.srOnly} htmlFor="wall-body">帖子正文</label>
    <textarea ref={bodyRef} id="wall-body" name="body" autoComplete="off" placeholder="今天有什么想说的？" rows={2} maxLength={5000} required disabled={!ready || busy} value={draft.body} onChange={(event) => changeDraft({ ...draft, body: event.target.value })} />
    <details className={styles.titleOption} open={draft.title ? true : undefined}>
      <summary>添加标题<span>选填</span></summary>
      <label className={styles.srOnly} htmlFor="wall-title">帖子标题（选填）</label>
      <input id="wall-title" name="title" autoComplete="off" placeholder="标题…" maxLength={120} value={draft.title} disabled={busy} onChange={(event) => changeDraft({ ...draft, title: event.target.value })} />
    </details>
    {error && <p className={styles.formError} role="alert">{error}</p>}
    {!saved && <p className={styles.formError}>草稿暂时无法保存，请先不要关闭页面。</p>}
    <div className={styles.composerFooter}>
      <label><span className={styles.srOnly}>可见范围</span><select aria-label="可见范围" name="visibility" disabled={busy} value={draft.visibility} onChange={(event) => changeDraft({ ...draft, visibility: event.target.value as Draft["visibility"] })}><option value="public">公开</option><option value="unlisted">仅链接可见</option></select></label>
      <span className={styles.draftHint}>{draft.body.length > 0 ? `${draft.body.length} / 5000${saved ? " · 草稿" : ""}` : ""}</span>
      <button className={styles.primaryAction} disabled={!ready || busy}>{busy ? "发布中…" : "发布"}</button>
    </div>
  </form>;
}
