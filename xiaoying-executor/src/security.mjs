import { createHash } from "node:crypto";

const FORBIDDEN_KEY =
  /^(?:cookie|cookies|set-cookie|authorization|auth|credential|credentials|password|passwd|secret|session|sessionid|access[_-]?token|refresh[_-]?token|control[_-]?token)$/i;

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function assertNoCredentialMaterial(value, path = "payload") {
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`任务中不允许包含凭据字段：${childPath}`);
    }
    assertNoCredentialMaterial(child, childPath);
  }
}

export function minimalAuditRecord(task, result) {
  return {
    taskId: task.taskId,
    idempotencyKey: task.idempotencyKey ?? null,
    type: task.type,
    status: result.status,
    completedAt: result.completedAt,
    errorCode: result.error?.code ?? null,
  };
}
