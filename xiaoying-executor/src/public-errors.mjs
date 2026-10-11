const HTTP_STATUS_ERRORS = new Map([
  [400, { code: "INVALID_REQUEST", message: "请求内容无效，请检查后重试" }],
  [401, { code: "AUTHENTICATION_REQUIRED", message: "登录状态已失效，请重新进入" }],
  [403, { code: "REQUEST_FORBIDDEN", message: "当前请求不被允许" }],
  [404, { code: "NOT_FOUND", message: "没有找到请求的内容" }],
  [409, { code: "REQUEST_CONFLICT", message: "数据已经变化，请刷新后重试" }],
  [413, { code: "PAYLOAD_TOO_LARGE", message: "提交的内容过大" }],
  [415, { code: "UNSUPPORTED_MEDIA_TYPE", message: "请使用 JSON 提交请求" }],
  [429, { code: "RATE_LIMITED", message: "操作过于频繁，请稍后重试" }],
]);

const PROVIDER_ERRORS = new Map([
  ["SESSION_EXPIRED", "登录已过期，请重新连接"],
  ["REFRESH_FAILED", "登录续期失败，请重新连接"],
  ["TERM_NOT_FOUND", "暂时没有读取到当前学期，请稍后重试"],
  ["HTTP_ERROR", "校园服务暂时不可用，请稍后重试"],
  ["TIMEOUT", "连接校园服务超时，请稍后重试"],
  ["NETWORK_ERROR", "暂时无法连接校园服务，请稍后重试"],
  ["AUTHORIZATION_FAILED", "授权没有成功，请重新连接"],
  ["PROTOCOL_CHANGED", "校园服务数据格式已变化，请等待站长处理"],
  ["WRITE_NOT_CONFIRMED", "校园服务没有确认操作结果，请先检查当前状态"],
  ["UNTRUSTED_URL", "连接地址未通过安全校验"],
  ["UNTRUSTED_REDIRECT", "授权跳转未通过安全校验"],
]);

const PAIRING_ERRORS = new Map([
  ["PAIRING_EXPIRED", "这个授权码已经失效，请回到电脑端重新生成"],
  ["PAIRING_BUSY", "授权正在处理，请稍等"],
  ["PAIRING_ATTEMPTS_EXCEEDED", "尝试次数过多，请重新生成二维码"],
]);

const TASK_ERRORS = new Map([
  ["CREDENTIAL_MATERIAL_REJECTED", "任务包含不允许提交的凭据字段"],
  ["TASK_EXPIRED", "任务已过期，请重新发起"],
  ["CONFIRMATION_REQUIRED", "操作需要重新确认"],
  ["TASK_NOT_ALLOWED", "不支持这项任务"],
  ["EXECUTION_IN_PROGRESS", "操作正在执行，请稍后查看结果"],
  ["IDEMPOTENCY_CONFLICT", "同一操作标识对应了不同内容，请重新发起"],
  ["EXECUTION_REVIEW_REQUIRED", "上次执行结果不确定，请先核对当前状态"],
  ["TASK_FAILED", "任务执行失败，请稍后重试"],
]);

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "";
}

function clientStatus(error) {
  const status = Number(error?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
}

export function toPublicHttpError(error, { fallbackStatus = 500 } = {}) {
  const code = errorCode(error);
  if (PAIRING_ERRORS.has(code)) {
    return { status: 400, code, message: PAIRING_ERRORS.get(code) };
  }
  if (PROVIDER_ERRORS.has(code)) {
    return { status: 400, code, message: PROVIDER_ERRORS.get(code) };
  }

  const status = clientStatus(error);
  if (status) {
    const publicError = HTTP_STATUS_ERRORS.get(status) ?? HTTP_STATUS_ERRORS.get(400);
    return { status, ...publicError };
  }

  const fallback =
    fallbackStatus === 400
      ? HTTP_STATUS_ERRORS.get(400)
      : {
          code: "INTERNAL_ERROR",
          message: "服务暂时无法处理请求，请稍后重试",
        };
  return { status: fallbackStatus === 400 ? 400 : 500, ...fallback };
}

export function toPublicTaskError(code) {
  const normalizedCode = TASK_ERRORS.has(code) ? code : "TASK_FAILED";
  return {
    code: normalizedCode,
    message: TASK_ERRORS.get(normalizedCode),
  };
}
