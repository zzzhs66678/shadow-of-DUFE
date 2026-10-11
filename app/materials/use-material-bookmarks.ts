"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Bookmark = { materialId: string; bookmarkedAt: string };
type BookmarkState = {
  status: "loading" | "ready" | "anonymous" | "error";
  userId: string;
  items: Bookmark[];
};
const empty: BookmarkState = { status: "loading", userId: "", items: [] };
export const MATERIAL_BOOKMARK_REFRESH_EVENT = "dufesh:material-bookmarks-refresh";

// Account data stays in component memory. No localStorage, anonymous merge or
// PersonalSyncState extension; the server is the cross-device source of truth.
export function useMaterialBookmarks() {
  const [state, setState] = useState<BookmarkState>(empty);
  const [busyId, setBusyId] = useState("");
  const [feedback, setFeedback] = useState("");
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);

  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    writing.current = false;
    setBusyId("");
    setState(empty); // Never leave another account's references on screen while checking.
    try {
      const response = await fetch("/api/material-bookmarks", {
        credentials: "same-origin", cache: "no-store", signal: request.signal,
        headers: { Accept: "application/json" },
      });
      if (request.signal.aborted || epoch !== generation.current) return;
      if (response.status === 401) {
        setState({ ...empty, status: "anonymous" });
        return;
      }
      if (!response.ok) throw new Error("bookmarks_unavailable");
      const data = await response.json() as { userId?: string; items?: Bookmark[] };
      if (!data.userId || !Array.isArray(data.items) || data.items.length > 1000 ||
          data.items.some((item) => !/^[0-9a-f]{20}$/.test(item.materialId))) throw new Error("invalid_bookmarks");
      if (request.signal.aborted || epoch !== generation.current) return;
      setState({ status: "ready", userId: data.userId, items: data.items });
    } catch {
      if (!request.signal.aborted && epoch === generation.current) setState({ ...empty, status: "error" });
    }
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void refresh());
    const reload = () => { void refresh(); };
    const visibility = () => {
      if (document.visibilityState === "visible") reload();
      else {
        generation.current += 1;
        controller.current?.abort();
        setState(empty);
      }
    };
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel(MATERIAL_BOOKMARK_REFRESH_EVENT);
      channel.current.onmessage = reload;
    }
    window.addEventListener("focus", reload);
    window.addEventListener("pageshow", reload);
    window.addEventListener("storage", reload);
    window.addEventListener("dufesh:auth-changed", reload);
    window.addEventListener(MATERIAL_BOOKMARK_REFRESH_EVENT, reload);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(frame);
      generation.current += 1;
      controller.current?.abort();
      channel.current?.close();
      channel.current = null;
      window.removeEventListener("focus", reload);
      window.removeEventListener("pageshow", reload);
      window.removeEventListener("storage", reload);
      window.removeEventListener("dufesh:auth-changed", reload);
      window.removeEventListener(MATERIAL_BOOKMARK_REFRESH_EVENT, reload);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh]);

  async function setBookmark(materialId: string, active: boolean) {
    if (state.status !== "ready" || writing.current) return;
    writing.current = true;
    const epoch = generation.current;
    const owner = state.userId;
    const signal = controller.current?.signal;
    setBusyId(materialId);
    setFeedback("");
    try {
      const response = await fetch(`/api/material-bookmarks/${encodeURIComponent(materialId)}`, {
        method: active ? "PUT" : "DELETE", credentials: "same-origin", cache: "no-store", signal,
        headers: { "Content-Type": "application/json", "X-Material-Bookmark-Owner": owner },
        body: "{}",
      });
      const data = await response.json() as { userId?: string; error?: string };
      if (signal?.aborted || epoch !== generation.current) return;
      if (response.status === 401 || data.error === "material_bookmark_account_changed") {
        setFeedback("登录状态已变化，请确认当前账号后重试。");
        await refresh();
        return;
      }
      if (!response.ok) {
        setFeedback(response.status === 429 ? "操作较频繁，请稍后重试。" :
          data.error === "material_bookmark_limit" ? "收藏已达 1000 份，请先移除一些资料。" : "收藏未能保存，请重试。");
        return;
      }
      if (data.userId !== owner) { await refresh(); return; }
      setFeedback(active ? "已收藏到当前账号。" : "已取消收藏。");
      channel.current?.postMessage("refresh");
      window.dispatchEvent(new Event(MATERIAL_BOOKMARK_REFRESH_EVENT));
    } catch {
      if (!signal?.aborted && epoch === generation.current) setFeedback("收藏未能保存，请检查网络后重试。");
    } finally {
      if (epoch === generation.current) {
        writing.current = false;
        setBusyId("");
      }
    }
  }

  return { ...state, busyId, feedback, refresh, setBookmark };
}

export type MaterialBookmarksController = ReturnType<typeof useMaterialBookmarks>;
