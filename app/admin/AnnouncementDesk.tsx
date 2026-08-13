"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { DialogActions, DialogBackdrop } from "../DialogBackdrop";
import { FormField } from "../FormField";
import { useModalFocus } from "../use-modal-focus";
import styles from "./admin.module.css";

type Announcement = {
  id: string;
  title: string;
  body: string;
  fallbackPath: string;
  audience: "all_active";
  deliveryCount: number;
  createdByLabel: string;
  createdAt: string;
  duplicate?: boolean;
};

type ApiError = Error & { code?: string; status?: number };

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: init?.body
      ? { "Content-Type": "application/json", ...init.headers }
      : init?.headers,
  });
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) {
    const error = new Error("announcement request failed") as ApiError;
    error.status = response.status;
    error.code = typeof body?.error === "string" ? body.error : undefined;
    throw error;
  }
  return body as T;
}

function errorMessage(error: unknown) {
  const code = (error as ApiError)?.code;
  if (code === "community_announcement_rate_limited") {
    return "发布过于频繁。请至少等待十分钟，确认没有重复公告后再试。";
  }
  if (code === "community_announcement_mutation_conflict") {
    return "本次发布凭据已用于另一份内容。请关闭预览、重新核对后再发布。";
  }
  if (code === "invalid_community_announcement") {
    return "公告内容或站内路径不符合要求，请重新核对。";
  }
  return "公告没有完成发布。内容仍保留在本页，可以原样重试。";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function validPath(value: string) {
  const path = value.trim();
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !path.includes("://") &&
    path.length <= 500
  );
}

export function AnnouncementDesk({
  onMfaExpired,
  onAuditChanged,
}: {
  onMfaExpired: () => void;
  onAuditChanged: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [fallbackPath, setFallbackPath] = useState("/community");
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const mutationId = useRef("");
  const previewRef = useModalFocus<HTMLFormElement>(
    previewing,
    closePreview,
    publishing,
  );

  const loadAnnouncements = useCallback(async () => {
    try {
      const response = await requestJson<{ announcements: Announcement[] }>(
        "/api/admin/community/announcements",
      );
      setAnnouncements(response.announcements);
    } catch (error) {
      if ((error as ApiError).code === "admin_mfa_required") {
        onMfaExpired();
      } else {
        setFeedback("历史公告暂时没有读取成功，不影响尚未提交的草稿。");
      }
    } finally {
      setLoading(false);
    }
  }, [onMfaExpired]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void loadAnnouncements();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadAnnouncements]);

  const ready =
    title.trim().length >= 4 &&
    title.trim().length <= 160 &&
    body.trim().length >= 1 &&
    body.trim().length <= 500 &&
    validPath(fallbackPath);

  function openPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    mutationId.current = window.crypto.randomUUID();
    setFeedback("");
    setPreviewing(true);
  }

  function closePreview() {
    if (publishing) return;
    mutationId.current = "";
    setPreviewing(false);
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !mutationId.current) return;
    setPublishing(true);
    setFeedback("");
    try {
      const response = await requestJson<{ announcement: Announcement }>(
        "/api/admin/community/announcements",
        {
          method: "POST",
          body: JSON.stringify({
            mutationId: mutationId.current,
            title: title.trim(),
            body: body.trim(),
            fallbackPath: fallbackPath.trim(),
          }),
        },
      );
      setTitle("");
      setBody("");
      setFallbackPath("/community");
      mutationId.current = "";
      setPreviewing(false);
      setFeedback(
        `公告已${response.announcement.duplicate ? "确认" : "投递"}给 ${response.announcement.deliveryCount} 个活跃账号。`,
      );
      await Promise.all([loadAnnouncements(), onAuditChanged()]);
    } catch (error) {
      if ((error as ApiError).code === "admin_mfa_required") {
        setPreviewing(false);
        onMfaExpired();
      } else {
        setFeedback(errorMessage(error));
      }
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section className={styles.announcementDesk} aria-labelledby="admin-announcement-title">
      <header>
        <div>
          <span>BROADCAST</span>
          <h2 id="admin-announcement-title">系统公告</h2>
          <p>面向全部活跃账号发送站内通知。每次发布都会永久保留公告主记录与值守审计。</p>
        </div>
        <b>全站 · 活跃账号</b>
      </header>

      {feedback && <p className={styles.announcementFeedback} role="status">{feedback}</p>}

      <div className={styles.announcementLayout}>
        <form className={styles.announcementComposer} onSubmit={openPreview}>
          <FormField label="通知标题" counter={`${title.length}/160`} className={styles.caseField}>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              placeholder="用一句话说明发生了什么"
            />
          </FormField>
          <FormField label="通知正文" counter={`${body.length}/500`} className={styles.caseField}>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={500}
              rows={5}
              placeholder="说明影响范围、时间和学生需要采取的动作"
            />
          </FormField>
          <FormField label="点击后的站内路径" counter={`${fallbackPath.length}/500`} className={styles.caseField}>
            <input
              value={fallbackPath}
              onChange={(event) => setFallbackPath(event.target.value)}
              maxLength={500}
              spellCheck={false}
              inputMode="url"
            />
          </FormField>
          <button className={styles.announcementPreviewButton} disabled={!ready}>
            预览投递
          </button>
        </form>

        <aside className={styles.announcementHistory} aria-label="最近系统公告">
          <h3>最近投递</h3>
          {loading ? (
            <p>正在读取公告记录…</p>
          ) : announcements.length === 0 ? (
            <p>还没有系统公告。</p>
          ) : (
            <ol>
              {announcements.map((announcement) => (
                <li key={announcement.id}>
                  <time dateTime={announcement.createdAt}>{formatDate(announcement.createdAt)}</time>
                  <b>{announcement.title}</b>
                  <small>{announcement.deliveryCount} 个账号 · {announcement.createdByLabel}</small>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>

      {previewing && (
        <DialogBackdrop onDismiss={closePreview} dismissDisabled={publishing}>
          <form
            ref={previewRef}
            className={styles.announcementSheet}
            onSubmit={publish}
            role="dialog"
            aria-modal="true"
            aria-labelledby="announcement-preview-title"
          >
            <span>发布前最后核对</span>
            <h2 id="announcement-preview-title">{title.trim()}</h2>
            <p className={styles.announcementPreviewBody}>{body.trim()}</p>
            <dl>
              <div><dt>投递范围</dt><dd>全部活跃账号</dd></div>
              <div><dt>点击前往</dt><dd>{fallbackPath.trim()}</dd></div>
            </dl>
            {feedback && <p className={styles.caseFeedback} role="alert">{feedback}</p>}
            <DialogActions>
              <button type="button" onClick={closePreview} disabled={publishing}>返回修改</button>
              <button disabled={publishing}>{publishing ? "正在原子投递" : "确认发布"}</button>
            </DialogActions>
          </form>
        </DialogBackdrop>
      )}
    </section>
  );
}
