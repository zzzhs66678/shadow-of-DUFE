"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { loadPersonalCourseContext, type PersonalCourseContext } from "../personal-course-context";
import { PublicMasthead } from "../PublicMasthead";
import { safeCourseReturn, withCourseReturn } from "../discovery-navigation";
import { useCourseReturn } from "../CourseReturnLink";
import styles from "./teachers.module.css";

type TeacherSummary = {
  id: string;
  displayName: string;
  collegeName: string;
  courseCount: number;
  reviewCount: number;
  updatedAt: string;
};
type TeacherResponse = { items: TeacherSummary[]; nextCursor: string | null };
type College = { key: string; name: string; teacherCount: number };

type TeacherExplorerProps = {
  initialQuery?: string;
  initialCollege?: string;
  embedded?: boolean;
  onSearchChange?: (search: { q: string; college: string }) => void;
};

export function TeacherExplorer({ initialQuery = "", initialCollege = "", embedded = false, onSearchChange }: TeacherExplorerProps) {
  const courseReturn = useCourseReturn();
  const [query, setQuery] = useState(initialQuery);
  const [college, setCollege] = useState(initialCollege.normalize("NFKC").trim().toLocaleLowerCase("zh-CN"));
  const [colleges, setColleges] = useState<College[]>([]);
  const [collegeStatus, setCollegeStatus] = useState<"loading" | "ready" | "error">("loading");
  const [items, setItems] = useState<TeacherSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [moreStatus, setMoreStatus] = useState<"idle" | "loading" | "error">("idle");
  const [revision, setRevision] = useState(0);
  const [personalContext, setPersonalContext] = useState<PersonalCourseContext | null>(null);
  const generation = useRef(0);
  const moreRequest = useRef<AbortController | null>(null);
  const onSearchChangeRef = useRef(onSearchChange);
  const instanceId = useId();
  const titleId = embedded ? `${instanceId}-teachers-title` : "teachers-title";
  const queryId = embedded ? `${instanceId}-teacher-name-query` : "teacher-name-query";
  const collegeId = embedded ? `${instanceId}-teacher-college` : "teacher-college";
  const directoryId = embedded ? `${instanceId}-directory-title` : "directory-title";
  const Root = embedded ? "section" : "main";
  const requestQuery = query.normalize("NFKC").trim();
  const hasFilter = Boolean(requestQuery || college);
  const collegeName = colleges.find((item) => item.key === college)?.name ?? college;

  useEffect(() => {
    onSearchChangeRef.current = onSearchChange;
  }, [onSearchChange]);

  useEffect(() => {
    onSearchChangeRef.current?.({ q: requestQuery, college });
  }, [requestQuery, college]);

  useEffect(() => {
    if (embedded) return;
    const locationParams = new URLSearchParams();
    const returnTo = safeCourseReturn(new URLSearchParams(window.location.search).get("returnTo"));
    if (returnTo) locationParams.set("returnTo", returnTo);
    if (requestQuery) locationParams.set("q", requestQuery);
    if (college) locationParams.set("college", college);
    window.history.replaceState(null, "", `/teachers${locationParams.size ? `?${locationParams}` : ""}`);
  }, [embedded, requestQuery, college]);

  useEffect(() => {
    let live = true;
    void loadPersonalCourseContext().then((context) => {
      if (live) setPersonalContext(context);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadColleges() {
      setCollegeStatus("loading");
      try {
        const response = await fetch("/api/teachers/colleges", {
          headers: { Accept: "application/json" }, signal: controller.signal,
        });
        if (!response.ok) throw new Error("colleges_unavailable");
        const payload = await response.json() as { items: College[] };
        if (controller.signal.aborted) return;
        setColleges(payload.items);
        setCollegeStatus("ready");
      } catch {
        if (!controller.signal.aborted) setCollegeStatus("error");
      }
    }
    void loadColleges();
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    moreRequest.current?.abort();
    moreRequest.current = null;
    const timer = window.setTimeout(async () => {
      setItems([]);
      setNextCursor(null);
      setMoreStatus("idle");
      setStatus(hasFilter ? "loading" : "ready");
      if (!hasFilter) return;
      try {
        const params = new URLSearchParams({ limit: "30" });
        if (requestQuery) params.set("q", requestQuery);
        if (college) params.set("college", college);
        const response = await fetch(`/api/teachers?${params}`, {
          headers: { Accept: "application/json" }, signal: controller.signal,
        });
        if (!response.ok) throw new Error("teachers_unavailable");
        const payload = await response.json() as TeacherResponse;
        if (controller.signal.aborted || currentGeneration !== generation.current) return;
        setItems(payload.items);
        setNextCursor(payload.nextCursor);
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted && currentGeneration === generation.current) setStatus("error");
      }
    }, requestQuery ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      moreRequest.current?.abort();
      moreRequest.current = null;
      if (currentGeneration === generation.current) generation.current += 1;
    };
  }, [requestQuery, college, hasFilter, revision]);

  function changeFilters(nextQuery: string, nextCollege: string) {
    if (nextQuery.normalize("NFKC").trim() !== requestQuery || nextCollege !== college) {
      generation.current += 1;
      moreRequest.current?.abort();
      moreRequest.current = null;
      setItems([]);
      setNextCursor(null);
      setMoreStatus("idle");
      setStatus("loading");
    }
    setQuery(nextQuery);
    setCollege(nextCollege);
  }

  async function loadMore() {
    if (!nextCursor || status !== "ready" || moreRequest.current) return;
    const currentGeneration = generation.current;
    const controller = new AbortController();
    moreRequest.current = controller;
    setMoreStatus("loading");
    try {
      const params = new URLSearchParams({ limit: "30", after: nextCursor });
      if (requestQuery) params.set("q", requestQuery);
      if (college) params.set("college", college);
      const response = await fetch(`/api/teachers?${params}`, {
        headers: { Accept: "application/json" }, signal: controller.signal,
      });
      if (!response.ok) throw new Error("teachers_unavailable");
      const payload = await response.json() as TeacherResponse;
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      setItems((current) => {
        const knownIds = new Set(current.map((teacher) => teacher.id));
        return [...current, ...payload.items.filter((teacher) => !knownIds.has(teacher.id))];
      });
      setNextCursor(payload.nextCursor);
      setMoreStatus("idle");
    } catch {
      if (!controller.signal.aborted && currentGeneration === generation.current) setMoreStatus("error");
    } finally {
      if (moreRequest.current === controller) moreRequest.current = null;
    }
  }

  return (
    <Root className={embedded ? styles.embedded : styles.page} id={embedded ? undefined : "main-content"}>
      {!embedded && <PublicMasthead navigationLabel="教师页导航" items={[
        { href: "/?view=catalog", label: "课程" },
        { href: "/teachers", label: "教师", current: true },
        { href: "/materials", label: "资料" },
        { href: "/?view=schedule", label: "我的课表", showOnMobile: false },
      ]} />}
      <section className={embedded ? styles.embeddedSearch : styles.hero} aria-labelledby={titleId}>
        {embedded ? <h2 id={titleId} className={styles.visuallyHidden}>教师评价</h2> : <div className={styles.heroCopy}>
          <h1 id={titleId}>教师评价</h1>
          <p>同名教师请核对学院。</p>
        </div>}
        <div className={styles.searchField} role="search" aria-label="全校教师搜索">
          <label htmlFor={queryId}>全校姓名搜索</label>
          <input id={queryId} value={query} maxLength={64}
            onChange={(event) => changeFilters(event.target.value, "")}
            onKeyDown={(event) => { if (event.key === "Escape") changeFilters("", ""); }}
            autoComplete="off" type="search" placeholder="输入教师姓名…" />
          {query && <button type="button" onClick={() => changeFilters("", "")} aria-label="清空教师搜索">清空</button>}
        </div>
      </section>

      {Boolean(personalContext?.teacherNames.length) && (
        <section className={styles.personalContext} aria-label="本学期教师">
          <div><span>本学期教师</span><p>来自已导入课表；同名教师请核对学院。</p></div>
          <div>{personalContext?.teacherNames.map((name) => (
            <button type="button" key={name} onClick={() => changeFilters(name, "")}>{name}</button>
          ))}</div>
        </section>
      )}

      <section className={styles.results} aria-labelledby={directoryId}>
        <header className={styles.directoryHeader}>
          <h2 id={directoryId}>{hasFilter ? collegeName || "全校搜索" : "按学院找老师"}</h2>
          {hasFilter && <button type="button" onClick={() => changeFilters("", "")}>返回学院索引</button>}
        </header>
        {collegeStatus === "loading" && <p role="status">正在读取学院…</p>}
        {collegeStatus === "error" && <div className={styles.inlineEmpty} role="alert">学院加载失败，仍可搜索全校姓名。 <button type="button" onClick={() => setRevision((value) => value + 1)}>重新读取学院</button></div>}
        {!hasFilter && collegeStatus === "ready" && (
          colleges.length ? <div className={styles.collegeList}>
            {colleges.map((item) => <button type="button" key={item.key} onClick={() => changeFilters("", item.key)}>
              <span>{item.name}</span><small>{item.teacherCount} 位教师</small><span aria-hidden="true">→</span>
            </button>)}
          </div> : <div className={styles.inlineEmpty}><p>暂无教师档案，暂时无法评价。</p></div>
        )}
        {hasFilter && <>
          <div className={styles.directoryFilter}>
            <label htmlFor={collegeId}>学院</label>
            <select id={collegeId} value={college} onChange={(event) => changeFilters(query, event.target.value)}>
              <option value="">全部学院</option>
              {college && !colleges.some((item) => item.key === college) && <option value={college}>{collegeName}</option>}
              {colleges.map((item) => <option key={item.key} value={item.key}>{item.name}（{item.teacherCount}）</option>)}
            </select>
            <p role="status">{status === "loading" ? "正在查找教师…" : status === "error" ? "读取失败" : `已显示 ${items.length} 位${nextCursor ? "，可继续加载" : ""}`}</p>
          </div>
          {status === "error" && <div className={styles.state} role="alert"><b>教师档案加载失败。</b><p>搜索词与学院已保留。</p><button type="button" onClick={() => setRevision((value) => value + 1)}>重新读取</button></div>}
          {status === "ready" && items.length === 0 && <p className={styles.inlineEmpty}>没有找到对应教师。试试完整姓名或切换学院，同名记录不会自动合并。</p>}
          <div className={styles.teacherList} aria-busy={status === "loading"}>
            {items.map((teacher) => <Link key={teacher.id} href={withCourseReturn(`/teachers/${teacher.id}`, courseReturn ?? undefined)}>
              <div><h3>{teacher.displayName}</h3><small>{teacher.collegeName}</small></div>
              <span className={styles.teacherReviewCount}>{teacher.reviewCount ? `${teacher.reviewCount} 条评价` : "暂无评价"}</span>
              <span className={styles.openLabel}>阅读评价 →</span>
            </Link>)}
          </div>
          {moreStatus === "error" && <p role="status">更多教师加载失败，已显示的教师仍保留。</p>}
          {nextCursor && status === "ready" && <button className={styles.loadMore} type="button" onClick={() => void loadMore()} disabled={moreStatus === "loading"}>
            {moreStatus === "loading" ? "正在继续读取" : moreStatus === "error" ? "重新读取更多教师" : "继续查看教师"}
          </button>}
        </>}
      </section>
    </Root>
  );
}
