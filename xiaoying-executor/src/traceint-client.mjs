import {
  TRACEINT_PROTOCOL,
  cancelReservationOperation,
  libraryLayoutOperation,
  listLibrariesOperation,
  reservationInfoOperation,
  reserveSeatOperation,
  tomorrowReservationInfoOperation,
  tomorrowReserveOperation,
  tomorrowWarmUpOperation,
} from "./traceint-protocol.mjs";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36 MicroMessenger";

export class TraceIntError extends Error {
  constructor(message, code = "TRACEINT_FAILED", options = {}) {
    super(message, options);
    this.name = "TraceIntError";
    this.code = code;
  }
}

function requiredPositiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} 无效`);
  return parsed;
}

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function booleanLike(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true" || value === "1";
  return false;
}

function findError(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.message === "string" && value.message.trim()) {
    return { message: value.message.trim(), code: value.code ?? null };
  }
  if (typeof value.msg === "string" && value.msg.trim()) {
    return { message: value.msg.trim(), code: value.code ?? null };
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findError(child);
    if (found) return found;
  }
  return null;
}

function assertGraphQlSuccess(body) {
  const error = findError(body?.errors);
  if (!error) return;
  const denied = /access denied/i.test(error.message) || Number(error.code) === 40001;
  throw new TraceIntError(
    denied ? "图书馆登录已过期，请重新连接" : error.message,
    denied ? "SESSION_EXPIRED" : "GRAPHQL_ERROR",
  );
}

function setCookiePairs(headers) {
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
  return values
    .flatMap((value) => String(value).split(/,(?=[^;,]+=)/))
    .map((value) => value.split(";", 1)[0].trim())
    .filter((value) => value.includes("="));
}

function mergeCookieJar(jar, pairs) {
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function extractAuthorizationCode(value) {
  const input = requiredText(value, "授权信息");
  if (/^[A-Za-z0-9_-]{8,512}$/.test(input)) return input;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("没有找到有效的图书馆授权码");
  }
  const code = url.searchParams.get("code");
  if (!code || !/^[A-Za-z0-9_-]{8,512}$/.test(code)) {
    throw new Error("这不是授权链接：地址中没有 code= 授权码");
  }
  return code;
}

export class TraceIntClient {
  constructor({
    fetchImpl = globalThis.fetch,
    protocol = TRACEINT_PROTOCOL,
    timeoutMs = 12_000,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("缺少 fetch 实现");
    this.fetch = fetchImpl;
    this.protocol = protocol;
    this.timeoutMs = timeoutMs;
  }

  async exchangeAuthorization(value) {
    const code = extractAuthorizationCode(value);
    const authorizationUrl = new URL(this.protocol.cookieEndpoint);
    authorizationUrl.searchParams.set("r", this.protocol.authorizationReturnUrl);
    authorizationUrl.searchParams.set("code", code);
    authorizationUrl.searchParams.set("state", "1");

    const jar = new Map();
    let currentUrl = authorizationUrl;
    for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
      this.#assertAllowedTraceIntUrl(currentUrl);
      const response = await this.#request(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          ...(jar.size ? { cookie: cookieHeader(jar) } : {}),
          "user-agent": DEFAULT_USER_AGENT,
        },
      });
      mergeCookieJar(jar, setCookiePairs(response.headers));
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl);
    }

    if (jar.size < 2) {
      throw new TraceIntError("图书馆授权没有成功，请重新打开授权页面", "AUTHORIZATION_FAILED");
    }
    const sessionCookie = cookieHeader(jar);
    await this.listLibraries(sessionCookie);
    return sessionCookie;
  }

  async validateSession(sessionCookie) {
    await this.listLibraries(sessionCookie);
    return true;
  }

  async listLibraries(sessionCookie) {
    const body = await this.#graphQl(sessionCookie, listLibrariesOperation());
    const libraries = body?.data?.userAuth?.reserve?.libs;
    if (!Array.isArray(libraries)) throw new TraceIntError("场馆数据格式已变化", "PROTOCOL_CHANGED");
    return libraries
      .filter((library) => String(library.lib_floor ?? "") !== "0")
      .map((library) => ({
        libraryId: Number(library.lib_id),
        name: String(library.lib_name ?? "未命名场馆"),
        floor: String(library.lib_floor ?? ""),
        isOpen: Boolean(library.is_open),
        totalSeats: Number(library.lib_rt?.seats_total ?? 0),
        usedSeats: Number(library.lib_rt?.seats_used ?? 0),
        bookedSeats: Number(library.lib_rt?.seats_booking ?? 0),
      }));
  }

  async getLibraryLayout(sessionCookie, libraryId) {
    const id = requiredPositiveInteger(libraryId, "场馆");
    const body = await this.#graphQl(sessionCookie, libraryLayoutOperation(id));
    const library = body?.data?.userAuth?.reserve?.libs?.[0];
    const layout = library?.lib_layout;
    if (!library || !layout || !Array.isArray(layout.seats)) {
      throw new TraceIntError("座位布局格式已变化", "PROTOCOL_CHANGED");
    }
    const seats = layout.seats
      .filter((seat) => (seat.type === undefined || Number(seat.type) === 1) && seat.key)
      .map((seat) => ({
        seatKey: String(seat.key),
        seatName: String(seat.name || seat.key),
        isOccupied: booleanLike(seat.status),
        isAvailable: !booleanLike(seat.status),
        x: Number(seat.x ?? 0),
        y: Number(seat.y ?? 0),
      }))
      .sort((a, b) => a.seatName.localeCompare(b.seatName, "zh-CN", { numeric: true }));
    return {
      libraryId: Number(library.lib_id),
      name: String(library.lib_name ?? "未命名场馆"),
      floor: String(library.lib_floor ?? ""),
      isOpen: Boolean(library.is_open),
      totalSeats: Number(layout.seats_total ?? 0),
      bookedSeats: Number(layout.seats_booking ?? 0),
      usedSeats: Number(layout.seats_used ?? 0),
      availableSeats: Math.max(
        0,
        Number(layout.seats_total ?? 0) -
          Number(layout.seats_booking ?? 0) -
          Number(layout.seats_used ?? 0),
      ),
      seats,
    };
  }

  async getCurrentReservation(sessionCookie) {
    const body = await this.#graphQl(sessionCookie, reservationInfoOperation());
    const reserveNode = body?.data?.userAuth?.reserve;
    const reservation = reserveNode?.reserve;
    if (!reservation) return null;
    return {
      reservationToken: String(reserveNode.getSToken ?? ""),
      libraryId: Number(reservation.lib_id),
      libraryName: String(reservation.lib_name ?? ""),
      floor: String(reservation.lib_floor ?? ""),
      seatKey: String(reservation.seat_key ?? ""),
      seatName: String(reservation.seat_name ?? ""),
      date: String(reservation.date ?? ""),
      expiresAt: Number.isFinite(Number(reservation.exp_date))
        ? new Date(Number(reservation.exp_date) * 1000).toISOString()
        : null,
    };
  }

  async reserveSeat(sessionCookie, { libraryId, seatKey }) {
    const body = await this.#graphQl(
      sessionCookie,
      reserveSeatOperation(
        requiredPositiveInteger(libraryId, "场馆"),
        requiredText(seatKey, "座位"),
      ),
      this.protocol.defaultProfile,
      { write: true },
    );
    return booleanLike(body?.data?.userAuth?.reserve?.reserueSeat);
  }

  async cancelReservation(sessionCookie, reservationToken) {
    const body = await this.#graphQl(
      sessionCookie,
      cancelReservationOperation(requiredText(reservationToken, "预约凭据")),
      this.protocol.defaultProfile,
      { write: true, allowSuccessMessage: true },
    );
    return Boolean(body?.data?.userAuth?.reserve?.reserveCancle ?? true);
  }

  async reserveTomorrow(sessionCookie, { libraryId, seatKey }) {
    const id = requiredPositiveInteger(libraryId, "场馆");
    const key = requiredText(seatKey, "座位");
    await this.#graphQl(
      sessionCookie,
      tomorrowWarmUpOperation(id),
      this.protocol.tomorrowProfile,
    );
    await this.#graphQl(
      sessionCookie,
      tomorrowReserveOperation(id, key),
      this.protocol.tomorrowProfile,
      { write: true },
    );
    return this.getTomorrowReservation(sessionCookie);
  }

  async getTomorrowReservation(sessionCookie) {
    const body = await this.#graphQl(
      sessionCookie,
      tomorrowReservationInfoOperation(),
      this.protocol.tomorrowProfile,
    );
    const reservation = body?.data?.userAuth?.prereserve?.prereserve;
    if (!reservation) return null;
    return {
      day: String(reservation.day ?? ""),
      libraryId: Number(reservation.lib_id ?? 0),
      seatKey: String(reservation.seat_key ?? ""),
      seatName: String(reservation.seat_name ?? ""),
      isUsed: booleanLike(reservation.is_used),
    };
  }

  async #graphQl(
    sessionCookie,
    operation,
    profile = this.protocol.defaultProfile,
    { write = false, allowSuccessMessage = false } = {},
  ) {
    const cookie = requiredText(sessionCookie, "图书馆会话");
    const response = await this.#request(this.protocol.graphQlEndpoint, {
      method: "POST",
      headers: {
        accept: "*/*",
        "accept-language": "zh-CN,zh;q=0.9",
        "app-version": profile.appVersion,
        "content-type": "application/json",
        cookie,
        origin: profile.origin,
        referer: profile.referer,
        "user-agent": DEFAULT_USER_AGENT,
      },
      body: JSON.stringify(operation),
    });
    if (!response.ok) {
      throw new TraceIntError(
        `图书馆接口暂时不可用（HTTP ${response.status}）`,
        response.status === 401 || response.status === 403 ? "SESSION_EXPIRED" : "HTTP_ERROR",
      );
    }
    const body = await response.json();
    const error = findError(body?.errors);
    if (allowSuccessMessage && error?.message?.includes("成功")) return body;
    assertGraphQlSuccess(body);
    if (write && body?.data?.userAuth == null) {
      throw new TraceIntError("图书馆操作没有返回结果", "WRITE_NOT_CONFIRMED");
    }
    return body;
  }

  async #request(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new TraceIntError("连接图书馆超时，请稍后重试", "TIMEOUT");
      }
      throw new TraceIntError("无法连接图书馆服务", "NETWORK_ERROR", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  #assertAllowedTraceIntUrl(url) {
    const hostname = url.hostname.toLowerCase();
    if (
      hostname !== "wechat.v2.traceint.com" &&
      hostname !== "web.traceint.com"
    ) {
      throw new TraceIntError("图书馆授权跳转到了不受信任的地址", "UNTRUSTED_REDIRECT");
    }
  }
}
