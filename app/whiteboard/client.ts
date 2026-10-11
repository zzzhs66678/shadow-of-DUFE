export type WhiteboardEntry = {
  id: string; kind: "note" | "event"; title: string; body: string;
  guest: string; guestBio: string; location: string;
  startsAt: string | null; endsAt: string | null; expiresAt: string | null;
  status: "draft" | "published" | "withdrawn"; version: number;
  publishedAt: string | null; updatedAt: string;
};
export type BoardCopy = Pick<WhiteboardEntry, "kind" | "title" | "body" | "guest" | "guestBio" | "location" | "startsAt" | "endsAt" | "expiresAt">;
export class BoardError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export async function boardRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const value = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new BoardError(response.status, value?.error || "request_failed");
  if (!value || typeof value !== "object") throw new BoardError(502, "invalid_response");
  return value as T;
}
export function boardError(error: unknown) {
  if (!(error instanceof BoardError)) return "没有连接上，内容还在，请重试。";
  if ([401, 403].includes(error.status)) return "请重新登录并完成管理员验证。";
  if (error.status === 409) return "这条内容已发生变化。草稿已保留，请重新打开最新版本核对。";
  if (error.status === 429) return "操作有点快，请稍后再试。";
  if (error.status === 400) return "请核对内容和起止时间。";
  return "没有保存成功，内容还在，可以重试。";
}
export function boardDeadline(item: BoardCopy) { return item.kind === "event" ? item.endsAt : item.expiresAt; }
export function boardExpired(item: BoardCopy, now = Date.now()) {
  const deadline = boardDeadline(item);
  return Boolean(deadline && Date.parse(deadline) <= now);
}
export function boardDate(value: string | null, mode: "day" | "time" | "full" = "full") {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false,
    ...(mode !== "time" ? { month: "numeric", day: "numeric" } : {}),
    ...(mode !== "day" ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(value));
}
export function boardEventTime(item: BoardCopy) {
  if (!item.startsAt) return "时间待定";
  const sameDay = chinaInput(item.startsAt).slice(0, 10) === chinaInput(item.endsAt).slice(0, 10);
  return `${boardDate(item.startsAt)}${item.endsAt ? `—${boardDate(item.endsAt, sameDay ? "time" : "full")}` : ""}`;
}
// datetime-local is a campus wall clock, independent of the admin device timezone.
export function chinaInput(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 16);
}
export function chinaISO(value: string) { return value ? `${value}:00+08:00` : null; }
