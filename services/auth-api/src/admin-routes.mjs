import { randomUUID } from "node:crypto";
import {
  clearSecureCookie,
  parseCookies,
  serializeSecureCookie,
} from "./cookies.mjs";
import { createOpaqueToken, isOpaqueToken, tokenDigest } from "./tokens.mjs";

function sendJson(response, statusCode, body, setCookies = []) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (setCookies.length > 0) response.setHeader("Set-Cookie", setCookies);
  response.end(JSON.stringify(body));
}

function methodNotAllowed(response, allow) {
  response.setHeader("Allow", allow);
  sendJson(response, 405, { error: "method_not_allowed" });
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

async function readJsonBody(request, maxBytes = 16_384) {
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function maskedEmail(email) {
  if (typeof email !== "string") return null;
  const [local, domain] = email.split("@");
  if (!local || !domain) return null;
  return `${local.slice(0, 2)}***@${domain}`;
}

function exactObject(value, allowedKeys, requiredKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowedKeys.has(key)) &&
    requiredKeys.every((key) => Object.hasOwn(value, key))
  );
}

function moderationReason(value) {
  if (typeof value !== "string") return null;
  const reason = value.normalize("NFKC").trim();
  if (
    reason.length < 8 ||
    reason.length > 1_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)
  ) {
    return null;
  }
  return reason;
}

function announcementText(value, minimum, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function announcementPath(value) {
  const normalized = announcementText(value, 1, 500);
  if (
    !normalized ||
    !normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    normalized.includes("\\") ||
    normalized.includes("://")
  ) {
    return null;
  }
  return normalized;
}

export function createAdminRequestHandler({
  store,
  config,
  adminSecurity,
  rateLimiters,
}) {
  const strictCookie = { sameSite: "Strict" };
  const clearAdminCookie = () =>
    clearSecureCookie(config.adminCookie, strictCookie);

  return async function handleAdminRequest(request, response, url) {
    if (!url.pathname.startsWith("/api/admin/")) return false;

    const requestId = randomUUID();
    response.setHeader("X-Request-ID", requestId);
    if (!config.adminEnabled || !adminSecurity) {
      sendJson(response, 404, { error: "not_found" });
      return true;
    }

    const isWrite = request.method !== "GET" && request.method !== "HEAD";
    if (isWrite && !trustedOrigin(request, config.allowedOrigins)) {
      sendJson(response, 403, { error: "untrusted_origin" });
      return true;
    }

    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies.get(config.sessionCookie);
    const session = isOpaqueToken(sessionToken)
      ? await store.getActiveSession(
          tokenDigest(sessionToken, config.tokenPepper),
        )
      : null;
    if (!session) {
      sendJson(response, 401, { error: "authentication_required" }, [
        clearAdminCookie(),
      ]);
      return true;
    }
    if (session.role !== "admin") {
      sendJson(response, 403, { error: "admin_forbidden" }, [
        clearAdminCookie(),
      ]);
      return true;
    }

    const elevationToken = cookies.get(config.adminCookie);
    const elevationTokenHash = isOpaqueToken(elevationToken)
      ? tokenDigest(elevationToken, config.tokenPepper)
      : null;

    if (url.pathname === "/api/admin/session") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const access = await store.getAdminAccessState({
        userId: session.userId,
        sessionId: session.id,
        elevationTokenHash,
      });
      sendJson(response, 200, {
        role: "admin",
        mfaConfigured: access?.mfaConfigured === true,
        elevated: access?.elevated === true,
        elevatedUntil: access?.elevatedUntil ?? null,
      });
      return true;
    }

    if (url.pathname === "/api/admin/elevation") {
      if (request.method !== "POST" && request.method !== "DELETE") {
        methodNotAllowed(response, "POST, DELETE");
        return true;
      }
      if (request.method === "DELETE") {
        if (elevationTokenHash) {
          await store.revokeAdminElevation({
            userId: session.userId,
            sessionId: session.id,
            elevationTokenHash,
          });
        }
        sendJson(response, 200, { ok: true, elevated: false }, [
          clearAdminCookie(),
        ]);
        return true;
      }

      const rateKey = tokenDigest(
        `admin-mfa:${clientAddress(request)}:${session.userId}:${session.id}`,
        config.tokenPepper,
      );
      if (
        !(await (rateLimiters.adminMfa ?? rateLimiters.write).consume(rateKey))
      ) {
        response.setHeader("Retry-After", "60");
        sendJson(response, 429, { error: "admin_mfa_rate_limited" });
        return true;
      }
      const body = await readJsonBody(request);
      const code = typeof body?.code === "string" ? body.code.trim() : "";
      const mfa = await store.getAdminMfaCredential(session.userId);
      if (!mfa) {
        sendJson(response, 403, { error: "admin_mfa_invalid" });
        return true;
      }

      const newElevationToken = createOpaqueToken();
      const input = {
        userId: session.userId,
        sessionId: session.id,
        tokenHash: tokenDigest(newElevationToken, config.tokenPepper),
        expiresAt: new Date(
          Date.now() + config.adminElevationTtlSeconds * 1_000,
        ),
        ipHash: tokenDigest(
          `admin-ip:${clientAddress(request)}`,
          config.tokenPepper,
        ),
        userAgentHash: tokenDigest(
          `admin-ua:${String(request.headers["user-agent"] ?? "")}`,
          config.tokenPepper,
        ),
        requestId,
      };

      let elevated = false;
      if (/^\d{6}$/u.test(code)) {
        let matchedStep = null;
        try {
          matchedStep = adminSecurity.verifyTotp(
            mfa.encrypted,
            { factorId: mfa.factorId, userId: session.userId },
            code,
            mfa.lastTotpStep,
          );
        } catch {
          matchedStep = null;
        }
        if (matchedStep !== null) {
          elevated = await store.createAdminElevationFromTotp({
            ...input,
            matchedStep,
          });
        }
      } else if (/^[A-Z2-7-]{26,40}$/iu.test(code)) {
        elevated = await store.createAdminElevationFromRecovery({
          ...input,
          recoveryCodeHash: adminSecurity.hashRecoveryCode(code),
        });
      }

      if (!elevated) {
        sendJson(response, 403, { error: "admin_mfa_invalid" });
        return true;
      }
      sendJson(
        response,
        200,
        {
          ok: true,
          elevated: true,
          elevatedUntil: input.expiresAt.toISOString(),
        },
        [
          serializeSecureCookie(
            config.adminCookie,
            newElevationToken,
            config.adminElevationTtlSeconds,
            strictCookie,
          ),
        ],
      );
      return true;
    }

    if (!elevationTokenHash) {
      sendJson(response, 403, { error: "admin_mfa_required" });
      return true;
    }
    const access = await store.getAdminAccessState({
      userId: session.userId,
      sessionId: session.id,
      elevationTokenHash,
    });
    if (!access?.elevated) {
      sendJson(response, 403, { error: "admin_mfa_required" }, [
        clearAdminCookie(),
      ]);
      return true;
    }

    if (url.pathname === "/api/admin/overview") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      sendJson(response, 200, {
        overview: await store.getAdminOverview(),
      });
      return true;
    }

    if (url.pathname === "/api/admin/users") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const query = String(url.searchParams.get("query") ?? "").trim();
      if (query.length > 64) {
        sendJson(response, 400, { error: "invalid_admin_query" });
        return true;
      }
      const users = await store.listAdminUsers({ query, limit: 50 });
      sendJson(response, 200, {
        users: users.map((user) => {
          const { email, ...safeUser } = user;
          return { ...safeUser, emailMasked: maskedEmail(email) };
        }),
      });
      return true;
    }

    if (url.pathname === "/api/admin/audit") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      sendJson(response, 200, {
        events: await store.listAdminAudit({ limit: 50 }),
      });
      return true;
    }

    if (url.pathname === "/api/admin/community/announcements") {
      if (request.method === "GET") {
        sendJson(response, 200, {
          announcements: await store.listAdminCommunityAnnouncements({
            limit: 10,
          }),
        });
        return true;
      }
      if (request.method !== "POST") {
        methodNotAllowed(response, "GET, POST");
        return true;
      }
      const body = await readJsonBody(request);
      const title = announcementText(body?.title, 4, 160);
      const announcementBody = announcementText(body?.body, 1, 500);
      const fallbackPath = announcementPath(body?.fallbackPath);
      if (
        !exactObject(
          body,
          new Set(["mutationId", "title", "body", "fallbackPath"]),
          ["mutationId", "title", "body", "fallbackPath"],
        ) ||
        !isUuid(body.mutationId) ||
        !title ||
        !announcementBody ||
        !fallbackPath
      ) {
        sendJson(response, 400, { error: "invalid_community_announcement" });
        return true;
      }
      const rateKey = tokenDigest(
        `admin-announcement:${clientAddress(request)}:${session.userId}:${session.id}`,
        config.tokenPepper,
      );
      if (
        !(await (
          rateLimiters.adminAnnouncement ?? rateLimiters.write
        ).consume(rateKey))
      ) {
        response.setHeader("Retry-After", "600");
        sendJson(response, 429, {
          error: "community_announcement_rate_limited",
        });
        return true;
      }
      try {
        const announcement = await store.publishCommunityAnnouncement({
          actorUserId: session.userId,
          actorSessionId: session.id,
          actorElevationTokenHash: elevationTokenHash,
          mutationId: body.mutationId,
          title,
          body: announcementBody,
          fallbackPath,
          requestId,
          ipHash: tokenDigest(
            `admin-ip:${clientAddress(request)}`,
            config.tokenPepper,
          ),
          userAgentHash: tokenDigest(
            `admin-ua:${String(request.headers["user-agent"] ?? "")}`,
            config.tokenPepper,
          ),
        });
        sendJson(response, announcement.duplicate ? 200 : 201, {
          announcement,
        });
      } catch (error) {
        if (error?.code === "AUTH_ADMIN_FORBIDDEN") {
          sendJson(response, 403, { error: "admin_mfa_required" }, [
            clearAdminCookie(),
          ]);
        } else if (
          error?.code === "COMMUNITY_ANNOUNCEMENT_MUTATION_CONFLICT"
        ) {
          sendJson(response, 409, {
            error: "community_announcement_mutation_conflict",
          });
        } else {
          throw error;
        }
      }
      return true;
    }

    if (url.pathname === "/api/admin/teacher-reviews/candidates") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const status = url.searchParams.get("status") ?? "pending";
      const limitValue = url.searchParams.get("limit") ?? "50";
      const afterCreatedAtValue = url.searchParams.get("afterCreatedAt");
      const afterId = url.searchParams.get("afterId");
      const limit = /^\d{1,3}$/u.test(limitValue) ? Number(limitValue) : 0;
      const afterCreatedAt = afterCreatedAtValue && !Number.isNaN(Date.parse(afterCreatedAtValue))
        ? new Date(afterCreatedAtValue).toISOString()
        : null;
      if (
        !["pending", "approved", "rejected", "rolled_back"].includes(status) ||
        limit < 1 || limit > 50 ||
        Boolean(afterCreatedAtValue) !== Boolean(afterId) ||
        (afterCreatedAtValue && !afterCreatedAt) ||
        (afterId && !isUuid(afterId))
      ) {
        sendJson(response, 400, { error: "invalid_teacher_review_candidate_query" });
        return true;
      }
      try {
        const candidates = await store.listAdminTeacherReviewCandidates({
          actorUserId: session.userId,
          actorSessionId: session.id,
          actorElevationTokenHash: elevationTokenHash,
          status,
          afterCreatedAt,
          afterId,
          limit,
        });
        const last = candidates.length === limit ? candidates.at(-1) : null;
        sendJson(response, 200, {
          candidates,
          nextCursor: last ? { createdAt: last.createdAt, id: last.id } : null,
        });
      } catch (error) {
        if (error?.code === "AUTH_ADMIN_FORBIDDEN") {
          sendJson(response, 403, { error: "admin_mfa_required" }, [clearAdminCookie()]);
        } else if (error?.code === "TEACHER_REVIEW_QUERY_INVALID") {
          sendJson(response, 400, { error: "invalid_teacher_review_candidate_query" });
        } else {
          throw error;
        }
      }
      return true;
    }

    const teacherReviewDecisionMatch = url.pathname.match(
      /^\/api\/admin\/teacher-reviews\/candidates\/([0-9a-f-]{36})\/decision$/iu,
    );
    if (teacherReviewDecisionMatch) {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return true;
      }
      if (!isUuid(teacherReviewDecisionMatch[1])) {
        sendJson(response, 404, { error: "teacher_review_candidate_not_found" });
        return true;
      }
      const body = await readJsonBody(request);
      const reason = moderationReason(body?.reason);
      if (
        !exactObject(body, new Set(["decision", "reason"]), ["decision", "reason"]) ||
        !["approve", "reject"].includes(body.decision) ||
        !reason
      ) {
        sendJson(response, 400, { error: "invalid_teacher_review_decision" });
        return true;
      }
      const rateKey = tokenDigest(
        `teacher-review-moderation:${clientAddress(request)}:${session.userId}:${session.id}`,
        config.tokenPepper,
      );
      if (
        !(await (
          rateLimiters.teacherReviewModeration ?? rateLimiters.write
        ).consume(rateKey))
      ) {
        response.setHeader("Retry-After", "60");
        sendJson(response, 429, { error: "teacher_review_moderation_rate_limited" });
        return true;
      }
      try {
        const candidate = await store.moderateAdminTeacherReviewCandidate({
          actorUserId: session.userId,
          actorSessionId: session.id,
          actorElevationTokenHash: elevationTokenHash,
          candidateId: teacherReviewDecisionMatch[1],
          decision: body.decision,
          reason,
          requestId,
          ipHash: tokenDigest(`admin-ip:${clientAddress(request)}`, config.tokenPepper),
          userAgentHash: tokenDigest(
            `admin-ua:${String(request.headers["user-agent"] ?? "")}`,
            config.tokenPepper,
          ),
        });
        sendJson(response, 200, { candidate });
      } catch (error) {
        if (error?.code === "AUTH_ADMIN_FORBIDDEN") {
          sendJson(response, 403, { error: "admin_mfa_required" }, [clearAdminCookie()]);
        } else if (error?.code === "TEACHER_REVIEW_CANDIDATE_NOT_FOUND") {
          sendJson(response, 404, { error: "teacher_review_candidate_not_found" });
        } else if (error?.code === "TEACHER_REVIEW_CANDIDATE_CONFLICT") {
          sendJson(response, 409, { error: "teacher_review_candidate_conflict" });
        } else if (error?.code === "TEACHER_REVIEW_DECISION_INVALID") {
          sendJson(response, 400, { error: "invalid_teacher_review_decision" });
        } else {
          throw error;
        }
      }
      return true;
    }

    if (url.pathname === "/api/admin/community/reports") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const status = url.searchParams.get("status") ?? "open";
      if (!["open", "reviewing"].includes(status)) {
        sendJson(response, 400, { error: "invalid_community_report_query" });
        return true;
      }
      sendJson(response, 200, {
        reports: await store.listCommunityReportQueue({ status, limit: 50 }),
      });
      return true;
    }

    const reportCaseMatch = url.pathname.match(
      /^\/api\/admin\/community\/reports\/([0-9a-f-]{36})\/case$/iu,
    );
    if (reportCaseMatch) {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return true;
      }
      if (!isUuid(reportCaseMatch[1])) {
        sendJson(response, 404, { error: "community_report_not_found" });
        return true;
      }
      const body = await readJsonBody(request);
      const reason = moderationReason(body?.reason);
      if (
        !exactObject(body, new Set(["reason"]), ["reason"]) ||
        !reason
      ) {
        sendJson(response, 400, { error: "invalid_community_case" });
        return true;
      }
      try {
        const moderationCase = await store.openCommunityModerationCase({
          actorUserId: session.userId,
          actorSessionId: session.id,
          actorElevationTokenHash: elevationTokenHash,
          reportId: reportCaseMatch[1],
          reason,
          requestId,
          ipHash: tokenDigest(
            `admin-ip:${clientAddress(request)}`,
            config.tokenPepper,
          ),
          userAgentHash: tokenDigest(
            `admin-ua:${String(request.headers["user-agent"] ?? "")}`,
            config.tokenPepper,
          ),
        });
        sendJson(response, 200, { case: moderationCase });
      } catch (error) {
        if (error?.code === "AUTH_ADMIN_FORBIDDEN") {
          sendJson(response, 403, { error: "admin_mfa_required" }, [
            clearAdminCookie(),
          ]);
        } else if (error?.code === "COMMUNITY_REPORT_NOT_FOUND") {
          sendJson(response, 404, { error: "community_report_not_found" });
        } else {
          throw error;
        }
      }
      return true;
    }

    const caseActionMatch = url.pathname.match(
      /^\/api\/admin\/community\/cases\/([0-9a-f-]{36})\/actions$/iu,
    );
    if (caseActionMatch) {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return true;
      }
      if (!isUuid(caseActionMatch[1])) {
        sendJson(response, 404, { error: "community_case_not_found" });
        return true;
      }
      const body = await readJsonBody(request);
      const reason = moderationReason(body?.reason);
      const actions = new Set([
        "hide",
        "restore",
        "delete",
        "warn",
        "suspend",
        "ban",
        "unban",
        "dismiss",
      ]);
      const durationHours = body?.durationHours ?? null;
      const validDuration =
        durationHours === null ||
        (Number.isSafeInteger(durationHours) &&
          durationHours >= 1 &&
          durationHours <= 8_760);
      if (
        !exactObject(
          body,
          new Set(["action", "reason", "durationHours"]),
          ["action", "reason"],
        ) ||
        !actions.has(body.action) ||
        !reason ||
        !validDuration ||
        (body.action === "suspend" && durationHours === null) ||
        (!["suspend", "ban"].includes(body.action) && durationHours !== null)
      ) {
        sendJson(response, 400, {
          error: "invalid_community_moderation_action",
        });
        return true;
      }
      try {
        const moderationCase = await store.applyCommunityModerationAction({
          actorUserId: session.userId,
          actorSessionId: session.id,
          actorElevationTokenHash: elevationTokenHash,
          caseId: caseActionMatch[1],
          action: body.action,
          reason,
          durationHours,
          requestId,
          ipHash: tokenDigest(
            `admin-ip:${clientAddress(request)}`,
            config.tokenPepper,
          ),
          userAgentHash: tokenDigest(
            `admin-ua:${String(request.headers["user-agent"] ?? "")}`,
            config.tokenPepper,
          ),
        });
        sendJson(response, 200, { case: moderationCase });
      } catch (error) {
        if (error?.code === "AUTH_ADMIN_FORBIDDEN") {
          sendJson(response, 403, { error: "admin_mfa_required" }, [
            clearAdminCookie(),
          ]);
        } else if (error?.code === "COMMUNITY_CASE_NOT_FOUND") {
          sendJson(response, 404, { error: "community_case_not_found" });
        } else if (
          error?.code === "COMMUNITY_MODERATION_ACTION_INVALID" ||
          error?.code === "COMMUNITY_MODERATION_SELF_FORBIDDEN"
        ) {
          sendJson(response, 400, {
            error: "invalid_community_moderation_action",
          });
        } else if (error?.code === "COMMUNITY_MODERATION_STATE_CONFLICT") {
          sendJson(response, 409, {
            error: "community_moderation_state_conflict",
          });
        } else {
          throw error;
        }
      }
      return true;
    }

    const statusMatch = url.pathname.match(
      /^\/api\/admin\/users\/([0-9a-f-]{36})\/status$/iu,
    );
    if (statusMatch) {
      if (request.method !== "PATCH") {
        methodNotAllowed(response, "PATCH");
        return true;
      }
      if (!isUuid(statusMatch[1])) {
        sendJson(response, 404, { error: "admin_user_not_found" });
        return true;
      }
      const body = await readJsonBody(request);
      const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      if (
        !["active", "disabled"].includes(body?.status) ||
        reason.length < 8 ||
        reason.length > 500 ||
        (body?.expectedStatus !== undefined &&
          !["active", "disabled"].includes(body.expectedStatus))
      ) {
        sendJson(response, 400, { error: "invalid_admin_user_update" });
        return true;
      }
      if (statusMatch[1] === session.userId && body.status === "disabled") {
        sendJson(response, 409, { error: "admin_self_disable_forbidden" });
        return true;
      }
      let result;
      try {
        result = await store.updateAdminUserStatus({
          actorUserId: session.userId,
          actorSessionId: session.id,
          actorElevationTokenHash: elevationTokenHash,
          targetUserId: statusMatch[1],
          status: body.status,
          expectedStatus: body.expectedStatus ?? null,
          reason,
          requestId,
          ipHash: tokenDigest(
            `admin-ip:${clientAddress(request)}`,
            config.tokenPepper,
          ),
          userAgentHash: tokenDigest(
            `admin-ua:${String(request.headers["user-agent"] ?? "")}`,
            config.tokenPepper,
          ),
        });
      } catch (error) {
        if (error?.code === "AUTH_ADMIN_FORBIDDEN") {
          sendJson(response, 403, { error: "admin_mfa_required" }, [
            clearAdminCookie(),
          ]);
          return true;
        }
        if (error?.code === "AUTH_ADMIN_SELF_DISABLE") {
          sendJson(response, 409, { error: "admin_self_disable_forbidden" });
          return true;
        }
        throw error;
      }
      if (!result) {
        sendJson(response, 404, { error: "admin_user_not_found" });
      } else if (result.conflict) {
        sendJson(response, 409, {
          error: "admin_user_status_conflict",
          currentStatus: result.currentStatus,
        });
      } else {
        sendJson(response, 200, { user: result.user });
      }
      return true;
    }

    sendJson(response, 404, { error: "not_found" });
    return true;
  };
}
