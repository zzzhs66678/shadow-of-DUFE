"use client";

import { useEffect, useState } from "react";
import { DialogBackdrop } from "../DialogBackdrop";
import { useModalFocus } from "../use-modal-focus";
import styles from "./user-registration.module.css";

type Registration = {
  username: string | null; displayName: string | null; email: string | null;
  emailVerified: boolean; schoolAccount: string | null; schoolAccountVerified: boolean;
  avatarUrl: string | null; registeredVia: string; createdAt: string; lastLoginAt: string | null;
  role: string; status: string;
  profile: null | { entranceYear: number | null; college: string | null; majorId: string | null; className: string | null; updatedAt: string };
};

export function UserRegistration({ userId, elevatedUntil, onClose, onExpired }: {
  userId: string; elevatedUntil: string | null; onClose: () => void; onExpired: () => void;
}) {
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState("");
  const dialogRef = useModalFocus<HTMLElement>(true, onClose);

  useEffect(() => {
    const controller = new AbortController();
    const remaining = elevatedUntil ? new Date(elevatedUntil).getTime() - Date.now() : 0;
    const expire = () => { controller.abort(); setRegistration(null); onExpired(); };
    if (remaining <= 0) { expire(); return; }
    const timer = window.setTimeout(expire, remaining);
    void (async () => {
      try {
        const response = await fetch(`/api/admin/users/${userId}/registration`, {
          method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: "{}",
        });
        if (response.status === 401 || response.status === 403) { expire(); return; }
        if (!response.ok) throw new Error(response.status === 404 ? "账号已不存在。" : "资料暂时无法读取，请关闭后重试。");
        const result = await response.json() as { registration: Registration };
        if (!controller.signal.aborted) setRegistration(result.registration);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "资料暂时无法读取。");
      }
    })();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [userId, elevatedUntil, onExpired]);

  const show = (value: string | number | null | undefined) => value ?? "未填写";
  const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-CN") : "暂无记录";
  const fields = registration ? [
    ["用户名", show(registration.username)], ["昵称", show(registration.displayName)],
    ["邮箱", show(registration.email)], ["邮箱验证", registration.emailVerified ? "已验证" : "未验证"],
    ["学号 / 校园账号", show(registration.schoolAccount)], ["学号验证", registration.schoolAccountVerified ? "已验证" : "未验证"],
    ["入学年份", show(registration.profile?.entranceYear)], ["学院", show(registration.profile?.college)],
    ["专业", show(registration.profile?.majorId)], ["班级", show(registration.profile?.className)],
    ["注册时间", date(registration.createdAt)], ["最近登录", date(registration.lastLoginAt)],
    ["资料同步时间", date(registration.profile?.updatedAt)],
    ["注册方式", registration.registeredVia === "credential" ? "邮箱注册" : registration.registeredVia === "oauth" ? "第三方登录" : registration.registeredVia],
    ["角色", registration.role === "admin" ? "管理员" : registration.role === "moderator" ? "审核员" : "普通用户"],
    ["账号状态", registration.status === "active" ? "正常" : "已停用"],
  ] : [];

  return <DialogBackdrop onDismiss={onClose}>
    <section ref={dialogRef} className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="registration-title">
      <header><h2 id="registration-title">注册资料</h2><button type="button" onClick={onClose}>关闭</button></header>
      <p>当前保存的账号资料与已同步的个人资料，仅管理员可见。</p>
      {error ? <p role="alert">{error}</p> : !registration ? <p role="status">正在读取…</p> : <>
        <p>本次查看已记录。</p>
        {registration.avatarUrl?.startsWith("/api/auth/avatars/") && <img src={registration.avatarUrl} alt="用户头像" width={64} height={64} />}
        <dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {!registration.profile && <p>未保存云端个人资料；仅存在用户手机上的内容无法在这里查看。</p>}
        {registration.email && <div className={styles.actions}>
          <button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(registration.email!); setCopyState("邮箱已复制"); }
            catch { setCopyState("无法自动复制，请长按上方邮箱复制。"); }
          }}>复制邮箱</button>
          <a href={`mailto:${encodeURIComponent(registration.email)}`}>用邮件应用联系</a>
        </div>}
        <p role="status">{copyState}</p>
      </>}
    </section>
  </DialogBackdrop>;
}
