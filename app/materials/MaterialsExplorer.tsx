"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FormField } from "../FormField";
import {
  loadPersonalCourseContext,
  type PersonalCourseContext,
} from "../personal-course-context";
import { PublicMasthead } from "../PublicMasthead";
import { safeCourseReturn, withCourseReturn } from "../discovery-navigation";
import { useCourseReturn } from "../CourseReturnLink";
import { matchesMaterialFilters, scoreMaterialSearch } from "./materials-search";
import { useMaterialBookmarks } from "./use-material-bookmarks";
import { MaterialBookmarkButton } from "./MaterialBookmarkControls";
import { MaterialBookmarksPanel } from "./MaterialBookmarksPanel";
import styles from "./materials.module.css";

type Material = {
  id: string;
  courseTitle: string;
  courseIds: string[];
  teachers: string[];
  colleges: string[];
  terms: string[];
  years: number[];
  tags: string[];
  category: string;
  name: string;
  kind: string;
  extension: string;
  sizeBytes: number;
  catalogedAt: string;
  description: string;
  previewable: boolean;
  previewUrl: string;
  downloadUrl: string;
};

type Filters = {
  courses: string[];
  teachers: string[];
  types: string[];
  tags: string[];
  terms: string[];
  years: number[];
};

type SearchResponse = {
  items: Material[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  filters: Filters;
  catalog: { total: number; generatedAt: string };
};

const emptyFilters: Filters = {
  courses: [],
  teachers: [],
  types: [],
  tags: [],
  terms: [],
  years: [],
};

const compactFiltersQuery = "(max-width: 980px)";

function subscribeCompactFilters(onChange: () => void) {
  const media = window.matchMedia(compactFiltersQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getCompactFilters() {
  return window.matchMedia(compactFiltersQuery).matches;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatCatalogDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "收录时间未标注";
  return `站内收录于 ${new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(date)}`;
}

function termLabel(term: string) {
  return term === "fall" ? "上学期" : term === "spring" ? "下学期" : term;
}

function normalizeMatch(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·._()（）【】\[\]《》<>/\\-]+/g, "");
}

export type MaterialSearchState = {
  q?: string;
  course?: string;
  teacher?: string;
  type?: string;
  tag?: string;
  term?: string;
  year?: string;
  saved?: string;
};

export function MaterialsExplorer({
  initialSearch = {},
  embedded = false,
  onSearchChange,
}: {
  initialSearch?: MaterialSearchState;
  embedded?: boolean;
  onSearchChange?: (search: MaterialSearchState) => void;
}) {
  const courseReturn = useCourseReturn();
  const bookmarks = useMaterialBookmarks();
  const [search, setSearch] = useState(initialSearch);
  const { q: query = "", course = "", teacher = "", type = "", tag = "", term = "", year = "", saved = "" } = search;
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const compactFilters = useSyncExternalStore(subscribeCompactFilters, getCompactFilters, () => false);
  const filtersExpanded = !compactFilters || filtersOpen;
  const [ranking, setRanking] = useState<"personal" | "all">("personal");
  const [personalContext, setPersonalContext] = useState<PersonalCourseContext | null>(null);
  const [personalCatalog, setPersonalCatalog] = useState<Material[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const generation = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const moreController = useRef<AbortController | null>(null);
  const onSearchChangeRef = useRef(onSearchChange);
  const instanceId = useId();
  const titleId = embedded ? `${instanceId}-materials-title` : "materials-title";
  const Root = embedded ? "section" : "main";

  const invalidateRequests = useCallback(() => {
    generation.current += 1;
    searchController.current?.abort();
    moreController.current?.abort();
    searchController.current = null;
    moreController.current = null;
  }, []);

  const requestParams = useMemo(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (course) params.set("course", course);
    if (teacher) params.set("teacher", teacher);
    if (type) params.set("type", type);
    if (tag) params.set("tag", tag);
    if (term) params.set("term", term);
    if (year) params.set("year", year);
    if (saved === "1") params.set("saved", "1");
    params.set("limit", "24");
    return params;
  }, [course, query, tag, teacher, term, type, year, saved]);

  useEffect(() => {
    onSearchChangeRef.current = onSearchChange;
  }, [onSearchChange]);

  useEffect(() => {
    if (!embedded) return;
    const visibleParams = new URLSearchParams(requestParams);
    visibleParams.delete("limit");
    onSearchChangeRef.current?.(Object.fromEntries(visibleParams));
  }, [embedded, requestParams]);

  useEffect(() => {
    let live = true;
    void loadPersonalCourseContext().then((context) => {
      if (live) setPersonalContext(context);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const hasCourseContext = Boolean(
      personalContext &&
        (personalContext.currentCourseCodes.length ||
          personalContext.currentCourseNames.length ||
          personalContext.planCourseCodes.length ||
          personalContext.planCourseNames.length),
    );
    if (!hasCourseContext) return;
    const controller = new AbortController();
    void fetch("/data/resource-manifest.json", {
      cache: "force-cache",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("material_manifest_unavailable");
        return response.json() as Promise<{ materials?: Material[] }>;
      })
      .then((payload) => {
        if (!controller.signal.aborted) setPersonalCatalog(payload.materials ?? []);
      })
      .catch((error) => {
        if (!controller.signal.aborted && (error as Error).name !== "AbortError") setPersonalCatalog(null);
      });
    return () => controller.abort();
  }, [personalContext]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    searchController.current = controller;
    const timer = window.setTimeout(async () => {
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      setStatus("loading");
      setLoadingMore(false);
      setLoadMoreError(false);
      try {
        const response = await fetch(`/api/materials?${requestParams}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("materials_unavailable");
        const payload = (await response.json()) as SearchResponse;
        if (controller.signal.aborted || currentGeneration !== generation.current) return;
        setResult(payload);
        setActiveIndex(-1);
        setStatus("ready");

        if (!embedded) {
          const visibleParams = new URLSearchParams(requestParams);
          const returnTo = safeCourseReturn(new URLSearchParams(window.location.search).get("returnTo"));
          if (returnTo) visibleParams.set("returnTo", returnTo);
          visibleParams.delete("limit");
          const nextUrl = visibleParams.size
            ? `/materials?${visibleParams}`
            : "/materials";
          window.history.replaceState(null, "", nextUrl);
        }
      } catch (error) {
        if (!controller.signal.aborted && currentGeneration === generation.current && (error as Error).name !== "AbortError") {
          setStatus("error");
        }
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      invalidateRequests();
    };
  }, [embedded, invalidateRequests, requestParams, revision]);

  const personalCourseCodes = useMemo(
    () => new Set((personalContext?.currentCourseCodes ?? []).map(normalizeMatch)),
    [personalContext],
  );
  const personalCourseNames = useMemo(
    () => new Set((personalContext?.currentCourseNames ?? []).map(normalizeMatch)),
    [personalContext],
  );
  const planCourseCodes = useMemo(
    () => new Set((personalContext?.planCourseCodes ?? []).map(normalizeMatch)),
    [personalContext],
  );
  const planCourseNames = useMemo(
    () => new Set((personalContext?.planCourseNames ?? []).map(normalizeMatch)),
    [personalContext],
  );
  const materialRelation = useCallback((material: Material) => {
    const codes = material.courseIds.map(normalizeMatch);
    const title = normalizeMatch(material.courseTitle);
    if (
      codes.some((code) => personalCourseCodes.has(code)) ||
      personalCourseNames.has(title)
    ) {
      return "current" as const;
    }
    if (
      codes.some((code) => planCourseCodes.has(code)) ||
      planCourseNames.has(title)
    ) {
      return "plan" as const;
    }
    return "other" as const;
  }, [personalCourseCodes, personalCourseNames, planCourseCodes, planCourseNames]);
  const rankedItems = useMemo(() => {
    const items = result?.items ?? [];
    if (ranking === "all") return items;
    const matchesFilters = (material: Material) =>
      matchesMaterialFilters(material, { query, course, teacher, type, tag, term, year });
    const personalItems = (personalCatalog ?? []).filter(
      (material) => materialRelation(material) !== "other" && matchesFilters(material),
    );
    const sourceItems = [...personalItems, ...items].filter(
      (material, index, all) => all.findIndex((item) => item.id === material.id) === index,
    );
    const relevance = (material: Material) => scoreMaterialSearch(material, query.trim().slice(0, 80));
    return sourceItems
      .map((material, index) => ({ material, index }))
      .sort((left, right) => {
        const textOrder = relevance(right.material) - relevance(left.material);
        if (textOrder) return textOrder;
        const relationScore = (material: Material) => {
          const relation = materialRelation(material);
          return relation === "current" ? 2 : relation === "plan" ? 1 : 0;
        };
        const personalOrder =
          relationScore(right.material) - relationScore(left.material);
        return personalOrder || left.index - right.index;
      })
      .map(({ material }) => material)
      .slice(0, items.length);
  }, [course, materialRelation, personalCatalog, query, ranking, result, tag, teacher, term, type, year]);

  function changeSearch(key: keyof MaterialSearchState, value: string) {
    if ((search[key] ?? "") === value) return;
    // Invalidate at the interaction, including the debounce window before the next effect.
    invalidateRequests();
    setStatus("loading");
    setLoadingMore(false);
    setSearch((current) => ({ ...current, [key]: value }));
  }

  function clearFilters() {
    if (hasFilters) {
      invalidateRequests();
      setStatus("loading");
      setLoadingMore(false);
      setSearch((current) => current.saved === "1" ? { saved: "1" } : {});
    }
    inputRef.current?.focus();
  }

  async function loadMore() {
    if (status !== "ready" || !result?.hasMore || loadingMore || moreController.current) return;
    const currentGeneration = generation.current;
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const params = new URLSearchParams(requestParams);
      params.set("offset", String(result.items.length));
      const response = await fetch(`/api/materials?${params}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("materials_unavailable");
      const payload = (await response.json()) as SearchResponse;
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      setResult((current) => {
        if (controller.signal.aborted || currentGeneration !== generation.current) return current;
        return current ? { ...payload, items: [...current.items, ...payload.items] } : payload;
      });
    } catch {
      if (!controller.signal.aborted && currentGeneration === generation.current) setLoadMoreError(true);
    } finally {
      if (!controller.signal.aborted && currentGeneration === generation.current) {
        moreController.current = null;
        setLoadingMore(false);
      }
    }
  }

  const hasFilters = Boolean(query || course || teacher || type || tag || term || year);
  const selectedFilterCount = [course, teacher, type, tag, term, year].filter(Boolean).length;
  const hasPersonalRanking = Boolean(
    personalContext &&
      (personalContext.currentCourseCodes.length ||
        personalContext.currentCourseNames.length ||
        personalContext.planCourseCodes.length ||
        personalContext.planCourseNames.length),
  );
  const filters = result?.filters ?? emptyFilters;

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const count = status === "ready" && saved !== "1" ? rankedItems.length : 0;
    if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      const next = activeIndex >= 0 ? activeIndex : 0;
      setActiveIndex(next);
      resultRefs.current[next]?.focus();
    } else if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      const next = activeIndex >= 0 ? activeIndex : count - 1;
      setActiveIndex(next);
      resultRefs.current[next]?.focus();
    } else if (event.key === "Enter" && count) {
      event.preventDefault();
      resultRefs.current[activeIndex >= 0 ? activeIndex : 0]?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      clearFilters();
    }
  }

  function handleResultKeyDown(
    index: number,
    event: React.KeyboardEvent<HTMLAnchorElement>,
  ) {
    const count = rankedItems.length;
    if (!count) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        event.key === "ArrowDown"
          ? (index + 1) % count
          : (index - 1 + count) % count;
      setActiveIndex(next);
      resultRefs.current[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      clearFilters();
    }
  }

  return (
    <Root
      className={`${styles.page}${embedded ? ` ${styles.embedded}` : ""}`}
      id={embedded ? undefined : "main-content"}
      aria-labelledby={embedded ? titleId : undefined}
    >
      {!embedded && <PublicMasthead
        navigationLabel="资料页导航"
        items={[
          { href: "/?view=catalog", label: "课程" },
          { href: "/teachers", label: "教师" },
          { href: "/materials", label: "资料", current: true },
          { href: "/?view=schedule", label: "我的课表", showOnMobile: false },
        ]}
      />}

      <div className={embedded ? styles.embeddedSearch : styles.hero}>
        {embedded ? <h2 id={titleId} className={styles.visuallyHidden}>学习资料</h2> : <div className={styles.heroCopy}>
          <h1 id={titleId}>学习资料</h1>
        </div>}
        <label className={styles.searchField}>
          <span>搜索资料</span>
          <input
            ref={inputRef}
            type="search"
            name="material-search"
            autoComplete="off"
            value={query}
            onChange={(event) => changeSearch("q", event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="输入课程、教师或资料标题…"
          />
          <kbd>ESC 清空</kbd>
        </label>
      </div>

      <section className={styles.workspace}>
        <aside className={styles.filters} aria-label="资料筛选">
          {compactFilters && (
            <button
              type="button"
              className={styles.filterToggle}
              aria-expanded={filtersExpanded}
              aria-controls={`${instanceId}-filters`}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <span>筛选资料{selectedFilterCount ? ` · 已选 ${selectedFilterCount}` : ""}</span>
              <span aria-hidden="true">{filtersExpanded ? "收起" : "展开"}</span>
            </button>
          )}
          <div id={`${instanceId}-filters`} className={styles.filterContent} hidden={!filtersExpanded}>
          <header>
            <span>缩小范围</span>
            {hasFilters && <button onClick={clearFilters}>全部清空</button>}
          </header>
          <FormField label="课程" className={styles.filterField}>
            <select value={course} onChange={(event) => changeSearch("course", event.target.value)}>
              <option value="">全部课程</option>
              {course && !filters.courses.includes(course) && <option value={course}>{course}</option>}
              {filters.courses.map((item) => <option key={item}>{item}</option>)}
            </select>
          </FormField>
          <FormField label="教师" className={styles.filterField}>
            <select value={teacher} onChange={(event) => changeSearch("teacher", event.target.value)}>
              <option value="">全部教师</option>
              {teacher && !filters.teachers.includes(teacher) && <option value={teacher}>{teacher}</option>}
              {filters.teachers.map((item) => <option key={item}>{item}</option>)}
            </select>
          </FormField>
          <FormField label="资料类型" className={styles.filterField}>
            <select value={type} onChange={(event) => changeSearch("type", event.target.value)}>
              <option value="">全部类型</option>
              {type && !filters.types.includes(type) && <option value={type}>{type}</option>}
              {filters.types.map((item) => <option key={item}>{item}</option>)}
            </select>
          </FormField>
          <FormField label="标签" className={styles.filterField}>
            <select value={tag} onChange={(event) => changeSearch("tag", event.target.value)}>
              <option value="">全部标签</option>
              {tag && !filters.tags.includes(tag) && <option value={tag}>{tag}</option>}
              {filters.tags.map((item) => <option key={item}>{item}</option>)}
            </select>
          </FormField>
          <div className={styles.filterPair}>
            <FormField label="学期" className={styles.filterField}>
              <select value={term} onChange={(event) => changeSearch("term", event.target.value)}>
                <option value="">全部</option>
                {term && !filters.terms.includes(term) && <option value={term}>{termLabel(term)}</option>}
                {filters.terms.map((item) => <option key={item} value={item}>{termLabel(item)}</option>)}
              </select>
            </FormField>
            <FormField label="年级" className={styles.filterField}>
              <select value={year} onChange={(event) => changeSearch("year", event.target.value)}>
                <option value="">全部</option>
                {year && !filters.years.includes(Number(year)) && <option value={year}>{year}</option>}
                {filters.years.map((item) => <option key={item} value={item}>大{"一二三四"[item - 1]}</option>)}
              </select>
            </FormField>
          </div>
          <p>↑↓ 浏览，Enter 打开，Esc 清空。</p>
          </div>
        </aside>

        <div className={styles.resultsPanel}>
          <div className={styles.bookmarkTabs} role="group" aria-label="资料范围">
            <button aria-pressed={saved !== "1"} onClick={() => changeSearch("saved", "")}>全部</button>
            <button aria-pressed={saved === "1"} onClick={() => { changeSearch("saved", "1"); void bookmarks.refresh(); }}>已收藏</button>
          </div>
          <p className={styles.bookmarkFeedback} role="status">{bookmarks.feedback}</p>
          {saved === "1" ? <MaterialBookmarksPanel bookmarks={bookmarks} filters={{ query, course, teacher, type, tag, term, year }} /> : <>
          <header className={styles.resultHeader}>
            <div>
              <span>资料索引</span>
              <strong role="status" aria-live="polite">
                {status === "loading" ? "正在检索…" : status === "error" ? "检索未完成" : `${result?.total ?? 0} 份结果`}
              </strong>
            </div>
            {hasPersonalRanking ? (
              <div className={styles.rankSwitch} aria-label="资料排序">
                <button
                  aria-pressed={ranking === "personal"}
                  onClick={() => setRanking("personal")}
                >
                  与我相关
                </button>
                <button
                  aria-pressed={ranking === "all"}
                  onClick={() => setRanking("all")}
                >
                  全站排序
                </button>
              </div>
            ) : null}
          </header>

          {status === "loading" && (
            <div className={styles.loading} role="status" aria-live="polite">
              {[0, 1, 2, 3].map((item) => <i key={item} />)}
              <span>正在搜索</span>
            </div>
          )}

          {status === "error" && (
            <div className={styles.stateCard} role="alert">
              <b>资料暂时无法加载</b>
              <p>检查网络后重试。</p>
              <button onClick={() => setRevision((value) => value + 1)}>重新加载</button>
            </div>
          )}

          {status === "ready" && result?.items.length === 0 && (
            <div className={styles.stateCard}>
              <b>没有找到符合条件的资料</b>
              <p>清空筛选或换个关键词。</p>
              <button onClick={clearFilters}>回到全部资料</button>
            </div>
          )}

          {status === "ready" && Boolean(result?.items.length) && (
            <div className={styles.results} id={embedded ? `${instanceId}-material-results` : "material-results"} role="list" aria-label="资料搜索结果">
              {rankedItems.map((material, index) => {
                const relation = materialRelation(material);
                return (
                  <article
                    key={material.id}
                    className={activeIndex === index ? styles.active : ""}
                    role="listitem"
                  >
                    <div className={styles.fileMark} aria-hidden="true">
                      <b>{material.extension.replace(".", "").slice(0, 4).toUpperCase()}</b>
                    </div>
                    <div className={styles.resultCopy}>
                      <p>
                        <span>{material.courseTitle}</span>
                        {relation !== "other" && (
                          <i className={styles.personalTag}>
                            {relation === "current" ? "本学期" : "培养方案"}
                          </i>
                        )}
                        <i>{material.kind}</i>
                        <i>{formatFileSize(material.sizeBytes)}</i>
                      </p>
                      <Link
                        ref={(node) => { resultRefs.current[index] = node; }}
                        id={`${embedded ? `${instanceId}-` : ""}material-result-${index}`}
                        href={withCourseReturn(`/materials/${encodeURIComponent(material.id)}`, courseReturn ?? undefined)}
                        onFocus={() => setActiveIndex(index)}
                        onKeyDown={(event) => handleResultKeyDown(index, event)}
                      >
                        {material.name}
                      </Link>
                      <small>
                        {material.teachers.length ? material.teachers.join(" / ") : "教师未标注"}
                        {material.description ? ` · ${material.description}` : ""}
                        {` · ${formatCatalogDate(material.catalogedAt)}`}
                      </small>
                    </div>
                    <div className={styles.quickActions}>
                      <MaterialBookmarkButton materialId={material.id} bookmarks={bookmarks} />
                      {material.previewable && <a href={material.previewUrl} target="_blank" rel="noreferrer">预览</a>}
                      <a href={material.downloadUrl} download>下载</a>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {status === "ready" && result?.hasMore && (
            <div className={styles.loadMoreArea}>
              {loadMoreError && <p role="alert">暂时无法继续加载。</p>}
              <button
                className={styles.loadMore}
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "正在继续读取" : loadMoreError ? "重试" : "继续查看"}
              </button>
            </div>
          )}
          </>}
        </div>
      </section>
    </Root>
  );
}
