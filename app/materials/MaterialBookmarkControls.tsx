"use client";

import Link from "next/link";
import { useMaterialBookmarks, type MaterialBookmarksController } from "./use-material-bookmarks";
import styles from "./materials.module.css";

export function MaterialBookmarkButton({ materialId, bookmarks }: {
  materialId: string;
  bookmarks: MaterialBookmarksController;
}) {
  if (bookmarks.status === "anonymous") return <Link className={styles.bookmarkButton} href="/?view=me">登录收藏</Link>;
  if (bookmarks.status === "error") return <button className={styles.bookmarkButton} onClick={() => void bookmarks.refresh()}>重试收藏状态</button>;
  const saved = bookmarks.items.some((item) => item.materialId === materialId);
  return <button
    type="button"
    className={styles.bookmarkButton}
    aria-pressed={saved}
    disabled={bookmarks.status === "loading" || Boolean(bookmarks.busyId)}
    onClick={() => void bookmarks.setBookmark(materialId, !saved)}
  >{bookmarks.status === "loading" ? "读取收藏…" : bookmarks.busyId === materialId ? "保存中…" : saved ? "取消收藏" : "收藏"}</button>;
}

export function MaterialDetailBookmark({ materialId }: { materialId: string }) {
  const bookmarks = useMaterialBookmarks();
  return <div className={styles.bookmarkDetail}>
    <MaterialBookmarkButton materialId={materialId} bookmarks={bookmarks} />
    <Link href="/materials?saved=1">已收藏资料</Link>
    <p>{bookmarks.status === "anonymous" ? "登录后可跨设备查看收藏。" : "收藏保存在当前账号，不改变文件访问权限。"}</p>
    <span role="status">{bookmarks.feedback}</span>
  </div>;
}
