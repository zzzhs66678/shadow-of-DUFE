"use client";

import { FormEvent, useCallback, useState } from "react";
import Link from "next/link";
import { FormField } from "../FormField";
import { ReportDialog } from "../community/CommunityShared";
import { authorName, communityErrorMessage, communityRequest, formatCommunityTime, type CommunityAuthor } from "../community/community-api";
import styles from "./teachers.module.css";

type TeacherReviewComment = {
  id: string;
  reviewId: string;
  parentCommentId: string | null;
  rootCommentId: string | null;
  replyToUserId: string | null;
  body: string | null;
  status: "published" | "hidden" | "deleted" | "blocked";
  version: number;
  author: CommunityAuthor | null;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
};

type ReportTarget = {
  type: "teacher_review" | "teacher_review_comment";
  id: string;
  label: string;
};

export function TeacherReviewDiscussion({
  teacherId,
  reviewId,
  reviewLabel,
  canWrite,
  currentUserId,
}: {
  teacherId: string;
  reviewId: string;
  reviewLabel: string;
  canWrite: boolean;
  currentUserId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TeacherReviewComment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<TeacherReviewComment | null>(null);
  const [editing, setEditing] = useState<TeacherReviewComment | null>(null);
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);

  const load = useCallback(async (cursor?: string, append = false, signal?: AbortSignal) => {
    const suffix = cursor ? `&after=${encodeURIComponent(cursor)}` : "";
    const payload = await communityRequest<{ items: TeacherReviewComment[]; nextCursor: string | null }>(
      `/api/teachers/${teacherId}/reviews/${reviewId}/comments?limit=20${suffix}`,
      { signal },
    );
    setItems((current) => append
      ? [...current, ...payload.items.filter((item) => !current.some((existing) => existing.id === item.id))]
      : [
          ...payload.items,
          ...current.filter((item) => !payload.items.some((loaded) => loaded.id === item.id)),
        ]);
    setNextCursor(payload.nextCursor);
  }, [reviewId, teacherId]);

  const loadInitial = useCallback(async () => {
    setStatus("loading");
    try {
      await load();
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [load]);

  function toggleDiscussion() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (status === "idle") void loadInitial();
  }

  function beginReply(comment?: TeacherReviewComment) {
    setReplyTo(comment ?? null);
    setEditing(null);
    setDraft("");
    setFeedback("");
  }

  function beginEdit(comment: TeacherReviewComment) {
    setEditing(comment);
    setReplyTo(null);
    setDraft(comment.body ?? "");
    setFeedback("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.normalize("NFKC").trim();
    if (!body) return;
    setBusy("save");
    setFeedback("");
    try {
      if (editing) {
        const payload = await communityRequest<{ comment: TeacherReviewComment }>(
          `/api/teachers/review-comments/${editing.id}`,
          { method: "PATCH", body: JSON.stringify({ body, version: editing.version }) },
        );
        setItems((current) => current.map((item) => item.id === payload.comment.id ? payload.comment : item));
      } else {
        const payload = await communityRequest<{ comment: TeacherReviewComment }>(
          `/api/teachers/${teacherId}/reviews/${reviewId}/comments`,
          { method: "POST", body: JSON.stringify({ body, replyToCommentId: replyTo?.id ?? null }) },
        );
        setItems((current) => [...current, payload.comment]);
      }
      setDraft("");
      setReplyTo(null);
      setEditing(null);
      setFeedback("回复已发布。");
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function remove(comment: TeacherReviewComment) {
    if (!window.confirm("删除后讨论位置仍会保留，确认删除这条回复？")) return;
    setBusy(comment.id);
    try {
      const payload = await communityRequest<{ comment: TeacherReviewComment }>(
        `/api/teachers/review-comments/${comment.id}`,
        { method: "DELETE", body: JSON.stringify({ version: comment.version }) },
      );
      setItems((current) => current.map((item) => item.id === payload.comment.id ? payload.comment : item));
      setFeedback("回复已删除。");
    } catch (error) {
      setFeedback(communityErrorMessage(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className={styles.reviewDiscussion} aria-label={`关于${reviewLabel}的讨论`}>
      <div className={styles.reviewDiscussionBar}>
        <button type="button" aria-expanded={open} onClick={toggleDiscussion}>
          {open ? "收起讨论" : "展开讨论"}
        </button>
        {canWrite && <button type="button" onClick={() => setReportTarget({ type: "teacher_review", id: reviewId, label: reviewLabel })}>举报评价</button>}
      </div>

      {open && (
        <div className={styles.reviewThread}>
          {status === "loading" && <p role="status">正在读取讨论…</p>}
          {status === "error" && <p role="alert">讨论暂时没有加载成功。<button onClick={() => { setFeedback(""); void loadInitial(); }}>重试</button></p>}
          {status === "ready" && items.length === 0 && <p>还没有回复。可以从具体课堂体验继续讨论。</p>}
          {status === "ready" && items.length > 0 && (
            <ol>
              {items.map((comment) => {
                const unavailable = comment.status !== "published" || !comment.body;
                return (
                  <li key={comment.id} data-reply={Boolean(comment.rootCommentId)}>
                    <div>
                      <b>{unavailable ? "内容不可见" : authorName(comment.author)}</b>
                      <time dateTime={comment.createdAt}>{formatCommunityTime(comment.createdAt)}</time>
                    </div>
                    <p>{unavailable ? "这条回复已不可见，讨论位置仍被保留。" : comment.body}</p>
                    {!unavailable && canWrite && (
                      <menu>
                        <li><button type="button" onClick={() => beginReply(comment)}>回复</button></li>
                        {comment.author?.id === currentUserId && <li><button type="button" onClick={() => beginEdit(comment)}>编辑</button></li>}
                        {comment.author?.id === currentUserId && <li><button type="button" onClick={() => void remove(comment)} disabled={busy === comment.id}>删除</button></li>}
                        <li><button type="button" onClick={() => setReportTarget({ type: "teacher_review_comment", id: comment.id, label: "教师评价回复" })}>举报</button></li>
                      </menu>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {nextCursor && <button type="button" onClick={() => { setBusy("more"); void load(nextCursor, true).then(() => setBusy(""), () => { setBusy(""); setStatus("error"); }); }} disabled={busy === "more"}>{busy === "more" ? "正在读取" : "继续读取回复"}</button>}

          {canWrite ? (
            <form className={styles.reviewReplyForm} onSubmit={(event) => void submit(event)}>
              <header>
                <b>{editing ? "修改回复" : replyTo ? `回复 ${authorName(replyTo.author)}` : "参与讨论"}</b>
                {(editing || replyTo) && <button type="button" onClick={() => { setEditing(null); setReplyTo(null); setDraft(""); }}>取消</button>}
              </header>
              <FormField label="只讨论具体教学体验" counter={`${draft.length} / 3000`}>
                <textarea name="teacher-review-reply" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={3000} rows={3} />
              </FormField>
              <button disabled={busy === "save" || draft.trim().length < 1}>{busy === "save" ? "正在发布" : editing ? "保存修改" : "发布回复"}</button>
            </form>
          ) : <p><Link href="/?view=me">登录后回复或举报</Link></p>}
          {feedback && <p className={styles.reviewNotice} role="status">{feedback}</p>}
        </div>
      )}

      <ReportDialog target={reportTarget} onClose={() => setReportTarget(null)} onReported={setFeedback} />
    </section>
  );
}
