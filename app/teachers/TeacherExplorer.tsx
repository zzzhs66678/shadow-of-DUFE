"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadPersonalCourseContext,
  type PersonalCourseContext,
} from "../personal-course-context";
import { PublicMasthead } from "../PublicMasthead";
import styles from "./teachers.module.css";

type TeacherSummary = {
  id: string;
  displayName: string;
  collegeName: string;
  courseCount: number;
  reviewCount: number;
  updatedAt: string;
};

type TeacherResponse = {
  items: TeacherSummary[];
  nextCursor: string | null;
};

export function TeacherExplorer({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<TeacherSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const [personalContext, setPersonalContext] = useState<PersonalCourseContext | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const requestQuery = useMemo(() => query.normalize("NFKC").trim(), [query]);

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
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const params = new URLSearchParams({ limit: "30" });
        if (requestQuery) params.set("q", requestQuery);
        const response = await fetch(`/api/teachers?${params}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("teachers_unavailable");
        const payload = await response.json() as TeacherResponse;
        setItems(payload.items);
        setNextCursor(payload.nextCursor);
        setStatus("ready");
        window.history.replaceState(null, "", requestQuery
          ? `/teachers?q=${encodeURIComponent(requestQuery)}`
          : "/teachers");
      } catch (error) {
        if ((error as Error).name !== "AbortError") setStatus("error");
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [requestQuery, revision]);

  async function loadMore() {
    if (!nextCursor || status !== "ready") return;
    setStatus("loading");
    try {
      const params = new URLSearchParams({ limit: "30", after: nextCursor });
      if (requestQuery) params.set("q", requestQuery);
      const response = await fetch(`/api/teachers?${params}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("teachers_unavailable");
      const payload = await response.json() as TeacherResponse;
      setItems((current) => [...current, ...payload.items]);
      setNextCursor(payload.nextCursor);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }

  return (
    <main className={styles.page} id="main-content">
      <PublicMasthead
        navigationLabel="教师页导航"
        items={[
          { href: "/?view=catalog", label: "课程" },
          { href: "/teachers", label: "教师", current: true },
          { href: "/materials", label: "资料" },
          { href: "/?view=schedule", label: "我的课表", showOnMobile: false },
        ]}
      />
      <section className={styles.hero} aria-labelledby="teachers-title">
        <div className={styles.directoryMark} aria-hidden="true">
          <i />
          <span>FACULTY<br />DIRECTORY</span>
        </div>
        <div className={styles.heroCopy}>
          <span>东财教师档案</span>
          <h1 id="teachers-title">这门课，听听上过的人。</h1>
          <p>按姓名查教师；同名教师请核对学院。</p>
        </div>
        <label className={styles.searchField}>
          <span>查找教师</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                inputRef.current?.focus();
              }
            }}
            autoComplete="off"
            type="search"
            placeholder="输入教师姓名…"
          />
          {query && <button onClick={() => setQuery("")} aria-label="清空教师搜索">清空</button>}
        </label>
      </section>

      {Boolean(personalContext?.teacherNames.length) && (
        <section className={styles.personalContext} aria-label="本学期教师">
          <div>
            <span>本学期教师</span>
            <p>来自已导入课表；遇到同名教师，请按学院确认。</p>
          </div>
          <div>
            {personalContext?.teacherNames.map((teacherName) => (
              <button key={teacherName} onClick={() => setQuery(teacherName)}>
                {teacherName}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className={styles.results} aria-live="polite" aria-busy={status === "loading"}>
        <header>
          <div><span>检索结果</span><b>{status === "ready" ? `${items.length} 位` : "读取中"}</b></div>
          <p>查看评价、课程与教材。</p>
        </header>
        {status === "error" && (
          <div className={styles.state} role="alert">
            <b>教师档案暂时没有连上。</b>
            <p>检查网络后重试。搜索词会保留。</p>
            <button onClick={() => setRevision((value) => value + 1)}>重新读取</button>
          </div>
        )}
        {status === "ready" && items.length === 0 && (
          <div className={styles.state}>
            {query ? (
              <>
                <b>没有找到对应教师。</b>
                <p>姓名可能不完整，或档案尚未收录。同名记录不会自动合并。</p>
                <button onClick={() => setQuery("")}>查看全部教师</button>
              </>
            ) : (
              <>
                <b>教师档案尚未整理入库。</b>
                <p>教师身份尚未入库，评价功能暂不可用。</p>
                <Link href="/?view=catalog">返回课程</Link>
              </>
            )}
          </div>
        )}
        {items.length > 0 && (
          <div className={styles.teacherList}>
            {items.map((teacher) => (
              <Link key={teacher.id} href={`/teachers/${teacher.id}`}>
                <span className={styles.nameMark} aria-hidden="true">{teacher.displayName.slice(0, 1)}</span>
                <div>
                  <small>{teacher.collegeName}</small>
                  <h2>{teacher.displayName}</h2>
                </div>
                <dl>
                  <div><dt>教学班</dt><dd>{teacher.courseCount}</dd></div>
                  <div><dt>公开评价</dt><dd>{teacher.reviewCount}</dd></div>
                </dl>
                <span className={styles.openLabel}>阅读评价 →</span>
              </Link>
            ))}
          </div>
        )}
        {nextCursor && status !== "error" && (
          <button className={styles.loadMore} onClick={() => void loadMore()} disabled={status === "loading"}>
            {status === "loading" ? "正在继续读取" : "继续查看"}
          </button>
        )}
      </section>
    </main>
  );
}
