import {
  parseCookies,
  serializeSecureCookie,
} from "./cookies.mjs";
import {
  createOpaqueToken,
  isOpaqueToken,
  tokenDigest,
} from "./tokens.mjs";

function sendJson(response, statusCode, body, setCookies = []) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (setCookies.length) response.setHeader("Set-Cookie", setCookies);
  response.end(JSON.stringify(body));
}

function trustedOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  return typeof origin === "string" && allowedOrigins.has(origin);
}

function clientAddress(request) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded.at(-1) || request.socket.remoteAddress || "unknown";
}

async function readJsonBody(request, maxBytes = 8_192) {
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  } catch {
    return null;
  }
}

async function resolvePrincipal(request, store, config) {
  const cookies = parseCookies(request.headers.cookie);
  const sessionToken = cookies.get(config.sessionCookie);
  const session = isOpaqueToken(sessionToken)
    ? await store.getActiveSession(
        tokenDigest(sessionToken, config.tokenPepper),
      )
    : null;
  if (session) {
    return {
      key: `user:${session.userId}`,
      setCookies: [],
    };
  }

  const existingDeviceToken = cookies.get(config.deviceCookie);
  const deviceToken = isOpaqueToken(existingDeviceToken)
    ? existingDeviceToken
    : createOpaqueToken();
  const device = await store.getOrCreateAnonymousDevice(
    tokenDigest(deviceToken, config.tokenPepper),
  );
  return {
    key: `device:${device.id}`,
    setCookies:
      deviceToken === existingDeviceToken
        ? []
        : [
            serializeSecureCookie(
              config.deviceCookie,
              deviceToken,
              config.deviceMaxAgeSeconds,
            ),
          ],
  };
}

function mappedError(error) {
  const mapping = new Map([
    ["ACADEMIC_CREDENTIALS_INVALID", [400, "academic_credentials_invalid"]],
    ["ACADEMIC_PRINCIPAL_REQUIRED", [400, "academic_request_invalid"]],
    ["ACADEMIC_INVALID_CREDENTIALS", [401, "academic_invalid_credentials"]],
    ["ACADEMIC_SMS_INVALID", [400, "academic_sms_invalid"]],
    ["ACADEMIC_SMS_DESTINATION_INVALID", [400, "academic_sms_destination_invalid"]],
    ["ACADEMIC_SMS_PHONE_INVALID", [400, "academic_sms_phone_invalid"]],
    ["ACADEMIC_SMS_PHONE_UNAVAILABLE", [422, "academic_sms_phone_unavailable"]],
    ["ACADEMIC_SMS_NOT_SENT", [409, "academic_sms_not_sent"]],
    ["ACADEMIC_SMS_SEND_FAILED", [502, "academic_sms_send_failed"]],
    ["ACADEMIC_SSO_VERIFICATION_INVALID", [400, "academic_sso_verification_invalid"]],
    ["ACADEMIC_SSO_PROTOCOL_CHANGED", [502, "academic_sso_protocol_changed"]],
    ["ACADEMIC_TRANSACTION_EXPIRED", [410, "academic_transaction_expired"]],
    ["ACADEMIC_ADDITIONAL_AUTH_REQUIRED", [422, "academic_additional_auth_required"]],
    ["ACADEMIC_SESSION_NOT_READY", [502, "academic_session_not_ready"]],
    ["ACADEMIC_TERM_NOT_FOUND", [502, "academic_format_changed"]],
    ["ACADEMIC_TIMETABLE_FORMAT_CHANGED", [502, "academic_format_changed"]],
    ["ACADEMIC_EXAM_FORMAT_CHANGED", [502, "academic_exam_format_changed"]],
    ["ACADEMIC_PLAN_NOT_FOUND", [422, "academic_plan_not_found"]],
    ["ACADEMIC_PLAN_FORMAT_CHANGED", [502, "academic_plan_format_changed"]],
    ["ACADEMIC_TIMETABLE_EMPTY", [422, "academic_timetable_empty"]],
    ["ACADEMIC_PROTOCOL_CHANGED", [502, "academic_protocol_changed"]],
    ["ACADEMIC_RESPONSE_TOO_LARGE", [502, "academic_response_invalid"]],
    ["ACADEMIC_UNTRUSTED_REDIRECT", [502, "academic_response_invalid"]],
    ["ACADEMIC_REDIRECT_LOOP", [502, "academic_response_invalid"]],
    ["ACADEMIC_UPSTREAM_TIMEOUT", [504, "academic_upstream_timeout"]],
    ["ACADEMIC_UPSTREAM_UNAVAILABLE", [502, "academic_upstream_unavailable"]],
    ["ACADEMIC_LOGIN_FAILED", [401, "academic_login_failed"]],
  ]);
  return mapping.get(error?.code) ?? null;
}

const DIAGNOSTIC_STAGES = new Set([
  "vpn_init",
  "vpn_password_config",
  "vpn_password",
  "vpn_sms_config",
  "vpn_sms_send",
  "vpn_sms_verify",
  "sso_challenge",
  "sso_verify",
  "timetable_fetch",
  "timetable_parse",
  "exam_fetch",
  "exam_parse",
  "plan_fetch",
  "plan_parse",
]);

function safeDiagnosticStage(error) {
  return DIAGNOSTIC_STAGES.has(error?.stage) ? error.stage : "unknown";
}

function safeDiagnosticOrigin(value) {
  if (typeof value !== "string" || value.length > 512) return undefined;
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

const SAFE_PARSE_REASONS = new Set([
  "header_not_found",
  "meetings_not_decoded",
  "callback_ambiguous",
  "json_invalid",
  "json_shape_unknown",
  "json_course_invalid",
  "json_meeting_invalid",
  "json_meetings_not_decoded",
  "plan_profile_invalid",
  "plan_json_invalid",
  "plan_tree_size_invalid",
  "plan_categories_missing",
  "plan_category_invalid",
  "plan_course_invalid",
  "plan_courses_missing",
  "plan_courses_too_many",
  "plan_metadata_invalid",
]);
const SAFE_HEADER_MODES = new Set(["combined", "separated", "both"]);
const SAFE_TIMETABLE_HEADERS = new Set([
  "课程号", "课程代码", "课程编号", "课程名", "课程名称", "课序号",
  "教学班号", "学分", "课程属性", "课程性质", "课程类别", "考试类型",
  "考核方式", "教师", "任课教师", "修读方式", "选课状态", "时间",
  "上课时间", "地点", "上课地点", "周次", "上课周次", "起止周",
  "星期", "上课星期", "节次", "上课节次", "开始节次", "节数",
  "连上节数", "持续节数", "校区", "校区名称", "教学楼", "楼宇",
  "楼栋", "教室", "上课教室",
]);

function safeDiagnosticCount(value, maximum = 10_000) {
  return Number.isInteger(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

function safeDiagnosticList(value, predicate, maximum = 40) {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item) => typeof item === "string" && predicate(item))
    .slice(0, maximum);
  return items.length ? items : undefined;
}

function safeDiagnosticDetails(error) {
  const diagnostic = error?.diagnostic;
  if (!diagnostic || typeof diagnostic !== "object") return {};
  const redirectFromOrigin = safeDiagnosticOrigin(
    diagnostic.redirectFromOrigin,
  );
  const redirectToOrigin = safeDiagnosticOrigin(diagnostic.redirectToOrigin);
  const redirectStatus = Number.isInteger(diagnostic.redirectStatus)
    ? diagnostic.redirectStatus
    : undefined;
  const redirectIndex = Number.isInteger(diagnostic.redirectIndex)
    ? diagnostic.redirectIndex
    : undefined;
  const parseReason = SAFE_PARSE_REASONS.has(diagnostic.parseReason)
    ? diagnostic.parseReason
    : undefined;
  const headerMode = SAFE_HEADER_MODES.has(diagnostic.headerMode)
    ? diagnostic.headerMode
    : undefined;
  const tableCount = safeDiagnosticCount(diagnostic.tableCount, 100);
  const rowCount = safeDiagnosticCount(diagnostic.rowCount);
  const sectionCount = safeDiagnosticCount(diagnostic.sectionCount);
  const tableShapes = safeDiagnosticList(
    diagnostic.tableShapes,
    (item) => /^\d{1,5}x\d{1,4}$/u.test(item),
    12,
  );
  const knownHeaders = safeDiagnosticList(
    diagnostic.knownHeaders,
    (item) => SAFE_TIMETABLE_HEADERS.has(item),
  );
  const timePatterns = safeDiagnosticList(
    diagnostic.timePatterns,
    (item) =>
      item.length <= 160 &&
      /^[\s#?周星期一二三四五六日天节单双前后上下全第,，、;；:/|()（）[\]{}<>\-]+$/u.test(item),
    6,
  );
  return {
    ...(redirectFromOrigin ? { redirectFromOrigin } : {}),
    ...(redirectToOrigin ? { redirectToOrigin } : {}),
    ...(redirectStatus !== undefined ? { redirectStatus } : {}),
    ...(redirectIndex !== undefined ? { redirectIndex } : {}),
    ...(parseReason ? { parseReason } : {}),
    ...(headerMode ? { headerMode } : {}),
    ...(tableCount !== undefined ? { tableCount } : {}),
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(sectionCount !== undefined ? { sectionCount } : {}),
    ...(tableShapes ? { tableShapes } : {}),
    ...(knownHeaders ? { knownHeaders } : {}),
    ...(timePatterns ? { timePatterns } : {}),
  };
}

export function createAcademicRequestHandler({
  store,
  config,
  connector,
  rateLimiters,
}) {
  return async function handleAcademicRequest(request, response, url) {
    if (!url.pathname.startsWith("/api/auth/academic/")) return false;
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!config.academicImportEnabled || !connector) {
      sendJson(response, 503, { error: "academic_import_unavailable" });
      return true;
    }
    if (!trustedOrigin(request, config.allowedOrigins)) {
      sendJson(response, 403, { error: "untrusted_origin" });
      return true;
    }
    const principal = await resolvePrincipal(request, store, config);
    const ipKey = tokenDigest(
      `academic-ip:${clientAddress(request)}`,
      config.tokenPepper,
    );
    const principalKey = tokenDigest(
      `academic-principal:${principal.key}`,
      config.tokenPepper,
    );
    const allowed =
      (await rateLimiters.academicIp.consume(ipKey)) &&
      (await rateLimiters.academicPrincipal.consume(principalKey));
    if (!allowed) {
      response.setHeader("Retry-After", "300");
      sendJson(
        response,
        429,
        { error: "academic_rate_limit_exceeded" },
        principal.setCookies,
      );
      return true;
    }
    const body = await readJsonBody(request);
    if (!body) {
      sendJson(
        response,
        400,
        { error: "academic_request_invalid" },
        principal.setCookies,
      );
      return true;
    }
    try {
      let result;
      if (url.pathname === "/api/auth/academic/connect") {
        result = await connector.start({
          username: body.username,
          password: body.password,
          principalKey: principal.key,
        });
      } else if (url.pathname === "/api/auth/academic/sms/send") {
        result = await connector.sendSms({
          transactionId: body.transactionId,
          phone: body.phone,
          phoneIndex: body.phoneIndex,
          principalKey: principal.key,
        });
      } else if (url.pathname === "/api/auth/academic/sms") {
        result = await connector.verifySms({
          transactionId: body.transactionId,
          code: body.code,
          principalKey: principal.key,
        });
      } else if (url.pathname === "/api/auth/academic/sso") {
        result = await connector.verifySso({
          transactionId: body.transactionId,
          verifyCode: body.verifyCode,
          principalKey: principal.key,
        });
      } else {
        sendJson(response, 404, { error: "not_found" });
        return true;
      }
      if (result?.status === "imported") {
        const sections = Array.isArray(result.snapshot?.sections)
          ? result.snapshot.sections
          : [];
        console.info(
          JSON.stringify({
            event: "academic_import_completed",
            sections: sections.length,
            meetings: sections.reduce(
              (count, section) =>
                count + (Array.isArray(section?.meetings) ? section.meetings.length : 0),
              0,
            ),
            exams: Array.isArray(result.snapshot?.exams)
              ? result.snapshot.exams.length
              : 0,
            planCourses: Array.isArray(result.trainingPlan?.courses)
              ? result.trainingPlan.courses.length
              : 0,
          }),
        );
      }
      sendJson(response, 200, result, principal.setCookies);
    } catch (error) {
      const mapped = mappedError(error);
      if (!mapped) throw error;
      const stage = safeDiagnosticStage(error);
      console.warn(
        JSON.stringify({
          event: "academic_import_rejected",
          action: url.pathname.split("/").at(-1) || "unknown",
          code: error.code,
          stage,
          ...safeDiagnosticDetails(error),
        }),
      );
      sendJson(
        response,
        mapped[0],
        {
          error: mapped[1],
          stage,
          ...(error?.retryable === true ? { retryable: true } : {}),
        },
        principal.setCookies,
      );
    }
    return true;
  };
}
