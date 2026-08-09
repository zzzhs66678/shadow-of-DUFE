"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
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

export function TeacherExplorer() {
  const [initial] = useState(() =>
    typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("q") ?? "",
  );
  const [query, setQuery] = useState(initial);
  const [items, setItems] = useState<TeacherSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const requestQuery = useMemo(() => query.normalize("NFKC").trim(), [query]);

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
          { href: "/?view=catalog", label: "课程库" },
          { href: "/materials", label: "资料档案" },
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
          <h1 id="teachers-title">先找到正确的人，再看他的课。</h1>
          <p>同名教师会按学院分别展示。教学班、教材和评价都来自已记录的事实。</p>
        </div>
        <label className={styles.searchField}>
          <span>教师姓名</span>
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
            placeholder="输入姓名，课表入口也会来到这里…"
          />
          {query && <button onClick={() => setQuery("")} aria-label="清空教师搜索">清空</button>}
        </label>
      </section>

      <section className={styles.results} aria-live="polite" aria-busy={status === "loading"}>
        <header>
          <div><span>检索结果</span><b>{status === "ready" ? `${items.length} 位` : "读取中"}</b></div>
          <p>点击姓名进入教师档案。姓名相同但学院不同的记录不会合并。</p>
        </header>
        {status === "error" && (
          <div className={styles.state} role="alert">
            <b>教师档案暂时没有连上。</b>
            <p>课表和课程库仍可使用；稍后重试不会丢失搜索词。</p>
            <button onClick={() => setRevision((value) => value + 1)}>重新读取</button>
          </div>
        )}
        {status === "ready" && items.length === 0 && (
          <div className={styles.state}>
            <b>没有找到对应教师。</b>
            <p>试试只输入姓名，不要加入职称或课程名。</p>
            {query && <button onClick={() => setQuery("")}>查看全部教师</button>}
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
                <span className={styles.openLabel}>查看档案 →</span>
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
