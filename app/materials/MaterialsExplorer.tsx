"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormField } from "../FormField";
import {
  loadPersonalCourseContext,
  type PersonalCourseContext,
} from "../personal-course-context";
import { PublicMasthead } from "../PublicMasthead";
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

type MaterialSearchState = {
  q?: string;
  course?: string;
  teacher?: string;
  type?: string;
  tag?: string;
  term?: string;
  year?: string;
};

export function MaterialsExplorer({ initialSearch = {} }: { initialSearch?: MaterialSearchState }) {
  const [query, setQuery] = useState(initialSearch.q ?? "");
  const [course, setCourse] = useState(initialSearch.course ?? "");
  const [teacher, setTeacher] = useState(initialSearch.teacher ?? "");
  const [type, setType] = useState(initialSearch.type ?? "");
  const [tag, setTag] = useState(initialSearch.tag ?? "");
  const [term, setTerm] = useState(initialSearch.term ?? "");
  const [year, setYear] = useState(initialSearch.year ?? "");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [ranking, setRanking] = useState<"personal" | "all">("personal");
  const [personalContext, setPersonalContext] = useState<PersonalCourseContext | null>(null);
  const [personalCatalog, setPersonalCatalog] = useState<Material[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const requestParams = useMemo(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (course) params.set("course", course);
    if (teacher) params.set("teacher", teacher);
    if (type) params.set("type", type);
    if (tag) params.set("tag", tag);
    if (term) params.set("term", term);
    if (year) params.set("year", year);
    params.set("limit", "24");
    return params;
  }, [course, query, tag, teacher, term, type, year]);

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
      .then((payload) => setPersonalCatalog(payload.materials ?? []))
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setPersonalCatalog(null);
      });
    return () => controller.abort();
  }, [personalContext]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      setLoadMoreError(false);
      try {
        const response = await fetch(`/api/materials?${requestParams}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("materials_unavailable");
        const payload = (await response.json()) as SearchResponse;
        setResult(payload);
        setActiveIndex(-1);
        setStatus("ready");

        const visibleParams = new URLSearchParams(requestParams);
        visibleParams.delete("limit");
        const nextUrl = visibleParams.size
          ? `/materials?${visibleParams}`
          : "/materials";
        window.history.replaceState(null, "", nextUrl);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setStatus("error");
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [requestParams, revision]);

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
    const needle = normalizeMatch(query);
    const matchesFilters = (material: Material) => {
      const searchText = normalizeMatch([
        material.name,
        material.courseTitle,
        ...material.courseIds,
        ...material.teachers,
        ...material.tags,
        material.category,
        material.kind,
        material.extension,
      ].join(" "));
      const equals = (left: string, right: string) =>
        normalizeMatch(left) === normalizeMatch(right);
      return (
        (!needle || searchText.includes(needle)) &&
        (!course || equals(material.courseTitle, course) || material.courseIds.some((id) => equals(id, course))) &&
        (!teacher || material.teachers.some((name) => equals(name, teacher))) &&
        (!type || equals(material.kind, type)) &&
        (!tag || material.tags.some((item) => equals(item, tag))) &&
        (!term || material.terms.some((item) => equals(item, term))) &&
        (!year || material.years.includes(Number(year)))
      );
    };
    const personalItems = (personalCatalog ?? []).filter(
      (material) => materialRelation(material) !== "other" && matchesFilters(material),
    );
    const sourceItems = [...personalItems, ...items].filter(
      (material, index, all) => all.findIndex((item) => item.id === material.id) === index,
    );
    const relevance = (material: Material) => {
      if (!needle) return 0;
      const name = normalizeMatch(material.name);
      const courseTitle = normalizeMatch(material.courseTitle);
      if (name === needle || courseTitle === needle) return 4;
      if (name.startsWith(needle) || courseTitle.startsWith(needle)) return 3;
      if (name.includes(needle) || courseTitle.includes(needle)) return 2;
      return 1;
    };
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

  function clearFilters() {
    setQuery("");
    setCourse("");
    setTeacher("");
    setType("");
    setTag("");
    setTerm("");
    setYear("");
    inputRef.current?.focus();
  }

  async function loadMore() {
    if (!result?.hasMore || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const params = new URLSearchParams(requestParams);
      params.set("offset", String(result.items.length));
      const response = await fetch(`/api/materials?${params}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("materials_unavailable");
      const payload = (await response.json()) as SearchResponse;
      setResult((current) => current
        ? { ...payload, items: [...current.items, ...payload.items] }
        : payload);
    } catch {
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const hasFilters = Boolean(query || course || teacher || type || tag || term || year);
  const hasPersonalRanking = Boolean(
    personalContext &&
      (personalContext.currentCourseCodes.length ||
        personalContext.currentCourseNames.length ||
        personalContext.planCourseCodes.length ||
        personalContext.planCourseNames.length),
  );
  const filters = result?.filters ?? emptyFilters;

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const count = rankedItems.length;
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
    <main className={styles.page} id="main-content">
      <PublicMasthead
        navigationLabel="资料页导航"
        items={[
          { href: "/?view=catalog", label: "课程" },
          { href: "/teachers", label: "教师" },
          { href: "/materials", label: "资料", current: true },
          { href: "/?view=schedule", label: "我的课表", showOnMobile: false },
        ]}
      />

      <section className={styles.hero} aria-labelledby="materials-title">
        <div className={styles.indexMark} aria-hidden="true">
          <span>ARCHIVE</span>
          <b>{String(result?.catalog.total ?? 457).padStart(3, "0")}</b>
        </div>
        <div className={styles.heroCopy}>
          <span>东财课程资料档案</span>
          <h1 id="materials-title">按课程、教师或文件名找资料</h1>
          <p>支持预览与下载。</p>
        </div>
        <label className={styles.searchField}>
          <span>搜索档案</span>
          <input
            ref={inputRef}
            type="search"
            name="material-search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="输入课程、教师或资料标题…"
          />
          <kbd>ESC 清空</kbd>
        </label>
      </section>

      <section className={styles.workspace}>
        <aside className={styles.filters} aria-label="资料筛选">
          <header>
            <span>缩小范围</span>
            {hasFilters && <button onClick={clearFilters}>全部清空</button>}
          </header>
          <FormField label="课程" className={styles.filterField}>
            <select value={course} onChange={(event) => setCourse(event.target.value)}>
              <option value="">全部课程</option>
              {filters.courses.map((item) => <option key={item}>{item}</option>)}
            </select>
          </FormField>
          <FormField label="教师" className={styles.filterField}>
            <select value={teacher} onChange={(event) => setTeacher(event.target.value)}>
              <option value="">全部教师</option>
              {filters.teachers.map((item) => <option key={item}>{item}</option>)}
            </select>
          </FormField>
          <FormField label="资料类型" className={styles.filterField}>
            <select value={type} onChange={(event) => setType(event.target.value)}>
              <option value="">全部类型</option>
              {filters.types.map((item) => <option key={item}>{item}</option>)}
            </select>
          </FormField>
          <div className={styles.filterPair}>
            <FormField label="学期" className={styles.filterField}>
              <select value={term} onChange={(event) => setTerm(event.target.value)}>
                <option value="">全部</option>
                {filters.terms.map((item) => <option key={item} value={item}>{termLabel(item)}</option>)}
              </select>
            </FormField>
            <FormField label="年级" className={styles.filterField}>
              <select value={year} onChange={(event) => setYear(event.target.value)}>
                <option value="">全部</option>
                {filters.years.map((item) => <option key={item} value={item}>大{"一二三四"[item - 1]}</option>)}
              </select>
            </FormField>
          </div>
          <p>↑↓ 浏览，Enter 打开，Esc 清空。</p>
        </aside>

        <div className={styles.resultsPanel}>
          <header className={styles.resultHeader}>
            <div>
              <span>资料索引</span>
              <strong>
                {status === "loading" ? "正在检索…" : `${result?.total ?? 0} 份结果`}
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
            ) : (
              <i aria-hidden="true">{hasFilters ? "SEARCH / ACTIVE" : "OPEN / SHELF"}</i>
            )}
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
              <b>这一组条件下没有资料</b>
              <p>清空筛选或换个关键词。</p>
              <button onClick={clearFilters}>回到全部资料</button>
            </div>
          )}

          {status === "ready" && Boolean(result?.items.length) && (
            <div className={styles.results} id="material-results" role="list" aria-label="资料搜索结果">
              {rankedItems.map((material, index) => {
                const relation = materialRelation(material);
                return (
                  <article
                    key={material.id}
                    className={activeIndex === index ? styles.active : ""}
                    role="listitem"
                  >
                    <div className={styles.fileMark} aria-hidden="true">
                      <span>{String(index + 1).padStart(2, "0")}</span>
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
                        id={`material-result-${index}`}
                        href={`/materials/${encodeURIComponent(material.id)}`}
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
        </div>
      </section>
    </main>
  );
}
