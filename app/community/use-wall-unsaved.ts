"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

// Per-document fallback also covers browsers that reject sessionStorage. These
// maps are only used by client editors after their account has been confirmed.
const memoryDrafts = new Map<string, unknown>();
const pendingScopes = new Set<string>();
const pendingListeners = new Set<() => void>();
const subscribePending = (listener: () => void) => {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
};
export function useWallSending(scope: string) {
  const pending = useSyncExternalStore(subscribePending, () => pendingScopes.has(scope), () => false);
  const setPending = useCallback((next: boolean) => {
    if (next) pendingScopes.add(scope);
    else pendingScopes.delete(scope);
    pendingListeners.forEach((listener) => listener());
  }, [scope]);
  return [pending, setPending] as const;
}

// Callers must remount on a scope change; never hydrate an account's draft into
// an already mounted editor belonging to another account.
export function useWallDraft<T>(key: string | null, empty: T, parse: (value: unknown) => T, hasContent: (value: T) => boolean) {
  const read = useCallback(() => {
    if (key && memoryDrafts.has(key)) return parse(memoryDrafts.get(key));
    try {
      const saved = key ? window.sessionStorage.getItem(key) : null;
      return saved ? parse(JSON.parse(saved)) : empty;
    } catch { return empty; }
  }, [key, empty, parse]);
  const [value, setValue] = useState(read);
  const current = useRef(value);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const write = useCallback((next: T) => {
    if (!key) return;
    memoryDrafts.set(key, next);
    try {
      if (hasContent(next)) window.sessionStorage.setItem(key, JSON.stringify(next));
      else window.sessionStorage.removeItem(key);
    } catch { /* beforeunload still protects a draft when storage is unavailable. */ }
  }, [key, hasContent]);
  const update = useCallback((change: (previous: T) => T) => {
    const next = change(current.current);
    current.current = next;
    // Persist in the input handler, not a passive effect: Back can unmount us
    // before effects run. Nothing pushes, replaces or cancels browser history.
    write(next);
    setValue(next);
  }, [write]);
  const settle = useCallback((change: (previous: T) => T) => {
    // A request may succeed after Back/account switching. Clear only the
    // submitted snapshot, leaving any newer draft in this scope untouched.
    if (mounted.current) update(change);
    else {
      write(change(read()));
      window.dispatchEvent(new CustomEvent("wall-topic-draft-settled", { detail: key }));
    }
  }, [key, read, update, write]);
  useEffect(() => {
    const settled = (event: Event) => {
      if ((event as CustomEvent).detail !== key) return;
      const next = read();
      current.current = next;
      setValue(next);
    };
    window.addEventListener("wall-topic-draft-settled", settled);
    return () => window.removeEventListener("wall-topic-draft-settled", settled);
  }, [key, read]);
  return [value, update, settle] as const;
}

export function useWallUnsaved(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  useLayoutEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => {
    function leave(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault(); event.returnValue = "";
    }
    function follow(event: MouseEvent) {
      if (!dirtyRef.current) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented || link.hasAttribute("download")) return;
      const destination = new URL(link.href, window.location.href);
      if (destination.pathname === location.pathname && destination.search === location.search) return;
      if (!window.confirm("还有没发出的内容，确定离开吗？")) { event.preventDefault(); event.stopPropagation(); }
    }
    window.addEventListener("beforeunload", leave);
    document.addEventListener("click", follow, true);
    return () => { window.removeEventListener("beforeunload", leave); document.removeEventListener("click", follow, true); };
  }, []);
}
