"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DialogActions, DialogBackdrop } from "../DialogBackdrop";
import { FormField } from "../FormField";
import { useModalFocus } from "../use-modal-focus";
import styles from "./admin.module.css";
import { ModerationDesk } from "./ModerationDesk";
import { AnnouncementDesk } from "./AnnouncementDesk";

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

export function AdminConsole() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [access, setAccess] = useState<AccessState | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState("");
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState("");
  const closeUserAction = useCallback(() => setTarget(null), []);
  const actionDialogRef = useModalFocus<HTMLFormElement>(Boolean(target), closeUserAction, Boolean(busy));

  const loadAudit = useCallback(async () => {
    const payload = await requestJson<{ events: AuditEvent[] }>("/api/admin/audit");
    setAudit(payload.events);
  }, []);

  const handleMfaExpired = useCallback(() => {
    setScreen("elevation");
  }, []);

  const loadDashboard = useCallback(async (search = "") => {
    const suffix = search ? `?query=${encodeURIComponent(search)}` : "";
    const [overviewPayload, usersPayload] = await Promise.all([
      requestJson<{ overview: Overview }>("/api/admin/overview"),
      requestJson<{ users: AdminUser[] }>(`/api/admin/users${suffix}`),
      loadAudit(),
    ]);
    setOverview(overviewPayload.overview);
    setUsers(usersPayload.users);
  }, [loadAudit]);

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

  const verifiedRatio = useMemo(() => {
    if (!overview?.totalUsers) return 0;
    return Math.round((overview.verifiedEmails / overview.totalUsers) * 100);
  }, [overview]);

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
    const normalized = query.trim();
    setBusy("search");
    setFeedback("");
    try {
      await loadDashboard(normalized);
      setActiveQuery(normalized);
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
      await loadDashboard(activeQuery);
      setFeedback(status === "disabled" ? "账号已停用，既有会话已撤销。" : "账号已恢复，可重新登录。历史会话不会恢复。");
    } catch (error) {
      setFeedback(errorMessage(error));
      if ((error as ApiError).code === "admin_mfa_required") {
        setTarget(null);
        setReason("");
        setScreen("elevation");
      } else if ((error as ApiError).code === "admin_user_status_conflict") {
        await loadDashboard(activeQuery);
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
          <span>PRIVATE · 值守台</span>
          <p>每一次高权限操作，都必须留下原因和可核对的记录。</p>
        </div>
      </header>

      {screen === "loading" && (
        <section className={styles.statePanel} aria-live="polite">
          <i className={styles.seal}>守</i>
          <span>正在核对值守身份</span>
          <div className={styles.loadingRule} />
        </section>
      )}

      {screen === "anonymous" && (
        <StatePanel
          mark="未"
          eyebrow="需要登录"
          title="先回到“我的”完成登录"
          copy="值守台不会创建或猜测管理员身份。登录后，系统仍会要求一次独立的双重验证。"
          actionHref="/?view=me"
          actionLabel="返回我的"
        />
      )}

      {screen === "forbidden" && (
        <StatePanel
          mark="止"
          eyebrow="权限不足"
          title="这个入口只对值守人员开放"
          copy="你的账号可以继续正常使用课表、资料和校园服务；管理员信息不会被查询或展示。"
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
          actionLabel="安全退出"
        />
      )}

      {screen === "error" && (
        <StatePanel
          mark="断"
          eyebrow="暂时不可用"
          title="值守台没有完成连接"
          copy="没有执行任何管理操作。请检查网络或服务状态后重新核对。"
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
            <span>SECOND FACTOR</span>
            <h1 id="admin-gate-title">值守之前，<br />再确认一次是你。</h1>
            <p>输入验证器中的 6 位动态码，或使用一枚尚未使用的恢复码。验证通过后，本次值守权限只在当前登录设备短暂有效。</p>
            <dl>
              <div><dt>基础登录</dt><dd>已确认</dd></div>
              <div><dt>管理员角色</dt><dd>已确认</dd></div>
              <div><dt>短时值守</dt><dd>等待验证</dd></div>
            </dl>
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
              {busy === "elevation" ? "正在核对" : "开始值守"}
            </button>
            {feedback && <p id="admin-gate-feedback" role="alert">{feedback}</p>}
            <small>验证码不会写入日志；恢复码使用一次后立即失效。</small>
          </form>
        </section>
      )}

      {screen === "dashboard" && overview && (
        <>
          <section className={styles.deskHeading}>
            <div>
              <span>ON DUTY</span>
              <h1>今日值守簿</h1>
              <p>只处理有明确依据的异常；搜索、处置与审计记录保持在同一条工作线上。</p>
            </div>
            <div className={styles.watchStatus}>
              <i />
              <span>短时权限有效至</span>
              <b>{formatDate(access?.elevatedUntil ?? null)}</b>
              <button onClick={endWatch} disabled={busy === "leave"}>结束值守</button>
            </div>
          </section>

          <section className={styles.ledger} aria-label="账号概况">
            <article className={styles.primaryMetric}>
              <span>在册账号</span>
              <strong>{overview.totalUsers}</strong>
              <p>{overview.activeUsers} 个账号当前可正常登录</p>
            </article>
            <article>
              <span>已停用</span>
              <strong>{overview.disabledUsers}</strong>
              <p>需要复核后才可恢复</p>
            </article>
            <article>
              <span>邮箱验证</span>
              <strong>{verifiedRatio}<small>%</small></strong>
              <p>{overview.verifiedEmails} 人已完成验证</p>
            </article>
            <article>
              <span>管理员</span>
              <strong>{overview.administrators}</strong>
              <p>高权限账号应保持最少</p>
            </article>
          </section>

          {feedback && <div className={styles.feedback} role="status">{feedback}</div>}

          <ModerationDesk
            onMfaExpired={handleMfaExpired}
            onAuditChanged={loadAudit}
          />

          <AnnouncementDesk
            onMfaExpired={handleMfaExpired}
            onAuditChanged={loadAudit}
          />

          <div className={styles.workbench}>
            <section className={styles.userBook} aria-labelledby="admin-users-title">
              <header>
                <div><span>账号名册</span><h2 id="admin-users-title">查找与处置</h2></div>
                <form onSubmit={searchUsers} role="search">
                  <label className="sr-only" htmlFor="admin-user-query">搜索用户名或邮箱</label>
                  <input
                    id="admin-user-query"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="用户名或邮箱"
                    maxLength={64}
                  />
                  <button disabled={busy === "search"}>{busy === "search" ? "查找中" : "查找"}</button>
                </form>
              </header>
              {activeQuery && (
                <div className={styles.queryNote}>
                  正在查看“{activeQuery}”的结果
                  <button onClick={() => { setQuery(""); setActiveQuery(""); void loadDashboard(""); }}>清除</button>
                </div>
              )}
              <div className={styles.userList}>
                {users.length === 0 ? (
                  <p className={styles.empty}>没有找到符合条件的账号。换一个用户名或邮箱再试。</p>
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
                      <button onClick={() => { setTarget(user); setReason(""); setFeedback(""); }}>
                        {user.status === "active" ? "停用" : "恢复"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <aside className={styles.auditTrail} aria-labelledby="admin-audit-title">
              <header><span>AUDIT</span><h2 id="admin-audit-title">值守印迹</h2></header>
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
        </>
      )}

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
              <textarea id="admin-action-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={4} autoFocus />
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
