"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { PublicMasthead } from "../../PublicMasthead";
import styles from "../teachers.module.css";

type RatingKey = "courseOrganization" | "contentClarity" | "assessmentExplanation" | "classroomInteraction" | "materialCompleteness";
type TeacherDetailData = {
  id: string;
  displayName: string;
  collegeName: string;
  courseCount: number;
  reviewCount: number;
  ratings: Record<RatingKey, number | null>;
  sections: Array<{ id: string; termKey: string; courseId: string; courseTitle: string; sectionNo: string; status: string }>;
  textbooks: Array<{ id: string; termKey: string; courseId: string; courseTitle: string; sectionNo: string; selectionStatus: string; title: string | null; author: string | null; publisher: string | null; edition: string | null; isbn: string | null; status: string }>;
};
type TeacherReview = {
  id: string;
  sourceType: "user" | "legacy_approved";
  authorLabel: string;
  body: string;
  ratings: Record<RatingKey, number> | null;
  publishedAt: string;
};

const ratingLabels: Array<[RatingKey, string]> = [
  ["courseOrganization", "课程组织"],
  ["contentClarity", "讲解清晰"],
  ["assessmentExplanation", "考核说明"],
  ["classroomInteraction", "课堂互动"],
  ["materialCompleteness", "资料完整"],
];

function termLabel(term: string) {
  return term === "fall" ? "上学期" : term === "spring" ? "下学期" : term;
}

export function TeacherDetail({ teacherId }: { teacherId: string }) {
  const [teacher, setTeacher] = useState<TeacherDetailData | null>(null);
  const [reviews, setReviews] = useState<TeacherReview[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setStatus("loading");
      try {
        const [detailResponse, reviewResponse] = await Promise.all([
          fetch(`/api/teachers/${teacherId}`, { signal: controller.signal, headers: { Accept: "application/json" } }),
          fetch(`/api/teachers/${teacherId}/reviews?limit=20`, { signal: controller.signal, headers: { Accept: "application/json" } }),
        ]);
        if (detailResponse.status === 404) {
          setStatus("missing");
          return;
        }
        if (!detailResponse.ok || !reviewResponse.ok) throw new Error("teacher_unavailable");
        setTeacher(((await detailResponse.json()) as { teacher: TeacherDetailData }).teacher);
        const reviewPayload = await reviewResponse.json() as { items: TeacherReview[]; nextCursor: string | null };
        setReviews(reviewPayload.items);
        setNextCursor(reviewPayload.nextCursor);
        setStatus("ready");
      } catch (error) {
        if ((error as Error).name !== "AbortError") setStatus("error");
      }
    }
    void load();
    return () => controller.abort();
  }, [teacherId, revision]);

  async function loadMoreReviews() {
    if (!nextCursor) return;
    const response = await fetch(`/api/teachers/${teacherId}/reviews?limit=20&after=${encodeURIComponent(nextCursor)}`);
    if (!response.ok) {
      setStatus("error");
      return;
    }
    const payload = await response.json() as { items: TeacherReview[]; nextCursor: string | null };
    setReviews((current) => [...current, ...payload.items]);
    setNextCursor(payload.nextCursor);
  }

  if (status === "missing") {
    return <main className={styles.page}><PublicMasthead navigationLabel="教师详情导航" items={[{ href: "/teachers", label: "教师档案" }]} /><div className={styles.fullState}><b>这份教师档案不存在或已撤下。</b><Link href="/teachers">返回教师索引</Link></div></main>;
  }
  if (status === "error") {
    return <main className={styles.page}><PublicMasthead navigationLabel="教师详情导航" items={[{ href: "/teachers", label: "教师档案" }]} /><div className={styles.fullState} role="alert"><b>教师档案暂时没有连上。</b><button onClick={() => setRevision((value) => value + 1)}>重新读取</button></div></main>;
  }
  if (!teacher) {
    return <main className={styles.page}><PublicMasthead navigationLabel="教师详情导航" items={[{ href: "/teachers", label: "教师档案" }]} /><div className={styles.fullState} role="status">正在读取教师档案…</div></main>;
  }

  return (
    <main className={styles.page} id="main-content">
      <PublicMasthead
        navigationLabel="教师详情导航"
        items={[
          { href: "/teachers", label: "教师档案" },
          { href: `/materials?teacher=${encodeURIComponent(teacher.displayName)}`, label: "相关资料" },
          { href: "/?view=schedule", label: "我的课表", showOnMobile: false },
        ]}
      />
      <header className={styles.profileHeader}>
        <div className={styles.profileBracket} aria-hidden="true"><span>{teacher.displayName.slice(0, 1)}</span></div>
        <div>
          <p>{teacher.collegeName}</p>
          <h1>{teacher.displayName}</h1>
          <small>同名教师按学院和来源分别建档 · 当前展示已记录事实</small>
        </div>
        <dl>
          <div><dt>教学班</dt><dd>{teacher.courseCount}</dd></div>
          <div><dt>公开评价</dt><dd>{teacher.reviewCount}</dd></div>
        </dl>
      </header>

      <section className={styles.profileGrid}>
        <article className={styles.ratings}>
          <header><span>五项教学维度</span><p>只统计当前用户提交的五维评分；历史整理内容不参与均分。</p></header>
          <div>
            {ratingLabels.map(([key, label]) => (
              <div key={key}>
                <span>{label}</span>
                <b>{teacher.ratings[key] === null ? "—" : teacher.ratings[key]?.toFixed(1)}</b>
                <i style={{ "--rating": `${(teacher.ratings[key] ?? 0) * 20}%` } as CSSProperties} />
              </div>
            ))}
          </div>
        </article>

        <article className={styles.courseLedger}>
          <header><span>教学班记录</span><b>{teacher.sections.length}</b></header>
          {teacher.sections.length ? teacher.sections.map((section) => (
            <div key={section.id}>
              <span>{termLabel(section.termKey)}</span>
              <strong>{section.courseTitle}</strong>
              <small>{section.courseId} · 课序号 {section.sectionNo}{section.status === "needs_review" ? " · 待核对" : ""}</small>
            </div>
          )) : <p className={styles.inlineEmpty}>暂未记录具体教学班。</p>}
        </article>
      </section>

      <section className={styles.textbooks} aria-labelledby="teacher-textbooks-title">
        <header><span>按教学班记录</span><h2 id="teacher-textbooks-title">教材</h2><p>同一课程的不同教学班可能使用不同教材，这里不会互相覆盖。</p></header>
        <div>
          {teacher.textbooks.length ? teacher.textbooks.map((book) => (
            <article key={book.id}>
              <small>{termLabel(book.termKey)} · {book.courseTitle} · {book.sectionNo}</small>
              <h3>{book.selectionStatus === "not_specified" ? "不指定教材" : book.title ?? "教材待核对"}</h3>
              <p>{[book.author, book.publisher, book.edition].filter(Boolean).join(" · ") || "未提供出版信息"}</p>
              {book.isbn && <code>ISBN {book.isbn}</code>}
            </article>
          )) : <p className={styles.inlineEmpty}>暂未记录教材。</p>}
        </div>
      </section>

      <section className={styles.reviews} aria-labelledby="teacher-reviews-title">
        <header><span>已公开内容</span><h2 id="teacher-reviews-title">评价</h2><p>历史整理内容经过人工审核后才会出现，并且不会冒充当前学生。</p></header>
        <div>
          {reviews.length ? reviews.map((review) => (
            <article key={review.id}>
              <div><b>{review.authorLabel}</b><time dateTime={review.publishedAt}>{new Date(review.publishedAt).toLocaleDateString("zh-CN")}</time></div>
              <p>{review.body}</p>
            </article>
          )) : <p className={styles.inlineEmpty}>还没有公开评价。</p>}
        </div>
        {nextCursor && <button className={styles.loadMore} onClick={() => void loadMoreReviews()}>继续查看评价</button>}
      </section>
    </main>
  );
}
