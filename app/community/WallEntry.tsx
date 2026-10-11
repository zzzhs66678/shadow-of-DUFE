"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { safeWallFeed, safeWallOrigin, wallFeedHref } from "./wall-navigation";
import styles from "./wall-entry.module.css";

const subscribe = (notify: () => void) => {
  window.addEventListener("popstate", notify);
  return () => window.removeEventListener("popstate", notify);
};
export function useWallSearch() { return useSyncExternalStore(subscribe, () => location.search, () => ""); }
export function useWallOrigin() { return safeWallOrigin(new URLSearchParams(useWallSearch()).get("returnTo")); }
const originKey = "dufe:wall-origin:v1";
export function WallEntry({ view = "me", compact = false }: { view?: string; compact?: boolean }) {
  const [href, setHref] = useState("/community");
  useEffect(() => {
    const frame = requestAnimationFrame(() => setHref(wallFeedHref(safeWallOrigin(location.pathname + location.search))));
    return () => cancelAnimationFrame(frame);
  }, [view]);
  return <a id={compact ? "wall-header-entry" : "wall-personal-entry"} className={compact ? styles.headerEntry : styles.personalEntry} href={href} onClick={event => {
    const target = safeWallOrigin(location.pathname + location.search);
    event.currentTarget.href = wallFeedHref(target);
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    try { sessionStorage.setItem(originKey, JSON.stringify({ target, y: scrollY, focus: event.currentTarget.id, time: Date.now() })); } catch {}
  }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h6"/></svg><span>东财墙</span>{!compact && <i aria-hidden="true">→</i>}</a>;
}
export function WallReturnLink({ origin, className }: { origin: string | null; className?: string }) {
  const target = safeWallOrigin(origin) || "/?view=home";
  const view = new URL(target, "https://local.invalid").searchParams.get("view") || "home";
  const label = ({ home: "今日", schedule: "课表", rooms: "空教室", catalog: "课程", me: "我的" } as Record<string, string>)[view];
  return <a className={className || styles.returnLink} href={target} onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    try {
      const entry = JSON.parse(sessionStorage.getItem(originKey) || "null");
      if (entry?.target === target && Date.now() - entry.time < 3_600_000) sessionStorage.setItem(originKey, JSON.stringify({ ...entry, restore: true }));
      const referrer = document.referrer ? new URL(document.referrer) : null;
      if (referrer?.origin === location.origin && referrer.pathname === "/" && safeWallOrigin(referrer.pathname + referrer.search) === target) { event.preventDefault(); history.back(); }
    } catch {}
  }}>← 返回{label}</a>;
}
export function WallLoginLink({ children, className }: { children: ReactNode; className?: string }) {
  const params = new URLSearchParams(useWallSearch());
  const target = wallFeedHref(params.get("returnTo"), params.get("sort") || params.get("from") || "latest");
  return <a href={`/?view=me&wallReturn=${encodeURIComponent(target)}`} className={className} onClick={event => {
    const current = new URLSearchParams(location.search);
    event.currentTarget.href = `/?view=me&wallReturn=${encodeURIComponent(wallFeedHref(current.get("returnTo"), current.get("sort") || current.get("from") || "latest"))}`;
  }}>{children}</a>;
}
export function WallOriginRestore({ authenticated }: { authenticated: boolean }) {
  useEffect(() => {
    const target = safeWallFeed(new URLSearchParams(location.search).get("wallReturn"));
    if (authenticated && target) { location.assign(`${target}#wall-body`); return; }
    let entry: { target: string; y: number; focus: string; time: number; restore?: boolean } | null = null;
    try { entry = JSON.parse(sessionStorage.getItem(originKey) || "null"); } catch {}
    if (!entry?.restore || entry.target !== safeWallOrigin(location.pathname + location.search) || Date.now() - entry.time > 3_600_000 || !Number.isFinite(entry.y)) return;
    try { sessionStorage.setItem(originKey, JSON.stringify({ ...entry, restore: false })); } catch {}
    const timers = [100, 500].map(delay => window.setTimeout(() => { window.scrollTo({ top: entry!.y, behavior: "instant" }); document.getElementById(entry!.focus)?.focus({ preventScroll: true }); }, delay));
    const stop = () => timers.forEach(clearTimeout);
    window.addEventListener("wheel", stop, { once: true }); window.addEventListener("touchstart", stop, { once: true });
    return () => { stop(); window.removeEventListener("wheel", stop); window.removeEventListener("touchstart", stop); };
  }, [authenticated]);
  return null;
}
