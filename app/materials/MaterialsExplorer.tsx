"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormField } from "../FormField";
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

function termLabel(term: string) {
  return term === "fall" ? "上学期" : term === "spring" ? "下学期" : term;
}

export function MaterialsExplorer() {
  const [initial] = useState(() =>
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search),
  );
  const [query, setQuery] = useState(initial.get("q") ?? "");
  const [course, setCourse] = useState(initial.get("course") ?? "");
  const [teacher, setTeacher] = useState(initial.get("teacher") ?? "");
  const [type, setType] = useState(initial.get("type") ?? "");
  const [tag, setTag] = useState(initial.get("tag") ?? "");
  const [term, setTerm] = useState(initial.get("term") ?? "");
  const [year, setYear] = useState(initial.get("year") ?? "");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
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
    params.set("limit", "36");
    return params;
  }, [course, query, tag, teacher, term, type, year]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus("loading");
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

  const hasFilters = Boolean(query || course || teacher || type || tag || term || year);
  const filters = result?.filters ?? emptyFilters;

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const count = result?.items.length ?? 0;
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
    const count = result?.items.length ?? 0;
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
          { href: "/?view=catalog", label: "课程库" },
          { href: "/?view=schedule", label: "我的课表", showOnMobile: false },
          { href: "/?view=me", label: "我的", showOnMobile: false },
        ]}
      />

      <section className={styles.hero} aria-labelledby="materials-title">
        <div className={styles.indexMark} aria-hidden="true">
          <span>ARCHIVE</span>
          <b>{String(result?.catalog.total ?? 457).padStart(3, "0")}</b>
        </div>
        <div className={styles.heroCopy}>
          <span>东财课程资料档案</span>
          <h1 id="materials-title">按课程、教师或文件名找资料。</h1>
          <p>搜索结果可以直接查看详情、预览或下载。</p>
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
          <p>方向键浏览结果，Enter 打开，Escape 清空。手机上可直接触摸操作。</p>
        </aside>

        <div className={styles.resultsPanel}>
          <header className={styles.resultHeader}>
            <div>
              <span>资料索引</span>
              <strong>
                {status === "loading" ? "正在检索…" : `${result?.total ?? 0} 份结果`}
              </strong>
            </div>
            <i aria-hidden="true">{hasFilters ? "SEARCH / ACTIVE" : "OPEN / SHELF"}</i>
          </header>

          {status === "loading" && (
            <div className={styles.loading} role="status" aria-live="polite">
              {[0, 1, 2, 3].map((item) => <i key={item} />)}
              <span>正在翻检档案</span>
            </div>
          )}

          {status === "error" && (
            <div className={styles.stateCard} role="alert">
              <b>资料索引暂时没有回应</b>
              <p>文件本身没有被改动。检查网络后，可以从这里重新连接。</p>
              <button onClick={() => setRevision((value) => value + 1)}>重新加载</button>
            </div>
          )}

          {status === "ready" && result?.items.length === 0 && (
            <div className={styles.stateCard}>
              <b>这一组条件下没有资料</b>
              <p>可以去掉一个筛选，或改用课程简称、教师姓名和文件类型。</p>
              <button onClick={clearFilters}>回到全部资料</button>
            </div>
          )}

          {status === "ready" && Boolean(result?.items.length) && (
            <div className={styles.results} id="material-results" role="list" aria-label="资料搜索结果">
              {result?.items.map((material, index) => (
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
                    </small>
                  </div>
                  <div className={styles.quickActions}>
                    {material.previewable && <a href={material.previewUrl} target="_blank" rel="noreferrer">预览</a>}
                    <a href={material.downloadUrl} download>下载</a>
                  </div>
                </article>
              ))}
            </div>
          )}

          {status === "ready" && result?.hasMore && (
            <p className={styles.moreNote}>先展示最相关的 36 份资料，继续补充关键词可以更快找到目标。</p>
          )}
        </div>
      </section>
    </main>
  );
}
