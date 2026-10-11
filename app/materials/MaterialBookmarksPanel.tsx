"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { matchesMaterialFilters, scoreMaterialSearch, type MaterialFilters, type SearchableMaterial } from "./materials-search";
import { MaterialBookmarkButton } from "./MaterialBookmarkControls";
import type { MaterialBookmarksController } from "./use-material-bookmarks";
import styles from "./materials.module.css";

type ResolvedBookmark = { materialId: string; material: (SearchableMaterial & { id: string }) | null };

export function MaterialBookmarksPanel({ bookmarks, filters }: {
  bookmarks: MaterialBookmarksController;
  filters: MaterialFilters;
}) {
  const [resolved, setResolved] = useState<{ owner: string; ids: string; items: ResolvedBookmark[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const ids = JSON.stringify(bookmarks.items.map((item) => item.materialId));
  const ready = bookmarks.status === "ready";
  const owner = bookmarks.userId;
  useEffect(() => {
    if (!ready || ids === "[]") return;
    const controller = new AbortController();
    void fetch("/api/materials/resolve", {
      method: "POST", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: `{"ids":${ids}}`,
    }).then(async (response) => {
      if (!response.ok) throw new Error("materials_unavailable");
      const data = await response.json() as { items: ResolvedBookmark[] };
      if (!controller.signal.aborted) {
        setFailed(false);
        setResolved({ owner, ids, items: data.items });
      }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ready, owner, ids, revision]);

  const current = ready && resolved?.owner === owner && resolved.ids === ids ? resolved.items : null;
  const visible = useMemo(() => (current ?? []).filter((item) => !item.material || matchesMaterialFilters(item.material, filters))
    .sort((left, right) => {
      if (!left.material || !right.material) return Number(!left.material) - Number(!right.material);
      return scoreMaterialSearch(right.material, filters.query ?? "") - scoreMaterialSearch(left.material, filters.query ?? "");
    }), [current, filters]);

  if (bookmarks.status === "anonymous") return <div className={styles.stateCard}><b>登录后查看已收藏资料</b><p>收藏按账号保存，可跨设备查看。</p><Link href="/?view=me">去登录</Link></div>;
  if (bookmarks.status === "error") return <div className={styles.stateCard} role="alert"><b>收藏暂时无法加载</b><button onClick={() => void bookmarks.refresh()}>重试</button></div>;
  if (ready && !bookmarks.items.length) return <div className={styles.stateCard}><b>还没有收藏资料</b><p>在资料列表或详情中点击“收藏”。</p></div>;
  if (failed) return <div className={styles.stateCard} role="alert"><b>收藏的资料信息暂时无法读取</b><button onClick={() => { setFailed(false); setRevision((value) => value + 1); }}>重新读取</button><p>也可直接移除收藏记录：</p>{bookmarks.items.map((item) => <div key={item.materialId}><code>{item.materialId}</code><MaterialBookmarkButton materialId={item.materialId} bookmarks={bookmarks} /></div>)}</div>;
  if (!current) return <div className={styles.stateCard} role="status">正在读取收藏…</div>;
  return <div className={styles.savedMaterials}>
    <p role="status">{visible.length} 份收藏 · 当前账号</p>
    {!visible.length && <p>没有符合当前筛选的收藏，试试清空搜索或筛选。</p>}
    <div role="list" aria-label="已收藏资料">
      {visible.map(({ materialId, material }) => <article key={materialId} role="listitem">
        <div>{material ? <><small>{material.courseTitle}</small><Link href={`/materials/${encodeURIComponent(materialId)}`}>{material.name}</Link></> : <><b>资料已下架或不存在</b><small>记录 {materialId} · 可移除这条收藏</small></>}</div>
        <MaterialBookmarkButton materialId={materialId} bookmarks={bookmarks} />
      </article>)}
    </div>
    <p>收藏不改变文件访问权限；请在详情中确认文件状态。</p>
  </div>;
}
