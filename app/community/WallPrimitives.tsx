"use client";

import { useRef, type ReactNode } from "react";
import styles from "./community.module.css";

export function WallIcon({ name }: { name: "reply" | "heart" | "bookmark" | "share" | "write" | "back" | "more" }) {
  const paths = {
    reply: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
    heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z",
    bookmark: "M6 3h12v18l-6-4-6 4V3Z",
    share: "M12 16V3m-5 5 5-5 5 5M5 13v7h14v-7",
    write: "m16 3 5 5-12 12H4v-5L16 3Zm-3 3 5 5",
    back: "m12 4-8 8 8 8M4 12h16",
    more: "M5 12h.01M12 12h.01M19 12h.01",
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "more" ? 3 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function PostMenu({ children, label = "帖子更多操作" }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  return <details className={styles.postMenu} ref={ref} onKeyDown={(event) => {
    if (event.key === "Escape" && ref.current?.open) {
      event.preventDefault();
      ref.current.open = false;
      ref.current.querySelector("summary")?.focus();
    }
  }} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null) && ref.current) ref.current.open = false;
  }}>
    <summary aria-label={label}><WallIcon name="more" /></summary>
    <div className={styles.postMenuItems} onClick={(event) => {
      if ((event.target as HTMLElement).closest("button,a") && ref.current) ref.current.open = false;
    }}>{children}</div>
  </details>;
}

export function hasDistinctTitle(topic: { title: string; body: string }) {
  const title = topic.title.trim().replace(/…$/u, "");
  return Boolean(title && !topic.body.trim().startsWith(title));
}

export async function shareWallPost(id: string, title: string) {
  const url = `${window.location.origin}/community/topics/${encodeURIComponent(id)}`;
  if (navigator.share) await navigator.share({ title, url });
  else if (navigator.clipboard) await navigator.clipboard.writeText(url);
  else throw new Error("share_unavailable");
}
