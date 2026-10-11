import { buildDataFeedbackContext, isFeedbackUuid } from "../../services/auth-api/src/data-feedback-contract.mjs";

export type FeedbackType = "course" | "room" | "material";
export type FeedbackTarget = { type: FeedbackType; courseId?: string; meetingId?: string; materialId?: string; room?: string };
export type FeedbackContext = { type: FeedbackType; courseId: string | null; meetingId: string | null; materialId: string | null; room: string | null; path: string };
export type FeedbackReceipt = FeedbackContext & { id: string; message: string; status: "open" | "resolved"; version: number; createdAt: string; updatedAt: string };
export type FeedbackAction = { id: string; fromStatus: "open" | "resolved"; toStatus: "open" | "resolved"; version: number; note: string; createdAt: string };
export type FeedbackDetail = FeedbackReceipt & { actions: FeedbackAction[] };
export type FeedbackPage = { items: FeedbackReceipt[]; nextCursor: string | null; elevatedUntil?: string };
export const feedbackLabels = { course: "课程信息", room: "教室信息", material: "资料打不开" };
export const statusLabels = { open: "待处理", resolved: "已处理" };

export function feedbackContext(target: FeedbackTarget): FeedbackContext | null {
  return buildDataFeedbackContext(target) as FeedbackContext | null;
}
export function isReceipt(value: unknown): value is FeedbackReceipt {
  if (!value || typeof value !== "object") return false;
  const item = value as FeedbackReceipt;
  const context = buildDataFeedbackContext(item);
  return Boolean(context && context.path === item.path && isFeedbackUuid(item.id) &&
    typeof item.message === "string" && ["open", "resolved"].includes(item.status) &&
    Number.isInteger(item.version) && item.version > 0 &&
    typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) &&
    typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt)));
}
export class FeedbackApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export async function feedbackRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error",
    referrerPolicy: "no-referrer", signal: init?.signal ?? AbortSignal.timeout(15_000),
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = (await response.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!response.ok) throw new FeedbackApiError(response.status, payload?.error ?? "request_failed");
  if (!payload || typeof payload !== "object") throw new Error("invalid_response");
  return payload as T;
}
export function feedbackError(error: unknown): string {
  if (error instanceof FeedbackApiError) {
    if (error.status === 401) return "请先登录东财之影，再提交反馈。";
    if (error.code === "admin_mfa_required") return "管理员验证已过期，请回值守台完成二次验证。";
    if (error.code === "admin_forbidden") return "此页面仅供管理员处理反馈。";
    if (error.status === 429) return "操作较频繁，请稍后再试。";
    if (error.code === "data_feedback_version_conflict") return "状态已变化，请刷新后重新处理。";
    if (error.status === 400) return "内容或对象信息不符合要求，请检查后重试。";
    if (error.status === 404) return "反馈暂不可用，请稍后再试。";
  }
  return "未能确认结果，请检查网络后重试。";
}
export async function loadFeedbackPage(path: string): Promise<FeedbackPage> {
  const page = await feedbackRequest<FeedbackPage>(path);
  if (!Array.isArray(page.items) || !page.items.every(isReceipt) || (page.nextCursor !== null && !isFeedbackUuid(page.nextCursor))) throw new Error("invalid_response");
  return page;
}
export function feedbackDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
