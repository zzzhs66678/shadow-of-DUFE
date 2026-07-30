import { contentHash } from "./security.mjs";

const DEFAULT_BASE_URL = "https://ginkgostu.dufe.edu.cn/";
const DEFAULT_BATCH = "";

export class BaiguoError extends Error {
  constructor(message, code = "BAIGUO_FAILED", options = {}) {
    super(message, options);
    this.name = "BaiguoError";
    this.code = code;
  }
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function optionalText(...values) {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null);
  if (value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function unwrapData(body) {
  return body?.data?.data ?? body?.data ?? body;
}

function stableId(prefix, parts) {
  return `${prefix}-${contentHash(parts).slice(0, 24)}`;
}

function collectCourseRecords(value, results = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return results;
  seen.add(value);
  if (
    optionalText(value.courseNo, value.courseCode) &&
    optionalText(value.courseName, value.name)
  ) {
    results.push(value);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectCourseRecords(child, results, seen);
  }
  return results;
}

function uniqueBy(items, keyOf) {
  const map = new Map();
  for (const item of items) map.set(keyOf(item), item);
  return [...map.values()];
}

function assignmentStatus(value) {
  switch (String(value ?? "")) {
    case "1":
      return "open";
    case "2":
      return "graded";
    case "3":
      return "submitted";
    case "4":
      return "overdue";
    default:
      return "unknown";
  }
}

function decodeBase64Parameter(value, field) {
  const encoded = requiredText(value, field);
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
  } catch {
    throw new Error(`${field} 格式无效`);
  }
  if (!decoded || decoded.includes("\uFFFD")) throw new Error(`${field} 格式无效`);
  return decoded;
}

export function extractBaiguoAuthorization(value) {
  let url;
  try {
    url = new URL(requiredText(value, "白果云授权链接"));
  } catch {
    throw new Error("白果云授权链接格式无效");
  }
  if (url.protocol !== "https:" || url.hostname !== "ginkgostu.dufe.edu.cn") {
    throw new Error("白果云授权链接地址不受信任");
  }
  return {
    token: decodeBase64Parameter(url.searchParams.get("token"), "token"),
    refreshToken: decodeBase64Parameter(
      url.searchParams.get("refresh_token"),
      "refresh_token",
    ),
    batchNo: "",
    fingerprint: null,
  };
}

export function mapBaiguoApiSnapshot({
  currentDate,
  courseSchedule,
  netCourses,
  noWeekCourses,
  homework,
  messages,
}) {
  const sourceCourses = collectCourseRecords([
    courseSchedule,
    netCourses,
    noWeekCourses,
  ]);
  const courses = uniqueBy(
    sourceCourses.map((course) => {
      const courseNo = requiredText(
        optionalText(course.courseNo, course.courseCode),
        "课程号",
      );
      const courseSeq = optionalText(course.courseSeq, course.sectionNo) ?? "";
      return {
        externalId: stableId("course", [courseNo, courseSeq]),
        sectionExternalId: courseSeq
          ? stableId("section", [courseNo, courseSeq])
          : null,
        title: requiredText(optionalText(course.courseName, course.name), "课程名称"),
        courseNo,
        courseSeq: courseSeq || null,
        teacherName: optionalText(course.teacherName, course.teacher),
      };
    }),
    (course) => course.externalId,
  );
  const courseByCode = new Map(
    courses.map((course) => [
      `${course.courseNo}:${course.courseSeq ?? ""}`,
      course.externalId,
    ]),
  );

  const homeworkRows = Array.isArray(homework) ? homework : [];
  const assignments = homeworkRows.map((item) => {
    const courseNo = optionalText(item.courseNo, item.courseCode) ?? "unknown";
    const courseSeq = optionalText(item.courseSeq, item.sectionNo) ?? "";
    const courseExternalId =
      courseByCode.get(`${courseNo}:${courseSeq}`) ??
      stableId("course", [courseNo, courseSeq]);
    const identity = [
      courseNo,
      courseSeq,
      item.paperId,
      item.weekTime,
      item.week,
      item.section,
    ];
    return {
      externalId: stableId("assignment", identity),
      courseExternalId,
      title:
        optionalText(item.homeworkName, item.paperName, item.title) ??
        `${optionalText(item.courseName) ?? "课程"}作业`,
      publishedAt: optionalText(item.startDate, item.beginDate),
      dueAt: optionalText(item.endDate, item.deadline),
      status: assignmentStatus(item.homeworkStatus),
      sourcePath: item.paperId ? `/homework/${item.paperId}` : "/homework",
    };
  });

  const messageRows = Array.isArray(messages?.list)
    ? messages.list
    : Array.isArray(messages)
      ? messages
      : [];
  const notifications = messageRows.map((message) => ({
    externalId: stableId("notice", [
      message.messageId,
      message.id,
      message.createTime,
      message.title,
    ]),
    title: optionalText(message.title, message.messageTitle) ?? "课程通知",
    publishedAt: optionalText(message.createTime, message.publishTime),
    read: String(message.readStatus ?? message.isread ?? "0") === "1",
    sourcePath: message.messageId
      ? `/notice/detail/${message.messageId}`
      : "/notice/system",
  }));

  return {
    currentDate: {
      today: optionalText(currentDate?.today),
      teachingWeek: Number(currentDate?.theWeek ?? 0) || null,
    },
    courses,
    assignments,
    events: [],
    notifications,
  };
}

export class BaiguoClient {
  constructor({
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 15_000,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("缺少 fetch 实现");
    const parsedBaseUrl = new URL(baseUrl);
    if (parsedBaseUrl.protocol !== "https:" || parsedBaseUrl.hostname !== "ginkgostu.dufe.edu.cn") {
      throw new Error("白果云地址不受信任");
    }
    this.fetch = fetchImpl;
    this.baseUrl = parsedBaseUrl;
    this.timeoutMs = timeoutMs;
  }

  async sync(credentials) {
    const normalized = this.#normalizeCredentials(credentials);
    try {
      const resolved = await this.#resolveBatch(normalized);
      const raw = await this.#fetchSnapshot(resolved);
      return {
        credentials: resolved,
        snapshot: mapBaiguoApiSnapshot(raw),
      };
    } catch (error) {
      if (!(error instanceof BaiguoError) || error.code !== "SESSION_EXPIRED" || !normalized.refreshToken) {
        throw error;
      }
      const refreshed = await this.refreshSession(normalized);
      const resolved = await this.#resolveBatch(refreshed);
      const raw = await this.#fetchSnapshot(resolved);
      return {
        credentials: resolved,
        snapshot: mapBaiguoApiSnapshot(raw),
      };
    }
  }

  async connectFromAuthorization(authorizationUrl) {
    const initial = extractBaiguoAuthorization(authorizationUrl);
    const refreshed = await this.refreshSession(initial);
    return this.sync(refreshed);
  }

  async refreshSession(credentials) {
    const normalized = this.#normalizeCredentials(credentials);
    if (!normalized.refreshToken) {
      throw new BaiguoError("白果云登录已过期，请重新连接", "SESSION_EXPIRED");
    }
    const response = await this.#request("/student/resetToken", {
      headers: {
        token: normalized.token,
        refreshToken: normalized.refreshToken,
      },
      allowUnauthorized: true,
    });
    if (response.status === 401 || response.status === 403) {
      throw new BaiguoError("白果云登录已过期，请重新连接", "SESSION_EXPIRED");
    }
    const body = await response.json();
    const data = unwrapData(body);
    if (!data?.token) {
      throw new BaiguoError("白果云没有返回新登录令牌", "REFRESH_FAILED");
    }
    return {
      ...normalized,
      token: String(data.token),
    };
  }

  async #fetchSnapshot(credentials) {
    const currentDate = unwrapData(await this.#json("/student/currentDate", credentials));
    const weekNo = Number(currentDate?.theWeek ?? 1) || 1;
    const batchNo = credentials.batchNo;
    const [courseSchedule, netCourses, noWeekCourses, homework, messages] =
      await Promise.all([
        this.#json(`/student/queryCourseList?weekNo=${encodeURIComponent(weekNo)}`, credentials),
        this.#json(`/student/queryNetCourseList?batchNo=${encodeURIComponent(batchNo)}`, credentials),
        this.#json(`/student/queryNoWeekTimeCourseList?batchNo=${encodeURIComponent(batchNo)}`, credentials),
        this.#json("/student/HomeworkList?operation=3", credentials),
        this.#json("/student/message/getMessageAll?pageSize=100&pageNo=1&readFlag=0", credentials),
      ]);
    return {
      currentDate,
      courseSchedule: unwrapData(courseSchedule),
      netCourses: unwrapData(netCourses),
      noWeekCourses: unwrapData(noWeekCourses),
      homework: unwrapData(homework),
      messages: unwrapData(messages),
    };
  }

  async #resolveBatch(credentials) {
    if (credentials.batchNo) return credentials;
    const terms = unwrapData(
      await this.#json("/student/term/getTermList", credentials),
    );
    const list = Array.isArray(terms) ? terms : [];
    const current =
      list.find((term) => ["1", "true"].includes(String(term.isCurrentTerm).toLowerCase())) ??
      list.at(-1);
    const batchNo = optionalText(current?.batchNo);
    if (!batchNo) {
      throw new BaiguoError("白果云没有返回当前学期", "TERM_NOT_FOUND");
    }
    return { ...credentials, batchNo };
  }

  async #json(path, credentials) {
    const response = await this.#request(path, {
      headers: {
        token: credentials.token,
        batchNo: credentials.batchNo,
        ...(credentials.fingerprint ? { fingerprint: credentials.fingerprint } : {}),
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new BaiguoError("白果云登录已过期，请重新连接", "SESSION_EXPIRED");
    }
    if (!response.ok) {
      throw new BaiguoError(`白果云接口暂时不可用（HTTP ${response.status}）`, "HTTP_ERROR");
    }
    const body = await response.json();
    if (Number(body?.code) === 401 || Number(body?.status) === 401) {
      throw new BaiguoError("白果云登录已过期，请重新连接", "SESSION_EXPIRED");
    }
    return body;
  }

  async #request(path, { headers, allowUnauthorized = false }) {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith("/student/")) {
      throw new BaiguoError("白果云请求地址不受信任", "UNTRUSTED_URL");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json, text/plain, */*",
          ...headers,
        },
        signal: controller.signal,
      });
      if (!allowUnauthorized && (response.status === 401 || response.status === 403)) {
        throw new BaiguoError("白果云登录已过期，请重新连接", "SESSION_EXPIRED");
      }
      return response;
    } catch (error) {
      if (error instanceof BaiguoError) throw error;
      if (error?.name === "AbortError") {
        throw new BaiguoError("连接白果云超时，请稍后重试", "TIMEOUT");
      }
      throw new BaiguoError("无法连接白果云", "NETWORK_ERROR", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  #normalizeCredentials(value) {
    return {
      token: requiredText(value?.token, "白果云令牌"),
      refreshToken: optionalText(value?.refreshToken),
      batchNo: optionalText(value?.batchNo) ?? DEFAULT_BATCH,
      fingerprint: optionalText(value?.fingerprint),
    };
  }
}
