import { randomUUID } from "node:crypto";
import {
  assertNoCredentialMaterial,
  contentHash,
  minimalAuditRecord,
} from "./security.mjs";
import { toPublicTaskError } from "./public-errors.mjs";

const READ_TASKS = new Set([
  "library.get_status",
  "library.list_favorites",
  "library.check_seat",
]);
const PREVIEW_TASKS = new Set([
  "library.preview_reservation",
  "library.preview_cancellation",
]);
const CONFIRM_TASKS = new Set([
  "library.confirm_reservation",
  "library.confirm_cancellation",
]);
const KNOWN_TASKS = new Set([...READ_TASKS, ...PREVIEW_TASKS, ...CONFIRM_TASKS]);

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`缺少 ${field}`);
  return normalized;
}

function parseTime(value, field) {
  const timestamp = Date.parse(requiredText(value, field));
  if (!Number.isFinite(timestamp)) throw new Error(`${field} 不是有效时间`);
  return timestamp;
}

function reservationTarget(payload) {
  const seatKey =
    typeof payload.seatKey === "string" && payload.seatKey.trim()
      ? payload.seatKey.trim()
      : requiredText(payload.seatId, "seatId");
  const libraryId =
    payload.libraryId === undefined || payload.libraryId === null
      ? null
      : Number(payload.libraryId);
  if (libraryId !== null && (!Number.isInteger(libraryId) || libraryId <= 0)) {
    throw new Error("libraryId 无效");
  }
  return {
    ...(libraryId === null ? {} : { libraryId }),
    seatKey,
    seatId: seatKey,
  };
}

export class XiaoyingExecutor {
  constructor({ libraryAdapter, clock = () => Date.now(), previewTtlMs = 10 * 60_000 }) {
    if (!libraryAdapter) throw new Error("缺少图书馆适配器");
    this.libraryAdapter = libraryAdapter;
    this.clock = clock;
    this.previewTtlMs = previewTtlMs;
    this.previews = new Map();
    this.idempotentResults = new Map();
    this.auditLog = [];
  }

  async execute(task) {
    const startedAt = this.clock();
    let result;

    try {
      this.#validateEnvelope(task, startedAt);
      assertNoCredentialMaterial(task.payload);

      if (CONFIRM_TASKS.has(task.type)) {
        const previous = this.idempotentResults.get(task.idempotencyKey);
        if (previous) return structuredClone(previous);
      }

      const data = await this.#dispatch(task, startedAt);
      result = {
        taskId: task.taskId,
        type: task.type,
        status: "succeeded",
        completedAt: new Date(this.clock()).toISOString(),
        data,
      };
    } catch (error) {
      result = {
        taskId: typeof task?.taskId === "string" ? task.taskId : "invalid-task",
        type: typeof task?.type === "string" ? task.type : "unknown",
        status: "failed",
        completedAt: new Date(this.clock()).toISOString(),
        error: toPublicTaskError(this.#errorCode(error)),
      };
    }

    if (task && typeof task === "object" && CONFIRM_TASKS.has(task.type) && task.idempotencyKey) {
      this.idempotentResults.set(task.idempotencyKey, structuredClone(result));
    }
    this.auditLog.push(minimalAuditRecord(task ?? {}, result));
    return structuredClone(result);
  }

  getAuditLog() {
    return structuredClone(this.auditLog);
  }

  #validateEnvelope(task, now) {
    if (!task || typeof task !== "object") throw new Error("任务必须是对象");
    requiredText(task.taskId, "taskId");
    if (!KNOWN_TASKS.has(task.type)) throw new Error("不支持的任务类型");
    const issuedAt = parseTime(task.issuedAt, "issuedAt");
    const expiresAt = parseTime(task.expiresAt, "expiresAt");
    if (issuedAt > now + 60_000) throw new Error("任务签发时间晚于本机时间");
    if (expiresAt <= now) throw new Error("任务已过期");
    if (expiresAt <= issuedAt) throw new Error("任务有效期不正确");
    if (!task.payload || typeof task.payload !== "object") throw new Error("缺少 payload");

    if (CONFIRM_TASKS.has(task.type)) {
      requiredText(task.idempotencyKey, "idempotencyKey");
      if (task.confirmation?.confirmed !== true) throw new Error("外部写操作尚未明确确认");
      const confirmedAt = parseTime(task.confirmation.confirmedAt, "confirmation.confirmedAt");
      if (confirmedAt < issuedAt - 60_000 || confirmedAt > now + 60_000) {
        throw new Error("确认时间无效");
      }
    }
  }

  async #dispatch(task, now) {
    switch (task.type) {
      case "library.get_status":
        return this.libraryAdapter.getStatus();
      case "library.list_favorites":
        return { seats: await this.libraryAdapter.listFavorites() };
      case "library.check_seat":
        return this.libraryAdapter.checkSeat({
          ...reservationTarget(task.payload),
          date: requiredText(task.payload.date, "date"),
        });
      case "library.preview_reservation":
        return this.#createPreview(
          "reservation",
          {
            ...reservationTarget(task.payload),
            date: requiredText(task.payload.date, "date"),
            reservationKind:
              task.payload.reservationKind === "tomorrow" ? "tomorrow" : "normal",
          },
          now,
        );
      case "library.preview_cancellation":
        return this.#createPreview(
          "cancellation",
          {
            reservationId: requiredText(
              task.payload.reservationToken ?? task.payload.reservationId,
              "reservationId",
            ),
          },
          now,
        );
      case "library.confirm_reservation":
        return this.#confirmPreview("reservation", task.payload.previewDigest, now);
      case "library.confirm_cancellation":
        return this.#confirmPreview("cancellation", task.payload.previewDigest, now);
      default:
        throw new Error("不支持的任务类型");
    }
  }

  #createPreview(kind, action, now) {
    const expiresAt = now + this.previewTtlMs;
    const previewDigest = contentHash({
      kind,
      action,
      nonce: randomUUID(),
      expiresAt,
    });
    this.previews.set(previewDigest, { kind, action, expiresAt, consumed: false });

    return {
      kind,
      action,
      previewDigest,
      expiresAt: new Date(expiresAt).toISOString(),
      requiresConfirmation: true,
    };
  }

  async #confirmPreview(expectedKind, previewDigestValue, now) {
    const previewDigest = requiredText(previewDigestValue, "previewDigest");
    const preview = this.previews.get(previewDigest);
    if (!preview || preview.kind !== expectedKind) throw new Error("预约预览不存在或不匹配");
    if (preview.expiresAt <= now) throw new Error("预约预览已过期");
    if (preview.consumed) throw new Error("预约预览已执行");

    preview.consumed = true;
    if (expectedKind === "reservation") {
      return this.libraryAdapter.reserve(preview.action);
    }
    return this.libraryAdapter.cancel(preview.action);
  }

  #errorCode(error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("凭据字段")) return "CREDENTIAL_MATERIAL_REJECTED";
    if (message.includes("过期")) return "TASK_EXPIRED";
    if (message.includes("确认")) return "CONFIRMATION_REQUIRED";
    if (message.includes("不支持")) return "TASK_NOT_ALLOWED";
    return "TASK_FAILED";
  }
}
