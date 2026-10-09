"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { UserRegistration } from "./UserRegistration";
import { DialogActions, DialogBackdrop } from "../DialogBackdrop";
import { FormField } from "../FormField";
import { useModalFocus } from "../use-modal-focus";
import styles from "./admin.module.css";
import { ModerationDesk } from "./ModerationDesk";
import { ActiveContentDesk } from "./ActiveContentDesk";
import { AnnouncementDesk } from "./AnnouncementDesk";
import { TeacherReviewDesk } from "./TeacherReviewDesk";

type AccessState = {
  role: "admin";
  mfaConfigured: boolean;
  elevated: boolean;
  elevatedUntil: string | null;
};

type Overview = {
  totalUsers: number;
  activeUsers: number;
  disabledUsers: number;
  administrators: number;
  verifiedEmails: number;
  registrationTrend: Array<{ date: string; count: number }>;
};

type AdminUser = {
  id: string;
  username: string | null;
  displayName: string | null;
  emailMasked: string | null;
  emailVerified: boolean;
  schoolAccountVerified: boolean;
  status: "active" | "disabled";
  role: "user" | "moderator" | "admin";
  createdAt: string;
  lastLoginAt: string | null;
};

type AuditEvent = {
  id: string;
  actorUserId: string | null;
  actorRole: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type UserFilters = {
  query: string;
  role: "" | "user" | "moderator" | "admin";
  status: "" | "active" | "disabled";
  registeredFrom: string;
  registeredTo: string;
};

type Screen =
  | "loading"
  | "anonymous"
  | "forbidden"
  | "unconfigured"
  | "elevation"
  | "dashboard"
  | "error";

type ApiError = Error & { status?: number; code?: string };

const actionLabels: Record<string, string> = {
  "admin.elevation.created": "管理员完成二次验证",
  "admin.user.status_changed": "用户状态已变更",
  "admin.user.registration_viewed": "已查看用户注册资料",
  "admin.bootstrap.created": "管理员权限已建立",
  "admin.mfa.rotated": "管理员验证器已轮换",
  "admin.community.case_opened": "社区举报已入案",
  "admin.community.hide": "社区内容已隐藏",
  "admin.community.restore": "社区内容已恢复",
  "admin.community.delete": "社区内容已删除",
  "admin.community.warn": "社区账号已警告",
  "admin.community.suspend": "社区账号已限时停发",
  "admin.community.ban": "社区账号已封禁",
  "admin.community.unban": "社区账号制裁已解除",
  "admin.community.dismiss": "社区举报已驳回",
  "admin.community.announcement_published": "系统公告已发布",
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: init?.body
      ? { "Content-Type": "application/json", ...init.headers }
      : init?.headers,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!response.ok) {
    const error = new Error(payload.error || "request_failed") as ApiError;
    error.status = response.status;
    error.code = payload.error;
    throw error;
  }
  return payload;
}

function formatDate(value: string | null, includeTime = true) {
  if (!value) return "从未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
  }).format(date);
}

function errorMessage(error: unknown) {
  const apiError = error as ApiError;
  switch (apiError.code) {
    case "admin_mfa_invalid":
      return "验证码无效、已使用或已过期。请等待新验证码后重试。";
    case "admin_mfa_rate_limited":
      return "尝试次数过多，请一分钟后再试。";
    case "admin_mfa_required":
      return "本次值守凭证已失效，请重新验证。";
    case "admin_self_disable_forbidden":
      return "不能停用当前正在值守的管理员账号。";
    case "admin_user_status_conflict":
      return "这名用户的状态刚刚发生变化，列表已刷新。";
    case "invalid_admin_user_update":
      return "请填写至少 8 个字的处置原因。";
    default:
      return "请求没有完成。请检查网络后重试。";
  }
}

const emptyUserFilters: UserFilters = {
  query: "",
  role: "",
  status: "",
  registeredFrom: "",
  registeredTo: "",
};

function userFilterSearch(filters: UserFilters, cursor?: string | null) {
  const query = new URLSearchParams({ limit: "20" });
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export function AdminConsole() {
  const [workspace, setWorkspace] = useState("users");
  const [reviewTab, setReviewTab] = useState("reports");
  const [screen, setScreen] = useState<Screen>("loading");
  const [access, setAccess] = useState<AccessState | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [filters, setFilters] = useState<UserFilters>(emptyUserFilters);
  const [activeFilters, setActiveFilters] = useState<UserFilters>(emptyUserFilters);
  const [usersCursor, setUsersCursor] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState("");
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [registrationUserId, setRegistrationUserId] = useState<string | null>(null);
  const closeRegistration = useCallback(() => setRegistrationUserId(null), []);
  const [reason, setReason] = useState("");
  const closeUserAction = useCallback(() => setTarget(null), []);
  const actionDialogRef = useModalFocus<HTMLFormElement>(Boolean(target), closeUserAction, Boolean(busy));

  const loadAudit = useCallback(async () => {
    const payload = await requestJson<{ events: AuditEvent[] }>("/api/admin/audit");
    setAudit(payload.events);
  }, []);

  const handleMfaExpired = useCallback(() => {
    setRegistrationUserId(null);
    setScreen("elevation");
  }, []);

  useEffect(() => {
    const readLocation = () => {
      const [section, review] = window.location.hash.slice(1).split("-");
      if (["users", "review", "notices", "audit"].includes(section)) setWorkspace(section);
      if (["reports", "content", "history"].includes(review)) setReviewTab(review);
    };
    const frame = window.requestAnimationFrame(readLocation);
    window.addEventListener("hashchange", readLocation);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("hashchange", readLocation); };
  }, []);

  function navigate(section: string, review = reviewTab) {
    setWorkspace(section);
    setReviewTab(review);
    window.history.replaceState(null, "", `#${section}${section === "review" ? `-${review}` : ""}`);
    if (section === "audit") void loadAudit().catch((error) => setFeedback(errorMessage(error)));
  }

  const loadDashboard = useCallback(async (nextFilters = emptyUserFilters) => {
    const [overviewPayload, usersPayload] = await Promise.all([
      requestJson<{ overview: Overview }>("/api/admin/overview"),
      requestJson<{ users: AdminUser[]; nextCursor: string | null }>(
        `/api/admin/users?${userFilterSearch(nextFilters)}`,
      ),
      loadAudit(),
    ]);
    setOverview(overviewPayload.overview);
    setUsers(usersPayload.users);
    setUsersCursor(usersPayload.nextCursor);
  }, [loadAudit]);

  const loadMoreUsers = useCallback(async () => {
    if (!usersCursor) return;
    setBusy("users-more");
    try {
      const payload = await requestJson<{ users: AdminUser[]; nextCursor: string | null }>(
        `/api/admin/users?${userFilterSearch(activeFilters, usersCursor)}`,
      );
      setUsers((current) => [
        ...current,
        ...payload.users.filter((user) => !current.some((existing) => existing.id === user.id)),
      ]);
      setUsersCursor(payload.nextCursor);
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setBusy("");
    }
  }, [activeFilters, usersCursor]);

  const loadAccess = useCallback(async () => {
    try {
      const nextAccess = await requestJson<AccessState>("/api/admin/session");
      setAccess(nextAccess);
      if (!nextAccess.mfaConfigured) {
        setScreen("unconfigured");
      } else if (!nextAccess.elevated) {
        setScreen("elevation");
      } else {
        await loadDashboard();
        setScreen("dashboard");
      }
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.status === 401) setScreen("anonymous");
      else if (apiError.status === 403) setScreen("forbidden");
      else setScreen("error");
    }
  }, [loadDashboard]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void loadAccess();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadAccess]);

  const registrationPeak = useMemo(
    () => Math.max(1, ...(overview?.registrationTrend ?? []).map((item) => item.count)),
    [overview],
  );

  async function elevate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mfaCode.trim()) return;
    setBusy("elevation");
    setFeedback("");
    try {
      const next = await requestJson<{
        elevated: true;
        elevatedUntil: string;
      }>("/api/admin/elevation", {
        method: "POST",
        body: JSON.stringify({ code: mfaCode.trim() }),
      });
      setAccess((current) =>
        current
          ? { ...current, elevated: true, elevatedUntil: next.elevatedUntil }
          : current,
      );
      setMfaCode("");
      await loadDashboard();
      setScreen("dashboard");
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function searchUsers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = { ...filters, query: filters.query.normalize("NFKC").trim() };
    if (
      normalized.registeredFrom &&
      normalized.registeredTo &&
      normalized.registeredFrom > normalized.registeredTo
    ) {
      setFeedback("注册起日不能晚于注册止日，请调整日期后再查找。");
      return;
    }
    setBusy("search");
    setFeedback("");
    try {
      await loadDashboard(normalized);
      setFilters(normalized);
      setActiveFilters(normalized);
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.code === "admin_mfa_required") {
        setScreen("elevation");
      }
      setFeedback(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function changeStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || reason.trim().length < 8) return;
    const status = target.status === "active" ? "disabled" : "active";
    setBusy(`status:${target.id}`);
    setFeedback("");
    try {
      await requestJson(`/api/admin/users/${target.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          expectedStatus: target.status,
          reason: reason.trim(),
        }),
      });
      setTarget(null);
      setReason("");
      await loadDashboard(activeFilters);
      setFeedback(status === "disabled" ? "账号已停用，既有会话已撤销。" : "账号已恢复，可重新登录。历史会话不会恢复。");
    } catch (error) {
      setFeedback(errorMessage(error));
      if ((error as ApiError).code === "admin_mfa_required") {
        setTarget(null);
        setReason("");
        setScreen("elevation");
      } else if ((error as ApiError).code === "admin_user_status_conflict") {
        await loadDashboard(activeFilters);
        setTarget(null);
        setReason("");
      }
    } finally {
      setBusy("");
    }
  }

  async function endWatch() {
    setBusy("leave");
    try {
      await requestJson("/api/admin/elevation", { method: "DELETE" });
      setOverview(null);
      setUsers([]);
      setAudit([]);
      setAccess((current) =>
        current ? { ...current, elevated: false, elevatedUntil: null } : current,
      );
      setScreen("elevation");
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.masthead}>
        <Link className={styles.wordmark} href="/" aria-label="返回东财之影">
          <b>DUFE</b>
          <span>东财之影</span>
        </Link>
        <div>
          <span>管理后台</span>

        </div>
      </header>

      {screen === "loading" && (
        <section className={styles.statePanel} aria-live="polite">
          <i className={styles.seal}>守</i>
          <span>正在验证身份</span>
          <div className={styles.loadingRule} />
        </section>
      )}

      {screen === "anonymous" && (
        <StatePanel
          mark="未"
          eyebrow="需要登录"
          title="请先登录管理员账号"
          copy="登录后需输入动态验证码。"
          actionHref="/?view=me"
          actionLabel="返回我的"
        />
      )}

      {screen === "forbidden" && (
        <StatePanel
          mark="止"
          eyebrow="权限不足"
          title="仅管理员可访问"
          copy="请切换到管理员账号。"
          actionHref="/"
          actionLabel="返回首页"
        />
      )}

      {screen === "unconfigured" && (
        <StatePanel
          mark="锁"
          eyebrow="验证器未配置"
          title="管理员账号尚未完成安全初始化"
          copy="请在服务器终端运行管理员初始化命令。验证密钥和恢复码只会显示一次，不会通过网页传递。"
          actionHref="/"
          actionLabel="返回首页"
        />
      )}

      {screen === "error" && (
        <StatePanel
          mark="断"
          eyebrow="暂时不可用"
          title="暂时无法连接"
          copy="请检查网络后重试。"
          actionLabel="重新核对"
          onAction={() => {
            setScreen("loading");
            void loadAccess();
          }}
        />
      )}

      {screen === "elevation" && (
        <section className={styles.gate} aria-labelledby="admin-gate-title">
          <div className={styles.gateStatement}>
            <span>管理员验证</span>
            <h1 id="admin-gate-title">验证身份</h1>
            <p>输入认证器的 6 位动态码，或一次性恢复码。</p>

          </div>
          <form className={styles.gateForm} onSubmit={elevate}>
            <i className={styles.seal}>验</i>
            <label htmlFor="admin-mfa-code">动态码或恢复码</label>
            <input
              id="admin-mfa-code"
              name="code"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode="text"
              maxLength={40}
              autoFocus
              spellCheck={false}
              aria-describedby={feedback ? "admin-gate-feedback" : undefined}
            />
            <button disabled={busy === "elevation" || !mfaCode.trim()}>
              {busy === "elevation" ? "正在核对" : "进入后台"}
            </button>
            {feedback && <p id="admin-gate-feedback" role="alert">{feedback}</p>}
            <small>恢复码仅可使用一次。</small>
          </form>
        </section>
      )}

      {screen === "dashboard" && overview && (
        <div className={styles.workspace}>
          <aside className={styles.sidebar}>
            <span className={styles.sidebarLabel}>管理</span>
            <nav aria-label="管理功能">
              {[["users", "用户"], ["review", "内容审核"], ["notices", "通知"], ["audit", "操作记录"]].map(([key, label]) => (
                <button key={key} aria-pressed={workspace === key} onClick={() => navigate(key)}>{label}</button>
              ))}
            </nav>
            <Link href="/admin/data-feedback">数据反馈</Link>
            <Link href="/">返回网站 ↗</Link>
          </aside>
          <div className={styles.workspaceBody}>
            <header className={styles.deskHeading}>
              <div><h1>{{ users: "用户管理", review: "内容审核", notices: "通知公告", audit: "操作记录" }[workspace]}</h1></div>
              <div className={styles.watchStatus}><span>验证有效至 {access?.elevatedUntil ? new Date(access.elevatedUntil).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—"}</span><button onClick={endWatch} disabled={busy === "leave"}>退出管理</button></div>
            </header>
            {feedback && <div className={styles.feedback} role="status">{feedback}</div>}
            <div className={styles.panel} hidden={workspace !== "users"}>
              <section className={styles.ledger} aria-label="账号概况">
                <div><span>注册用户</span><strong>{overview.totalUsers}</strong></div>
                <div><span>正常</span><strong>{overview.activeUsers}</strong></div>
                <div><span>已停用</span><strong>{overview.disabledUsers}</strong></div>
                <div><span>邮箱已验证</span><strong>{overview.verifiedEmails}</strong></div>
              </section>
            <section className={styles.userBook} aria-labelledby="admin-users-title">
              <header>
                <div><h2 id="admin-users-title">注册用户</h2><span>{users.length} 个已加载账号</span></div>
                <form onSubmit={searchUsers} role="search">
                  <div>
                    <label htmlFor="admin-user-query">用户名或邮箱</label>
                    <input
                      id="admin-user-query"
                      name="query"
                      value={filters.query}
                      onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                      placeholder="搜索用户名或邮箱"
                      maxLength={64}
                    />
                  </div>
                  <button disabled={busy === "search"}>{busy === "search" ? "查找中" : "查找"}</button>
                  <details className={styles.userFilters}><summary>更多筛选</summary><div className={styles.filterFields}>
                  <div>
                    <label htmlFor="admin-user-role">角色</label>
                    <select id="admin-user-role" name="role" value={filters.role} onChange={(event) => setFilters((current) => ({ ...current, role: event.target.value as UserFilters["role"] }))}>
                      <option value="">全部角色</option><option value="user">学生</option><option value="moderator">审核员</option><option value="admin">管理员</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="admin-user-status">状态</label>
                    <select id="admin-user-status" name="status" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as UserFilters["status"] }))}>
                      <option value="">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="admin-user-from">注册起日</label>
                    <input id="admin-user-from" name="registeredFrom" type="date" value={filters.registeredFrom} onChange={(event) => setFilters((current) => ({ ...current, registeredFrom: event.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="admin-user-to">注册止日</label>
                    <input id="admin-user-to" name="registeredTo" type="date" value={filters.registeredTo} onChange={(event) => setFilters((current) => ({ ...current, registeredTo: event.target.value }))} />
                  </div>
                  </div></details>
                </form>
              </header>
              {Object.values(activeFilters).some(Boolean) && (
                <div className={styles.queryNote}>
                  已筛选
                  <button onClick={() => { setFilters(emptyUserFilters); setActiveFilters(emptyUserFilters); void loadDashboard(emptyUserFilters); }}>清除全部</button>
                </div>
              )}
              <div className={styles.userList}>
                {users.length === 0 ? (
                  <p className={styles.empty}>没有匹配的用户。</p>
                ) : users.map((user) => (
                  <article key={user.id} className={user.status === "disabled" ? styles.disabledUser : undefined}>
                    <div className={styles.userIdentity}>
                      <i>{(user.displayName || user.username || "?").slice(0, 1)}</i>
                      <div>
                        <b>{user.displayName || user.username || "未设置昵称"}</b>
                        <span>@{user.username || "未设置"} · {user.emailMasked || "未绑定邮箱"}</span>
                      </div>
                    </div>
                    <div className={styles.userFacts}>
                      <span data-good={user.emailVerified}>邮箱{user.emailVerified ? "已验证" : "未验证"}</span>
                      <span data-good={user.schoolAccountVerified}>学号{user.schoolAccountVerified ? "已验证" : "未验证"}</span>
                      <span>{user.role === "admin" ? "管理员" : user.role === "moderator" ? "审核员" : "学生"}</span>
                    </div>
                    <div className={styles.userDates}>
                      <span>注册 {formatDate(user.createdAt, false)}</span>
                      <span>最近登录 {formatDate(user.lastLoginAt)}</span>
                    </div>
                    <div className={styles.userAction}>
                      <em data-status={user.status}>{user.status === "active" ? "正常" : "已停用"}</em>
                      <button onClick={() => setRegistrationUserId(user.id)}>查看资料</button>
                      <button onClick={() => { setTarget(user); setReason(""); setFeedback(""); }}>
                        {user.status === "active" ? "停用" : "恢复"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {usersCursor && <button className={styles.usersMore} onClick={() => void loadMoreUsers()} disabled={busy === "users-more"}>{busy === "users-more" ? "正在加载" : "加载更多"}</button>}
            </section>

              <details className={styles.trendDisclosure}><summary>注册趋势 · 最近 30 天</summary>
          <section className={styles.registrationTrend} aria-labelledby="admin-registration-trend-title">
            <header>
              <div><h3 id="admin-registration-trend-title">最近 30 天</h3></div>

            </header>
            <ol aria-label="最近 30 天新增用户趋势">
              {overview.registrationTrend.map((item) => (
                <li key={item.date}>
                  <i style={{ "--trend-height": `${Math.max(4, Math.round(item.count / registrationPeak * 100))}%` } as CSSProperties} />
                  <span>{item.date.slice(5)}</span>
                  <b>{item.count}<span className="sr-only"> 人</span></b>
                </li>
              ))}
            </ol>
          </section>

              </details>
            </div>
            <div className={styles.panel} hidden={workspace !== "review"}>
              <nav className={styles.reviewNav} aria-label="审核分类">
                {[["reports", "举报处理"], ["content", "主题与回复"], ["history", "历史评价"]].map(([key, label]) => <button key={key} aria-pressed={reviewTab === key} onClick={() => navigate("review", key)}>{label}</button>)}
              </nav>
              <div hidden={reviewTab !== "reports"}><ModerationDesk onMfaExpired={handleMfaExpired} onAuditChanged={loadAudit} /></div>
              <div hidden={reviewTab !== "content"}><ActiveContentDesk onMfaExpired={handleMfaExpired} onAuditChanged={loadAudit} /></div>
              <div hidden={reviewTab !== "history"}><TeacherReviewDesk onMfaExpired={handleMfaExpired} onAuditChanged={loadAudit} /></div>
            </div>
            <div className={styles.panel} hidden={workspace !== "notices"}><AnnouncementDesk onMfaExpired={handleMfaExpired} onAuditChanged={loadAudit} /></div>
            <div className={styles.panel} hidden={workspace !== "audit"}>
            <aside className={styles.auditTrail} aria-labelledby="admin-audit-title">
              <header><h2 id="admin-audit-title">操作记录</h2><span>最近 50 条</span></header>
              <ol>
                {audit.length === 0 ? (
                  <li className={styles.empty}>还没有管理操作记录。</li>
                ) : audit.map((event) => (
                  <li key={event.id}>
                    <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                    <b>{actionLabels[event.action] || event.action}</b>
                    <p>{event.targetId ? `对象 ${event.targetId.slice(0, 8)}…` : "系统级操作"}</p>
                    {typeof event.metadata?.reason === "string" && <q>{event.metadata.reason}</q>}
                  </li>
                ))}
              </ol>
            </aside>
            </div>
          </div>
        </div>
      )}

      {registrationUserId && screen === "dashboard" && <UserRegistration key={registrationUserId} userId={registrationUserId} elevatedUntil={access?.elevatedUntil ?? null} onClose={closeRegistration} onExpired={handleMfaExpired} />}
      {target && (
        <DialogBackdrop onDismiss={closeUserAction} dismissDisabled={Boolean(busy)}>
          <form
            ref={actionDialogRef}
            className={styles.actionSheet}
            onSubmit={changeStatus}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-action-title"
          >
            <span>{target.status === "active" ? "停用账号" : "恢复账号"}</span>
            <h2 id="admin-action-title">{target.displayName || target.username || "这名用户"}</h2>
            <p>{target.status === "active" ? "停用后，这名用户的所有登录与管理员短时权限都会立即撤销。" : "恢复后可以重新登录，但过去的会话不会重新生效。"}</p>
            <FormField label="处置原因（至少 8 个字）" counter={`${reason.length}/500`} className={styles.caseField}>
              <textarea id="admin-action-reason" name="reason" autoComplete="off" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={4} autoFocus />
            </FormField>
            <DialogActions>
              <button type="button" onClick={closeUserAction} disabled={Boolean(busy)}>取消</button>
              <button disabled={reason.trim().length < 8 || Boolean(busy)}>{busy ? "正在写入记录" : target.status === "active" ? "确认停用" : "确认恢复"}</button>
            </DialogActions>
          </form>
        </DialogBackdrop>
      )}


    </main>
  );
}

function StatePanel({
  mark,
  eyebrow,
  title,
  copy,
  actionHref,
  actionLabel,
  onAction,
}: {
  mark: string;
  eyebrow: string;
  title: string;
  copy: string;
  actionHref?: string;
  actionLabel: string;
  onAction?: () => void;
}) {
  return (
    <section className={styles.statePanel}>
      <i className={styles.seal}>{mark}</i>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{copy}</p>
      {actionHref ? <Link href={actionHref}>{actionLabel}</Link> : <button onClick={onAction}>{actionLabel}</button>}
    </section>
  );
}
