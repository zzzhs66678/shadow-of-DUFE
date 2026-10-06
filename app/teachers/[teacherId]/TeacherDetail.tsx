"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { FormField } from "../../FormField";
import { PublicMasthead } from "../../PublicMasthead";
import { TeacherReviewDiscussion } from "../TeacherReviewDiscussion";
import styles from "../teachers.module.css";

type TeacherDetailData = {
  id: string;
  displayName: string;
  collegeName: string;
  courseCount: number;
  reviewCount: number;
  sections: Array<{ id: string; termKey: string; courseId: string; courseTitle: string; sectionNo: string; status: string }>;
  textbooks: Array<{ id: string; termKey: string; courseId: string; courseTitle: string; sectionNo: string; selectionStatus: string; title: string | null; author: string | null; publisher: string | null; edition: string | null; isbn: string | null; status: string }>;
};
type TeacherReview = {
  id: string;
  sourceType: "user" | "legacy_approved";
  authorLabel: string;
  body: string;
  discussionCount: number;
  publishedAt: string;
};
type ReviewSort = "latest" | "discussed" | "relevant";
type OwnTeacherReview = Omit<TeacherReview, "discussionCount"> & {
  status: "published" | "hidden";
  version: number;
  updatedAt: string;
};

function termLabel(term: string) {
  const match = term.match(/^(\d{4})-(\d{4})-(fall|spring)$/u);
  if (match) {
    return `${match[1]}—${match[2]} 学年 · ${match[3] === "fall" ? "第一学期" : "第二学期"}`;
  }
  return term === "fall" ? "上学期（学年待核对）" : term === "spring" ? "下学期（学年待核对）" : term;
}

export function TeacherDetail({
  teacherId,
  initialReviewQuery = "",
  initialReviewSort = "latest",
  initialPanel = "reviews",
  initialCourseId = "",
}: {
  teacherId: string;
  initialReviewQuery?: string;
  initialReviewSort?: ReviewSort;
  initialPanel?: "reviews" | "teaching";
  initialCourseId?: string;
}) {
  const [teachingOpen, setTeachingOpen] = useState(initialPanel === "teaching" || Boolean(initialCourseId));
  const textbookTarget = useRef<HTMLElement | null>(null);
  const locatedCourse = useRef("");
  const [courseFilter, setCourseFilter] = useState(initialCourseId);
  const [teacher, setTeacher] = useState<TeacherDetailData | null>(null);
  const [reviews, setReviews] = useState<TeacherReview[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reviewListStatus, setReviewListStatus] = useState<"loading" | "ready" | "error">("loading");
  const [reviewMoreStatus, setReviewMoreStatus] = useState<"idle" | "loading" | "error">("idle");
  const reviewGeneration = useRef(0);
  const reviewMoreRequest = useRef<AbortController | null>(null);
  const [reviewQuery, setReviewQuery] = useState(initialReviewQuery);
  const [reviewSort, setReviewSort] = useState<ReviewSort>(initialReviewSort);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [accountStatus, setAccountStatus] = useState<"loading" | "guest" | "ready" | "error">("loading");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [ownReview, setOwnReview] = useState<OwnTeacherReview | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [reviewAction, setReviewAction] = useState<"idle" | "saving" | "deleting">("idle");
  const [reviewNotice, setReviewNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [revision, setRevision] = useState(0);

  const reviewEndpoint = useCallback((cursor?: string) => {
    const query = new URLSearchParams({ limit: "20", sort: reviewSort });
    if (reviewQuery) query.set("q", reviewQuery);
    if (cursor) query.set("after", cursor);
    return `/api/teachers/${teacherId}/reviews?${query.toString()}`;
  }, [reviewQuery, reviewSort, teacherId]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setStatus("loading");
      try {
        const [detailResponse, ownReviewResponse, sessionResponse] = await Promise.all([
          fetch(`/api/teachers/${teacherId}`, { signal: controller.signal, cache: "no-store", headers: { Accept: "application/json" } }),
          fetch(`/api/teachers/${teacherId}/my-review`, { signal: controller.signal, headers: { Accept: "application/json" } }),
          fetch("/api/auth/session", { signal: controller.signal, cache: "no-store", headers: { Accept: "application/json" } }),
        ]);
        if (detailResponse.status === 404) {
          setStatus("missing");
          return;
        }
        if (!detailResponse.ok) throw new Error("teacher_unavailable");
        setTeacher(((await detailResponse.json()) as { teacher: TeacherDetailData }).teacher);
        if (ownReviewResponse.status === 401) {
          setAccountStatus("guest");
          setOwnReview(null);
        } else if (ownReviewResponse.ok) {
          const ownPayload = await ownReviewResponse.json() as { review: OwnTeacherReview | null };
          setOwnReview(ownPayload.review);
          setAccountStatus("ready");
          if (ownPayload.review) {
            setDraftBody(ownPayload.review.body);
          }
        } else {
          setAccountStatus("error");
        }
        if (sessionResponse.ok) {
          const session = await sessionResponse.json() as { authenticated?: boolean; user?: { id?: string } | null };
          setCurrentUserId(session.authenticated && session.user?.id ? session.user.id : null);
        } else {
          setCurrentUserId(null);
        }
        setStatus("ready");
      } catch (error) {
        if ((error as Error).name !== "AbortError") setStatus("error");
      }
    }
    void load();
    return () => controller.abort();
  }, [teacherId, revision]);

  useEffect(() => {
    // Old course links still locate the textbook, without making reviews a hidden panel.
    const target = `${teacherId}:${initialCourseId}`;
    if (status === "ready" && initialCourseId && locatedCourse.current !== target) {
      textbookTarget.current?.scrollIntoView({ block: "start" });
      locatedCourse.current = target;
    }
  }, [initialCourseId, status, teacherId]);

  useEffect(() => {
    const generation = ++reviewGeneration.current;
    const controller = new AbortController();
    reviewMoreRequest.current?.abort();
    reviewMoreRequest.current = null;
    async function loadReviews() {
      setReviewListStatus("loading");
      try {
        const response = await fetch(reviewEndpoint(), {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("teacher_reviews_unavailable");
        const payload = await response.json() as { items: TeacherReview[]; nextCursor: string | null };
        if (controller.signal.aborted || generation !== reviewGeneration.current) return;
        setReviews(payload.items);
        setNextCursor(payload.nextCursor);
        setReviewMoreStatus("idle");
        setReviewListStatus("ready");
      } catch (error) {
        if (!controller.signal.aborted && generation === reviewGeneration.current && (error as Error).name !== "AbortError") setReviewListStatus("error");
      }
    }
    void loadReviews();
    return () => {
      controller.abort();
      reviewMoreRequest.current?.abort();
      reviewMoreRequest.current = null;
      if (generation === reviewGeneration.current) reviewGeneration.current += 1;
    };
  }, [reviewEndpoint, revision]);

  async function loadMoreReviews() {
    if (!nextCursor || reviewListStatus !== "ready" || reviewMoreRequest.current) return;
    const generation = reviewGeneration.current;
    const controller = new AbortController();
    reviewMoreRequest.current = controller;
    setReviewMoreStatus("loading");
    try {
      const response = await fetch(reviewEndpoint(nextCursor), {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("teacher_reviews_unavailable");
      const payload = await response.json() as { items: TeacherReview[]; nextCursor: string | null };
      if (controller.signal.aborted || generation !== reviewGeneration.current) return;
      setReviews((current) => {
        const knownIds = new Set(current.map((review) => review.id));
        return [...current, ...payload.items.filter((review) => !knownIds.has(review.id))];
      });
      setNextCursor(payload.nextCursor);
      setReviewMoreStatus("idle");
    } catch (error) {
      if (!controller.signal.aborted && generation === reviewGeneration.current && (error as Error).name !== "AbortError") setReviewMoreStatus("error");
    } finally {
      if (reviewMoreRequest.current === controller) reviewMoreRequest.current = null;
    }
  }

  function invalidateReviewRequests() {
    reviewGeneration.current += 1;
    reviewMoreRequest.current?.abort();
    reviewMoreRequest.current = null;
    setReviewMoreStatus("idle");
    setReviewListStatus("loading");
  }

  function clearReviewSearch() {
    if (reviewQuery || reviewSort !== "latest") invalidateReviewRequests();
    setReviewQuery("");
    setReviewSort("latest");
    const url = new URL(window.location.href);
    url.searchParams.delete("reviewQuery");
    url.searchParams.delete("reviewSort");
    url.searchParams.delete("q");
    url.searchParams.delete("sort");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function openComposer() {
    if (ownReview) {
      setDraftBody(ownReview.body);
    }
    setReviewNotice("");
    setConfirmDelete(false);
    setComposerOpen(true);
  }

  async function saveReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftBody.normalize("NFKC").trim()) {
      setReviewNotice("请写下评价内容。");
      return;
    }
    setReviewAction("saving");
    setReviewNotice("");
    const payload: { body: string; expectedVersion?: number } = {
      body: draftBody,
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
      setReviews((current) => {
        const withoutSavedReview = current.filter((review) => review.id !== saved.review.id);
        if (saved.review.status !== "published") return withoutSavedReview;
        return [
          {
            id: saved.review.id,
            sourceType: saved.review.sourceType,
            authorLabel: saved.review.authorLabel,
            body: saved.review.body,
            discussionCount: current.find((review) => review.id === saved.review.id)?.discussionCount ?? 0,
            publishedAt: saved.review.publishedAt,
          },
          ...withoutSavedReview,
        ];
      });
      setComposerOpen(false);
      setReviewNotice(saved.review.status === "published"
        ? ownReview ? "评价已修改。" : "评价已发布。"
        : "评价当前未公开。");
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
    return <main className={styles.page}><PublicMasthead navigationLabel="教师详情导航" items={[{ href: "/?view=catalog", label: "课程" }, { href: "/teachers", label: "教师", current: true }, { href: "/materials", label: "资料" }]} /><div className={styles.fullState}><b>这份教师档案不存在或已撤下。</b><Link href="/teachers">返回教师索引</Link></div></main>;
  }
  if (status === "error") {
    return <main className={styles.page}><PublicMasthead navigationLabel="教师详情导航" items={[{ href: "/?view=catalog", label: "课程" }, { href: "/teachers", label: "教师", current: true }, { href: "/materials", label: "资料" }]} /><div className={styles.fullState} role="alert"><b>教师档案暂时没有连上。</b><button onClick={() => setRevision((value) => value + 1)}>重新读取</button></div></main>;
  }
  if (!teacher) {
    return <main className={styles.page}><PublicMasthead navigationLabel="教师详情导航" items={[{ href: "/?view=catalog", label: "课程" }, { href: "/teachers", label: "教师", current: true }, { href: "/materials", label: "资料" }]} /><div className={styles.fullState} role="status">正在读取教师档案…</div></main>;
  }

  return (
    <main className={styles.page} id="main-content">
      <PublicMasthead
        navigationLabel="教师详情导航"
        items={[
          { href: "/?view=catalog", label: "课程", showOnMobile: false },
          { href: "/teachers", label: "教师", current: true },
          { href: `/materials?teacher=${encodeURIComponent(teacher.displayName)}`, label: "相关资料" },
          { href: "/?view=schedule", label: "我的课表", showOnMobile: false },
        ]}
      />
      <header className={styles.profileHeader}>
        <div>
          <p><Link href={`/teachers?college=${encodeURIComponent(teacher.collegeName)}`}>{teacher.collegeName}</Link></p>
          <h1>{teacher.displayName}</h1>
        </div>
        <a className={styles.writeReviewLink} href="#teacher-contribution">{ownReview ? "我的评价" : "写评价"}</a>
      </header>

      <div className={styles.profileContent}>
      <section className={styles.reviews} aria-labelledby="teacher-reviews-title">
        <header><h2 id="teacher-reviews-title">学生评价 <span>{teacher.reviewCount}</span></h2></header>
        <div>
          {(reviewQuery || reviewSort !== "latest") && <p className={styles.reviewFilterNotice}>
            {reviewQuery ? `筛选：“${reviewQuery}”` : "按旧链接排序"}
            <button type="button" onClick={clearReviewSearch}>查看全部评价</button>
          </p>}

          {reviewListStatus === "loading" && <p className={styles.inlineEmpty} role="status">正在读取评价…</p>}
          {reviewListStatus === "error" && <p className={styles.inlineEmpty} role="alert">评价加载失败。 <button type="button" onClick={() => setRevision((value) => value + 1)}>重新读取</button></p>}
          {reviewListStatus === "ready" && reviews.length ? reviews.map((review) => (
            <article className={styles.reviewEntry} key={review.id}>
              <div className={styles.reviewEntryMeta}><b>{review.sourceType === "legacy_approved" ? "学长学姐 · 历史评价" : review.authorLabel}</b><span>{review.sourceType === "legacy_approved" ? "站内公开于 " : ""}<time dateTime={review.publishedAt}>{new Date(review.publishedAt).toLocaleDateString("zh-CN")}</time>{review.discussionCount > 0 ? ` · ${review.discussionCount} 条回复` : ""}</span></div>
              <p className={styles.reviewEntryBody}>{review.body}</p>
              <TeacherReviewDiscussion teacherId={teacherId} reviewId={review.id} reviewLabel={`${review.authorLabel}的评价`} canWrite={Boolean(currentUserId)} currentUserId={currentUserId} />
            </article>
          )) : reviewListStatus === "ready" && <p className={styles.inlineEmpty}>{reviewQuery ? `没有找到包含“${reviewQuery}”的公开评价。` : "还没有公开评价。"}</p>}
        </div>
        {reviewListStatus === "ready" && nextCursor && (
          <div className={styles.reviewPagination} aria-busy={reviewMoreStatus === "loading"}>
            {reviewMoreStatus === "error" && <p role="status">后续评价暂时没有加载成功，已读内容仍保留。</p>}
            <button className={styles.loadMore} disabled={reviewMoreStatus === "loading"} onClick={() => void loadMoreReviews()}>
              {reviewMoreStatus === "loading" ? "正在读取…" : reviewMoreStatus === "error" ? "重新读取更多评价" : "继续查看评价"}
            </button>
          </div>
        )}
          <section className={styles.reviewContribution} id="teacher-contribution" aria-labelledby="teacher-contribution-title">
            <h2 id="teacher-contribution-title">{ownReview ? "我的评价" : "写评价"}</h2>
            {accountStatus === "loading" && <p>正在确认登录状态…</p>}
            {accountStatus === "guest" && (
              <div><Link href="/?view=me">登录后写评价</Link></div>
            )}
            {accountStatus === "error" && <p role="status">暂时无法读取你的评价，公开内容仍可正常浏览。</p>}
            {accountStatus === "ready" && ownReview && (ownReview.status === "hidden" || !composerOpen) && (
              <div>
                {ownReview.status === "hidden" && <p>评价已隐藏，审核期间不可修改，仍可删除。</p>}
                {ownReview.status === "hidden" ? (
                  <div className={styles.reviewActions}>
                    {!confirmDelete && <button type="button" onClick={() => setConfirmDelete(true)} disabled={reviewAction !== "idle"}>删除我的评价</button>}
                    {confirmDelete && <><span>确定删除这条评价？</span><button type="button" onClick={() => void deleteReview()} disabled={reviewAction !== "idle"}>{reviewAction === "deleting" ? "正在删除" : "确认删除"}</button><button type="button" onClick={() => setConfirmDelete(false)} disabled={reviewAction !== "idle"}>取消</button></>}
                  </div>
                ) : <button type="button" onClick={openComposer}>修改我的评价</button>}
              </div>
            )}
            {accountStatus === "ready" && ownReview?.status !== "hidden" && (!ownReview || composerOpen) && (
              <form onSubmit={(event) => void saveReview(event)}>
                <FormField label="评价正文" counter={`${draftBody.normalize("NFKC").trim().length} / 3000`}>
                  <textarea disabled={reviewAction !== "idle"} required value={draftBody} onChange={(event) => setDraftBody(event.target.value)} minLength={1} maxLength={3000} rows={3} placeholder="写下你的课堂体验…" />
                </FormField>
                <div className={styles.reviewActions}>
                  <button type="submit" disabled={reviewAction !== "idle"}>{reviewAction === "saving" ? "正在保存" : ownReview ? "保存修改" : "发布评价"}</button>
                  {ownReview && <button type="button" onClick={() => setComposerOpen(false)} disabled={reviewAction !== "idle"}>取消修改</button>}
                  {ownReview && !confirmDelete && <button type="button" onClick={() => setConfirmDelete(true)} disabled={reviewAction !== "idle"}>删除我的评价</button>}
                  {ownReview && confirmDelete && <><span>确定删除这条评价？</span><button type="button" onClick={() => void deleteReview()} disabled={reviewAction !== "idle"}>{reviewAction === "deleting" ? "正在删除" : "确认删除"}</button><button type="button" onClick={() => setConfirmDelete(false)} disabled={reviewAction !== "idle"}>取消</button></>}
                </div>
              </form>
            )}
            {reviewNotice && <p className={styles.reviewNotice} role="status">{reviewNotice}</p>}
          </section>
      </section>
      <details className={styles.teachingDetails} open={teachingOpen} onToggle={(event) => setTeachingOpen(event.currentTarget.open)}>
        <summary>课程与教材</summary>
        <section className={styles.textbooks} ref={textbookTarget} id="teacher-textbooks" aria-labelledby="teacher-textbooks-title">
          <header><h2 id="teacher-textbooks-title">教材</h2></header>
          {courseFilter && <p className={styles.reviewFilterNotice}>课程号：{courseFilter} <button type="button" onClick={() => {
            setCourseFilter("");
            const url = new URL(window.location.href);
            url.searchParams.delete("course");
            window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
          }}>查看全部教材</button></p>}
          <div>
            {teacher.textbooks.filter((book) => !courseFilter || book.courseId === courseFilter).length ? teacher.textbooks.filter((book) => !courseFilter || book.courseId === courseFilter).map((book) => (
              <article key={book.id}>
                <small>{termLabel(book.termKey)} · {book.courseTitle} · {book.courseId} · 课序号 {book.sectionNo}{book.status === "needs_review" ? " · 待核对" : ""}</small>
                <h3>{book.selectionStatus === "not_specified" ? "不指定教材" : book.title ?? "教材待核对"}</h3>
                {book.selectionStatus !== "not_specified" && <dl className={styles.bookFacts}>
                  <div><dt>版次</dt><dd>{book.edition || "原表未提供"}</dd></div>
                  {book.author && <div><dt>作者</dt><dd>{book.author}</dd></div>}
                  {book.publisher && <div><dt>出版社</dt><dd>{book.publisher}</dd></div>}
                  {book.isbn && <div><dt>ISBN</dt><dd>{book.isbn}</dd></div>}
                </dl>}
              </article>
            )) : <p className={styles.inlineEmpty}>{courseFilter ? "该课程暂未记录教材。" : "暂未记录教材。"}</p>}
          </div>
        </section>
        <section className={styles.courseLedger} aria-labelledby="teacher-courses-title">
          <header><h2 id="teacher-courses-title">教学班记录</h2></header>
          {teacher.sections.length ? teacher.sections.map((section) => (
            <div key={section.id}>
              <span>{termLabel(section.termKey)}</span>
              <strong>{section.courseTitle}</strong>
              <small>{section.courseId} · 课序号 {section.sectionNo}{section.status === "needs_review" ? " · 待核对" : ""}</small>
            </div>
          )) : <p className={styles.inlineEmpty}>暂未记录具体教学班。</p>}
        </section>
      </details>
      </div>
    </main>
  );
}
