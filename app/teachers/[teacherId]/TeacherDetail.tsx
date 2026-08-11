"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { FormField } from "../../FormField";
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
type OwnTeacherReview = Omit<TeacherReview, "ratings"> & {
  ratings: Record<RatingKey, number>;
  status: "published" | "hidden";
  version: number;
  updatedAt: string;
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
  const [accountStatus, setAccountStatus] = useState<"loading" | "guest" | "ready" | "error">("loading");
  const [ownReview, setOwnReview] = useState<OwnTeacherReview | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [draftRatings, setDraftRatings] = useState<Record<RatingKey, number>>({
    courseOrganization: 0,
    contentClarity: 0,
    assessmentExplanation: 0,
    classroomInteraction: 0,
    materialCompleteness: 0,
  });
  const [reviewAction, setReviewAction] = useState<"idle" | "saving" | "deleting">("idle");
  const [reviewNotice, setReviewNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setStatus("loading");
      try {
        const [detailResponse, reviewResponse, ownReviewResponse] = await Promise.all([
          fetch(`/api/teachers/${teacherId}`, { signal: controller.signal, cache: "no-store", headers: { Accept: "application/json" } }),
          fetch(`/api/teachers/${teacherId}/reviews?limit=20`, { signal: controller.signal, cache: "no-store", headers: { Accept: "application/json" } }),
          fetch(`/api/teachers/${teacherId}/my-review`, { signal: controller.signal, headers: { Accept: "application/json" } }),
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
        if (ownReviewResponse.status === 401) {
          setAccountStatus("guest");
          setOwnReview(null);
        } else if (ownReviewResponse.ok) {
          const ownPayload = await ownReviewResponse.json() as { review: OwnTeacherReview | null };
          setOwnReview(ownPayload.review);
          setAccountStatus("ready");
          if (ownPayload.review) {
            setDraftBody(ownPayload.review.body);
            setDraftRatings(ownPayload.review.ratings);
          }
        } else {
          setAccountStatus("error");
        }
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
    const response = await fetch(`/api/teachers/${teacherId}/reviews?limit=20&after=${encodeURIComponent(nextCursor)}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      setStatus("error");
      return;
    }
    const payload = await response.json() as { items: TeacherReview[]; nextCursor: string | null };
    setReviews((current) => [...current, ...payload.items]);
    setNextCursor(payload.nextCursor);
  }

  function openComposer() {
    if (ownReview) {
      setDraftBody(ownReview.body);
      setDraftRatings(ownReview.ratings);
    }
    setReviewNotice("");
    setConfirmDelete(false);
    setComposerOpen(true);
  }

  async function saveReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draftBody.normalize("NFKC").trim().length < 20) {
      setReviewNotice("请至少写 20 个字，说明具体的课堂体验。");
      return;
    }
    if (Object.values(draftRatings).some((rating) => rating < 1 || rating > 5)) {
      setReviewNotice("请完成五个教学维度的评分。");
      return;
    }
    setReviewAction("saving");
    setReviewNotice("");
    const payload: { body: string; ratings: Record<RatingKey, number>; expectedVersion?: number } = {
      body: draftBody,
      ratings: draftRatings,
    };
    if (ownReview) payload.expectedVersion = ownReview.version;
    try {
      const response = await fetch(`/api/teachers/${teacherId}/my-review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) {
        setAccountStatus("guest");
        setReviewNotice("登录状态已失效，请重新登录后再提交。");
        return;
      }
      if (response.status === 409) {
        setReviewNotice("这份评价已经在另一处更新。页面将读取最新版本，请核对后再保存。");
        window.setTimeout(() => setRevision((value) => value + 1), 900);
        return;
      }
      if (!response.ok) throw new Error("teacher_review_save_failed");
      const saved = (await response.json()) as { review: OwnTeacherReview };
      setOwnReview(saved.review);
      setDraftBody(saved.review.body);
      setDraftRatings(saved.review.ratings);
      setReviews((current) => {
        const withoutSavedReview = current.filter((review) => review.id !== saved.review.id);
        if (saved.review.status !== "published") return withoutSavedReview;
        return [
          {
            id: saved.review.id,
            sourceType: saved.review.sourceType,
            authorLabel: saved.review.authorLabel,
            body: saved.review.body,
            ratings: saved.review.ratings,
            publishedAt: saved.review.publishedAt,
          },
          ...withoutSavedReview,
        ];
      });
      setComposerOpen(false);
      setReviewNotice(saved.review.status === "published"
        ? "你的评价已保存并公开。"
        : "修改已保存；这份评价当前仍未公开。");
      setRevision((value) => value + 1);
    } catch {
      setReviewNotice("评价暂时没有保存，请保留当前内容后重试。");
    } finally {
      setReviewAction("idle");
    }
  }

  async function deleteReview() {
    if (!ownReview) return;
    setReviewAction("deleting");
    setReviewNotice("");
    try {
      const response = await fetch(`/api/teachers/${teacherId}/my-review`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ version: ownReview.version }),
      });
      if (response.status === 409) {
        setReviewNotice("这份评价已经变化，页面将读取最新版本。");
        window.setTimeout(() => setRevision((value) => value + 1), 900);
        return;
      }
      if (!response.ok) throw new Error("teacher_review_delete_failed");
      setOwnReview(null);
      setDraftBody("");
      setDraftRatings({
        courseOrganization: 0,
        contentClarity: 0,
        assessmentExplanation: 0,
        classroomInteraction: 0,
        materialCompleteness: 0,
      });
      setComposerOpen(false);
      setConfirmDelete(false);
      setReviewNotice("你的评价已删除。");
      setRevision((value) => value + 1);
    } catch {
      setReviewNotice("评价暂时无法删除，请稍后再试。");
    } finally {
      setReviewAction("idle");
    }
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
          <aside className={styles.reviewContribution} aria-label="我的教师评价">
            {accountStatus === "loading" && <p>正在确认是否可以写评价…</p>}
            {accountStatus === "guest" && (
              <div><b>登录后写下真实的课堂体验</b><p>每位登录用户对同一位教师保留一份评价，可以之后修改或删除。</p><Link href="/?view=me">去登录或创建账号</Link></div>
            )}
            {accountStatus === "error" && <p role="status">暂时无法读取你的评价，公开内容仍可正常浏览。</p>}
            {accountStatus === "ready" && !composerOpen && (
              <div>
                <b>{ownReview?.status === "hidden" ? "这份评价当前未公开" : ownReview ? "你的评价已经公开" : "你上过这位老师的课吗？"}</b>
                <p>{ownReview?.status === "hidden" ? "可以修改或删除，但修改不会自动恢复公开。" : ownReview ? "可以继续修改，公开页会显示最新版本。" : "只写与教学有关、自己实际经历过的内容。"}</p>
                <button type="button" onClick={openComposer}>{ownReview ? "修改我的评价" : "写一份评价"}</button>
              </div>
            )}
            {accountStatus === "ready" && composerOpen && (
              <form onSubmit={(event) => void saveReview(event)}>
                <header><b>{ownReview ? "修改我的评价" : "写一份评价"}</b><button type="button" onClick={() => setComposerOpen(false)} disabled={reviewAction !== "idle"}>收起</button></header>
                <div className={styles.ratingEditor}>
                  {ratingLabels.map(([key, label]) => (
                    <fieldset key={key}>
                      <legend>{label}</legend>
                      <div>
                        {[1, 2, 3, 4, 5].map((rating) => (
                          <label key={rating}>
                            <input type="radio" name={key} value={rating} checked={draftRatings[key] === rating} onChange={() => setDraftRatings((current) => ({ ...current, [key]: rating }))} />
                            <span>{rating}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
                <FormField label="具体说说课堂组织、讲解、考核或资料" counter={`${draftBody.normalize("NFKC").trim().length} / 3000`}>
                  <textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} minLength={20} maxLength={3000} rows={6} placeholder="例如：课堂如何组织、哪些讲解方式有效、考核说明是否清楚……" />
                </FormField>
                <div className={styles.reviewActions}>
                  <button type="submit" disabled={reviewAction !== "idle"}>{reviewAction === "saving" ? "正在保存" : "保存并公开"}</button>
                  {ownReview && !confirmDelete && <button type="button" onClick={() => setConfirmDelete(true)} disabled={reviewAction !== "idle"}>删除我的评价</button>}
                  {ownReview && confirmDelete && <><span>删除后公开页将不再显示。</span><button type="button" onClick={() => void deleteReview()} disabled={reviewAction !== "idle"}>{reviewAction === "deleting" ? "正在删除" : "确认删除"}</button><button type="button" onClick={() => setConfirmDelete(false)} disabled={reviewAction !== "idle"}>取消</button></>}
                </div>
              </form>
            )}
            {reviewNotice && <p className={styles.reviewNotice} role="status">{reviewNotice}</p>}
          </aside>
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
