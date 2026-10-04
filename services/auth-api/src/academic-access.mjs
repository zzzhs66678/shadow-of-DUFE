import {
  constants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from "node:crypto";

const DEFAULT_VPN_ORIGIN = "https://vpn.dufe.edu.cn";
const DEFAULT_ACADEMIC_ORIGIN =
  "http://zhjw-dufe-edu-cn.vpn.dufe.edu.cn:8118";
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const TRANSACTION_TTL_MS = 5 * 60_000;
const VPN_AUTH_SUCCESS = 1;
const VPN_AUTH_RELOGIN = 20_021;
const VPN_REDIRECT_CODE_START = 40_000;
const VPN_REDIRECT_CODE_END = 50_000;
const SSO_CHALLENGE_WIDTH = 280;
const SSO_CHALLENGE_HEIGHT = 155;
const SSO_CHALLENGE_PIECE_WIDTH = 80;
const SSO_CHALLENGE_MAX_OFFSET =
  SSO_CHALLENGE_WIDTH - SSO_CHALLENGE_PIECE_WIDTH / 2;

const WEEKDAYS = new Map([
  ["一", 1],
  ["二", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["日", 7],
  ["天", 7],
]);

function academicError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function redirectError(code, from, to, status, redirectIndex) {
  const error = academicError(code);
  error.diagnostic = {
    redirectFromOrigin: safeOrigin(from),
    redirectToOrigin: safeOrigin(to),
    redirectStatus: status,
    redirectIndex,
  };
  return error;
}

function stagedError(code, stage) {
  const error = academicError(code);
  error.stage = stage;
  return error;
}

async function atStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    if (error && typeof error === "object" && !error.stage) {
      error.stage = stage;
    }
    throw error;
  }
}

function effectivePort(url) {
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

function safeOrigin(url) {
  if (!(url instanceof URL) || !["http:", "https:"].includes(url.protocol)) {
    return "invalid";
  }
  return `${url.protocol}//${url.host}`;
}

function createTrustedTargetPolicy(vpn, academic) {
  const webVpnSuffix = `.${vpn.hostname}`;
  const webVpnPorts = new Map([
    ["http:", new Set(["80"])],
    ["https:", new Set(["443"])],
  ]);
  webVpnPorts.get(academic.protocol)?.add(effectivePort(academic));
  return (url) => {
    if (
      !(url instanceof URL) ||
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    ) {
      return false;
    }
    if (url.hostname === vpn.hostname) {
      return (
        url.protocol === vpn.protocol && effectivePort(url) === effectivePort(vpn)
      );
    }
    return (
      url.hostname.endsWith(webVpnSuffix) &&
      webVpnPorts.get(url.protocol)?.has(effectivePort(url)) === true
    );
  };
}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, "$1")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_, value) =>
      String.fromCodePoint(Number.parseInt(value, 10)),
    )
    .replace(/&#x([0-9a-f]+);/giu, (_, value) =>
      String.fromCodePoint(Number.parseInt(value, 16)),
    );
}

function xmlValue(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = String(xml ?? "").match(
    new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, "iu"),
  );
  return match ? decodeEntities(match[1]).trim() : "";
}

function parseAuthResponse(xml) {
  return {
    errorCode: Number.parseInt(xmlValue(xml, "ErrorCode") || "0", 10),
    message:
      xmlValue(xml, "Message") ||
      xmlValue(xml, "ErrorMsg") ||
      xmlValue(xml, "Note"),
    nextService: xmlValue(xml, "NextService"),
    csrfRandCode: xmlValue(xml, "CSRF_RAND_CODE"),
    rsaKey: xmlValue(xml, "RSA_ENCRYPT_KEY"),
    rsaExponent: Number.parseInt(
      xmlValue(xml, "RSA_ENCRYPT_EXP") || "65537",
      10,
    ),
    phone: xmlValue(xml, "Phone") || xmlValue(xml, "USER_PHONE"),
    currentPhone: xmlValue(xml, "CurPhone") || xmlValue(xml, "CURRENT_PHONE"),
    smsSendType: xmlValue(xml, "SmsSendType"),
    smsIsStillValid: Number.parseInt(
      xmlValue(xml, "SmsIsStillValid") || xmlValue(xml, "IS_IN_PERIOD") || "0",
      10,
    ),
    smsSendInterval: Number.parseInt(
      xmlValue(xml, "SmsSendInterval") || "0",
      10,
    ),
    twfId: xmlValue(xml, "TwfID"),
  };
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/=/gu, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

function exponentBytes(exponent) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(exponent);
  const first = bytes.findIndex((value) => value !== 0);
  return first === -1 ? Buffer.from([0]) : bytes.subarray(first);
}

function encryptPassword(password, csrfRandCode, modulus, exponent) {
  if (!/^[0-9a-f]{256,1024}$/iu.test(modulus)) {
    throw academicError("ACADEMIC_PROTOCOL_CHANGED");
  }
  const key = createPublicKey({
    key: {
      kty: "RSA",
      n: base64Url(Buffer.from(modulus, "hex")),
      e: base64Url(exponentBytes(exponent)),
    },
    format: "jwk",
  });
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(`${password}_${csrfRandCode}`, "utf8"),
  ).toString("hex");
}

class CookieJar {
  #cookies = new Map();

  update(response) {
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const pair = String(value).split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (!cookieValue) this.#cookies.delete(name);
      else this.#cookies.set(name, cookieValue);
    }
  }

  header() {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  set(name, value) {
    const normalizedName = String(name ?? "").trim();
    const normalizedValue = String(value ?? "").trim();
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(normalizedName) ||
      !normalizedValue ||
      /[;\r\n]/u.test(normalizedValue)
    ) {
      throw academicError("ACADEMIC_PROTOCOL_CHANGED");
    }
    this.#cookies.set(normalizedName, normalizedValue);
  }
}

async function readLimitedText(response, maxBytes = MAX_PAGE_BYTES) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw academicError("ACADEMIC_RESPONSE_TOO_LARGE");
  }
  const chunks = [];
  let size = 0;
  if (!response.body) return "";
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw academicError("ACADEMIC_RESPONSE_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  const contentType = response.headers.get("content-type") ?? "";
  const meta = bytes.subarray(0, 2048).toString("ascii");
  const charset =
    contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/iu)?.[1] ??
    meta.match(/charset\s*=\s*["']?([^;"'\s/>]+)/iu)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function requestWithCookies({
  fetchImpl,
  jar,
  url,
  isTrustedTarget,
  method = "GET",
  body,
  headers = {},
  maxRedirects = 6,
}) {
  let current = new URL(url);
  let currentMethod = method;
  let currentBody = body;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (!isTrustedTarget(current)) {
      throw redirectError(
        "ACADEMIC_UNTRUSTED_REDIRECT",
        current,
        current,
        0,
        redirect,
      );
    }
    let response;
    try {
      response = await fetchImpl(current, {
        method: currentMethod,
        body: currentBody,
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent":
            "Mozilla/5.0 (compatible; DufeshAcademicImport/1.0; +https://dufesh.cn)",
          ...(jar.header() ? { Cookie: jar.header() } : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw academicError("ACADEMIC_UPSTREAM_TIMEOUT");
      }
      throw academicError("ACADEMIC_UPSTREAM_UNAVAILABLE");
    }
    jar.update(response);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get("location");
    if (!location) throw academicError("ACADEMIC_PROTOCOL_CHANGED");
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw redirectError(
        "ACADEMIC_PROTOCOL_CHANGED",
        current,
        null,
        response.status,
        redirect + 1,
      );
    }
    if (!isTrustedTarget(next)) {
      throw redirectError(
        "ACADEMIC_UNTRUSTED_REDIRECT",
        current,
        next,
        response.status,
        redirect + 1,
      );
    }
    current = next;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
      currentMethod = "GET";
      currentBody = undefined;
    }
  }
  throw academicError("ACADEMIC_REDIRECT_LOOP");
}

function stripHtml(value) {
  return decodeEntities(
    String(value ?? "")
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<br\s*\/?\s*>/giu, "\n")
      .replace(/<\/(?:p|div|li|tr|td|th)>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/[\t\r ]+/gu, " ")
    .replace(/\s*\n\s*/gu, "\n")
    .trim();
}

function htmlAttribute(value, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = String(value ?? "").match(
    new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu"),
  );
  return decodeEntities(match?.[1] ?? match?.[2] ?? "").trim();
}

function namedInputValue(formHtml, name) {
  for (const match of String(formHtml ?? "").matchAll(/<input\b([^>]*)>/giu)) {
    if (htmlAttribute(match[1], "name") === name) {
      return htmlAttribute(match[1], "value");
    }
  }
  return "";
}

function parseSsoLoginForm(html, finalUrl, isTrustedTarget) {
  if (!(finalUrl instanceof URL)) return null;
  for (const match of String(html ?? "").matchAll(
    /<form\b([^>]*)>([\s\S]*?)<\/form>/giu,
  )) {
    const formHtml = match[2];
    const inputNames = new Set(
      [...formHtml.matchAll(/<input\b([^>]*)>/giu)]
        .map((input) => htmlAttribute(input[1], "name"))
        .filter(Boolean),
    );
    if (
      !inputNames.has("username") ||
      !inputNames.has("password") ||
      !inputNames.has("verify_token") ||
      !inputNames.has("verify_code") ||
      !inputNames.has("__token__")
    ) {
      continue;
    }
    let action;
    try {
      action = new URL(htmlAttribute(match[1], "action") || finalUrl.href, finalUrl);
    } catch {
      throw academicError("ACADEMIC_SSO_PROTOCOL_CHANGED");
    }
    if (
      !isTrustedTarget(action) ||
      action.origin !== finalUrl.origin ||
      action.pathname !== "/auth/cas/login"
    ) {
      throw academicError("ACADEMIC_SSO_PROTOCOL_CHANGED");
    }
    const csrfToken = namedInputValue(formHtml, "__token__");
    const encryptionSeed = String(html).match(
      /CryptoJS\.enc\.Utf8\.parse\(\s*['"]([A-Za-z0-9]{16,128})['"]\.substr\(\s*0\s*,\s*16\s*\)\s*\)/u,
    )?.[1];
    if (!csrfToken || csrfToken.length > 512 || !encryptionSeed) {
      throw academicError("ACADEMIC_SSO_PROTOCOL_CHANGED");
    }
    return { action, csrfToken, encryptionSeed };
  }
  return null;
}

function encryptSsoPassword(password, encryptionSeed) {
  const key = Buffer.from(encryptionSeed.slice(0, 16), "utf8");
  if (key.length !== 16) throw academicError("ACADEMIC_SSO_PROTOCOL_CHANGED");
  const clear = Buffer.from(String(password).trim(), "utf8");
  const paddingLength = (16 - (clear.length % 16)) % 16;
  const padded = paddingLength
    ? Buffer.concat([clear, Buffer.alloc(paddingLength)])
    : clear;
  const cipher = createCipheriv("aes-128-cbc", key, key);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function validChallengeImage(value) {
  return (
    typeof value === "string" &&
    value.length <= 256 * 1024 &&
    /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/u.test(value)
  );
}

function parseSsoChallenge(value) {
  let payload;
  try {
    payload = JSON.parse(value);
  } catch {
    throw academicError("ACADEMIC_SSO_PROTOCOL_CHANGED");
  }
  const data = payload?.data;
  if (
    payload?.code !== 1 ||
    !data ||
    typeof data.token !== "string" ||
    !/^[A-Za-z0-9]{16,128}$/u.test(data.token) ||
    !validChallengeImage(data.bg) ||
    !validChallengeImage(data.block)
  ) {
    throw academicError("ACADEMIC_SSO_PROTOCOL_CHANGED");
  }
  return {
    token: data.token,
    backgroundImage: data.bg,
    pieceImage: data.block,
  };
}

function structuralHtml(value) {
  return String(value ?? "").replace(
    /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu,
    (match) => " ".repeat(match.length),
  );
}

function tableElements(html) {
  const source = String(html ?? "");
  const masked = structuralHtml(source);
  const stack = [];
  const elements = [];
  for (const match of masked.matchAll(/<\s*(\/?)\s*table\b[^>]*>/giu)) {
    if (!match[1]) {
      stack.push(match.index);
      continue;
    }
    const start = stack.pop();
    if (start !== undefined) {
      elements.push({
        start,
        html: source.slice(start, match.index + match[0].length),
      });
    }
  }
  return elements
    .sort((left, right) => left.start - right.start)
    .map((element) => element.html);
}

function positiveSpan(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = String(attributes ?? "").match(
    new RegExp(
      `\\b${escaped}\\s*=\\s*(?:"(\\d+)"|'(\\d+)'|(\\d+))`,
      "iu",
    ),
  );
  const value = Number(match?.[1] ?? match?.[2] ?? match?.[3] ?? 1);
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : 1;
}

function rawTableRows(tableHtml) {
  const source = String(tableHtml ?? "");
  const masked = structuralHtml(source);
  const rows = [];
  let tableDepth = 0;
  let row = null;
  let cell = null;

  function finishCell(end) {
    if (!row || !cell) return;
    const html = source.slice(cell.contentStart, end);
    row.push({
      kind: cell.kind,
      html,
      text: stripHtml(html),
      rowspan: positiveSpan(cell.attributes, "rowspan"),
      colspan: positiveSpan(cell.attributes, "colspan"),
    });
    cell = null;
  }

  function finishRow() {
    if (row?.length) rows.push(row);
    row = null;
    cell = null;
  }

  for (const match of masked.matchAll(
    /<\s*(\/?)\s*(table|tr|th|td)\b([^>]*)>/giu,
  )) {
    const closing = Boolean(match[1]);
    const tag = match[2].toLowerCase();
    if (tag === "table") {
      if (!closing) {
        tableDepth += 1;
      } else {
        if (tableDepth === 1) {
          finishCell(match.index);
          finishRow();
        }
        tableDepth = Math.max(0, tableDepth - 1);
      }
      continue;
    }
    if (tableDepth !== 1) continue;
    if (tag === "tr") {
      if (!closing) {
        finishCell(match.index);
        finishRow();
        row = [];
      } else {
        finishCell(match.index);
        finishRow();
      }
      continue;
    }
    if (!row) continue;
    if (!closing) {
      finishCell(match.index);
      cell = {
        kind: tag,
        attributes: match[3],
        contentStart: match.index + match[0].length,
      };
    } else if (cell?.kind === tag) {
      finishCell(match.index);
    }
  }
  return rows;
}

function expandTableRows(rows) {
  const pending = new Map();
  const expanded = [];
  for (const sourceRow of rows) {
    const row = [];
    for (const [column, entry] of pending) {
      row[column] = entry.cell;
      entry.remaining -= 1;
      if (entry.remaining === 0) pending.delete(column);
    }
    for (const cell of sourceRow) {
      let column = 0;
      while (row[column]) column += 1;
      const colspan = cell.colspan ?? 1;
      while (
        Array.from({ length: colspan }, (_, offset) => row[column + offset]).some(
          Boolean,
        )
      ) {
        column += 1;
      }
      for (let offset = 0; offset < colspan; offset += 1) {
        row[column + offset] = cell;
        if ((cell.rowspan ?? 1) > 1) {
          pending.set(column + offset, {
            cell,
            remaining: cell.rowspan - 1,
          });
        }
      }
    }
    if (row.some(Boolean)) expanded.push(row);
  }
  return expanded;
}

function tableRows(tableHtml) {
  return expandTableRows(rawTableRows(tableHtml));
}

function tables(html) {
  return tableElements(html).map(tableRows).filter((rows) => rows.length);
}

function normalizedHeader(value) {
  return String(value ?? "").replace(/[\s：:（）()]/gu, "").trim();
}

function findHeaderIndex(headers, aliases) {
  const normalizedAliases = aliases.map(normalizedHeader);
  return headers.findIndex((header) =>
    normalizedAliases.includes(normalizedHeader(header)),
  );
}

function cellAt(cells, index) {
  return index >= 0 ? cells[index]?.text?.trim() ?? "" : "";
}

function digestId(prefix, parts) {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}:${digest}`;
}

export function parseWeeks(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/gu, "")
    .replace(/[—–~至]/gu, "-")
    .replace(/[，、；;]/gu, ",");
  const parity = /单(?:周)?/u.test(normalized)
    ? 1
    : /双(?:周)?/u.test(normalized)
      ? 0
      : null;
  const weeks = new Set();
  if (/全周|全学期|每周/u.test(normalized)) {
    for (let week = 1; week <= 18; week += 1) weeks.add(week);
  }
  const chineseNumbers = new Map([
    ["一", 1],
    ["二", 2],
    ["三", 3],
    ["四", 4],
    ["五", 5],
    ["六", 6],
    ["七", 7],
    ["八", 8],
    ["九", 9],
    ["十", 10],
  ]);
  const frontWeeks = normalized.match(/前([一二三四五六七八九十]|\d{1,2})周/u)?.[1];
  if (frontWeeks) {
    const end = chineseNumbers.get(frontWeeks) ?? Number(frontWeeks);
    if (Number.isInteger(end) && end >= 1 && end <= 30) {
      for (let week = 1; week <= end; week += 1) weeks.add(week);
    }
  }
  for (const match of normalized.matchAll(/(\d{1,2})(?:-(\d{1,2}))?/gu)) {
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > 30) continue;
    for (let week = start; week <= end; week += 1) {
      if (parity === null || week % 2 === parity) weeks.add(week);
    }
  }
  return [...weeks]
    .filter((week) => parity === null || week % 2 === parity)
    .sort((left, right) => left - right);
}

function blockForPeriods(periods) {
  const first = periods[0] ?? 1;
  if (first <= 2) return 1;
  if (first <= 4) return 2;
  if (first <= 7) return 3;
  return 4;
}

function locationParts(value) {
  const parts = String(value ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 3) {
    return {
      campus: parts[0],
      building: parts[1],
      room: parts.slice(2).join(" / "),
    };
  }
  return { campus: "", building: parts[0] ?? "", room: parts[1] ?? "" };
}

function meetingLocations(cell) {
  const lines = String(cell?.html ?? "")
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/(?:p|div|li)>/giu, "\n")
    .split("\n")
    .map(stripHtml)
    .filter((line) => line.includes("/"));
  if (lines.length) return lines.map(locationParts);
  const text = cell?.text ?? "";
  const matches = [...text.matchAll(/([^/\n]+)\s*\/\s*([^/\n]+)\s*\/\s*([^\n]+)/gu)];
  return matches.map((match) => locationParts(match.slice(1).join(" / ")));
}

function createMeeting({
  sectionId,
  weekday,
  periods,
  weeks,
  weekText,
  location,
}) {
  const weekdayName = [...WEEKDAYS].find(([, value]) => value === weekday)?.[0] ?? "";
  const start = periods[0];
  const end = periods.at(-1);
  return {
    id: digestId("academic-meeting", [
      sectionId,
      weekday,
      periods.join(","),
      weeks.join(","),
      location.campus,
      location.building,
      location.room,
    ]),
    weekday,
    periods,
    block: blockForPeriods(periods),
    weeks,
    weekText,
    timeText: `${weekText} / 星期${weekdayName} / ${start}${end === start ? "" : `-${end}`}节`,
    ...location,
  };
}

function parseMeetings(timeText, locationCell, sectionId) {
  const meetings = [];
  const locations = meetingLocations(locationCell);
  const normalized = String(timeText ?? "")
    .replace(/[—–~至]/gu, "-")
    .replace(/[，；;]/gu, ",");
  const pattern = /((?:\d{1,2}(?:\s*-\s*\d{1,2})?)(?:\s*[,、]\s*\d{1,2}(?:\s*-\s*\d{1,2})?)*)\s*周(?:\s*[（(]?\s*(单|双)\s*周?\s*[）)]?)?[\s/|]+(?:星期|周)([一二三四五六日天1-7])[\s/|]+(?:第\s*)?(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*节/gu;
  let index = 0;
  for (const match of normalized.matchAll(pattern)) {
    const weekText = `${match[1]}周${match[2] ? `(${match[2]}周)` : ""}`;
    const start = Number(match[4]);
    const end = Number(match[5] ?? match[4]);
    const periods = [];
    for (let period = start; period <= end; period += 1) periods.push(period);
    const location = locations[index] ?? locations.at(-1) ?? {
      campus: "",
      building: "",
      room: "",
    };
    const weekday = WEEKDAYS.get(match[3]) ?? Number(match[3]);
    const weeks = parseWeeks(weekText);
    if (!weekday || !weeks.length) continue;
    meetings.push(createMeeting({
      sectionId,
      weekday,
      periods,
      weeks,
      weekText,
      location,
    }));
    index += 1;
  }
  return meetings;
}

function parseWeekday(value) {
  const normalized = String(value ?? "").replace(/\s+/gu, "");
  const chinese = normalized.match(/(?:星期|周)?([一二三四五六日天])/u)?.[1];
  if (chinese) return WEEKDAYS.get(chinese) ?? 0;
  const numeric = Number(normalized.match(/(?:星期|周)?([1-7])(?:\D|$)/u)?.[1]);
  return numeric >= 1 && numeric <= 7 ? numeric : 0;
}

function parsePeriods(value, countValue) {
  const normalized = String(value ?? "")
    .replace(/[—–~至]/gu, "-")
    .replace(/[，、；;]/gu, ",");
  const range = normalized.match(/(\d{1,2})\s*-\s*(\d{1,2})/u);
  let periods = [];
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start >= 1 && end >= start && end <= 14) {
      periods = Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
  } else {
    periods = [...normalized.matchAll(/\d{1,2}/gu)]
      .map((match) => Number(match[0]))
      .filter((period) => period >= 1 && period <= 14);
  }
  const count = Number(String(countValue ?? "").match(/\d{1,2}/u)?.[0]);
  if (periods.length === 1 && count > 1 && periods[0] + count - 1 <= 14) {
    periods = Array.from({ length: count }, (_, index) => periods[0] + index);
  }
  return [...new Set(periods)].sort((left, right) => left - right);
}

function parseSeparatedMeeting(cells, columns, sectionId) {
  const weekText = cellAt(cells, columns.weeks);
  const weeks = parseWeeks(weekText);
  const weekday = parseWeekday(cellAt(cells, columns.weekday));
  const periods = parsePeriods(
    cellAt(cells, columns.periods),
    cellAt(cells, columns.periodCount),
  );
  if (!weeks.length || !weekday || !periods.length) return [];
  const parsedLocation = locationParts(cellAt(cells, columns.location));
  const location = {
    campus: cellAt(cells, columns.campus) || parsedLocation.campus,
    building: cellAt(cells, columns.building) || parsedLocation.building,
    room: cellAt(cells, columns.room) || parsedLocation.room,
  };
  return [
    createMeeting({
      sectionId,
      weekday,
      periods,
      weeks,
      weekText,
      location,
    }),
  ];
}

function parseTermMetadata(html) {
  const text = stripHtml(html);
  const match =
    text.match(
      /(20\d{2})\s*-\s*(20\d{2})\s*(?:学年)?\s*第\s*([一二12])\s*学期/u,
    ) ??
    text.match(/(20\d{2})\s*-\s*(20\d{2})\s*-\s*([12])(?:\D|$)/u);
  if (!match) throw academicError("ACADEMIC_TERM_NOT_FOUND");
  const academicYear = `${match[1]}-${match[2]}`;
  const fall = match[3] === "一" || match[3] === "1";
  return {
    academicYear,
    term: fall ? "fall" : "spring",
    termLabel: fall ? "第一学期" : "第二学期",
    id: `${academicYear}-${fall ? "fall" : "spring"}`,
  };
}

function splitTeachers(value) {
  return [...new Set(
    String(value ?? "")
      .replace(/\*/gu, " ")
      .split(/[、,，/\s]+/u)
      .map((teacher) => teacher.trim())
      .filter(Boolean),
  )];
}

function findTableHeader(candidates, predicate) {
  for (const rows of candidates) {
    for (let index = 0; index < Math.min(rows.length, 12); index += 1) {
      const headers = rows[index].map((cell) => cell.text);
      if (predicate(headers)) return { rows, headerIndex: index, headers };
    }
  }
  return null;
}

export function parseTimetableHtml(html) {
  const term = parseTermMetadata(html);
  const candidates = tables(html);
  const table = findTableHeader(candidates, (headers) => {
    const hasCourse =
      findHeaderIndex(headers, ["课程号", "课程代码", "课程编号"]) >= 0 &&
      findHeaderIndex(headers, ["课程名", "课程名称"]) >= 0 &&
      findHeaderIndex(headers, ["课序号", "教学班号"]) >= 0;
    const hasCombinedTime =
      findHeaderIndex(headers, ["时间", "上课时间"]) >= 0;
    const hasSeparatedTime =
      findHeaderIndex(headers, ["周次", "上课周次", "起止周"]) >= 0 &&
      findHeaderIndex(headers, ["星期", "上课星期"]) >= 0 &&
      findHeaderIndex(headers, ["节次", "上课节次", "开始节次"]) >= 0;
    return hasCourse && (hasCombinedTime || hasSeparatedTime);
  });
  if (!table) throw academicError("ACADEMIC_TIMETABLE_FORMAT_CHANGED");
  const { rows, headerIndex, headers } = table;
  const columns = {
    courseCode: findHeaderIndex(headers, ["课程号", "课程代码", "课程编号"]),
    courseName: findHeaderIndex(headers, ["课程名", "课程名称"]),
    sectionCode: findHeaderIndex(headers, ["课序号", "教学班号"]),
    credits: findHeaderIndex(headers, ["学分"]),
    property: findHeaderIndex(headers, ["课程属性", "课程性质"]),
    category: findHeaderIndex(headers, ["课程类别"]),
    assessmentType: findHeaderIndex(headers, ["考试类型", "考核方式"]),
    teachers: findHeaderIndex(headers, ["教师", "任课教师"]),
    studyMode: findHeaderIndex(headers, ["修读方式"]),
    selectionStatus: findHeaderIndex(headers, ["选课状态"]),
    time: findHeaderIndex(headers, ["时间", "上课时间"]),
    location: findHeaderIndex(headers, ["地点", "上课地点"]),
    weeks: findHeaderIndex(headers, ["周次", "上课周次", "起止周"]),
    weekday: findHeaderIndex(headers, ["星期", "上课星期"]),
    periods: findHeaderIndex(headers, ["节次", "上课节次", "开始节次"]),
    periodCount: findHeaderIndex(headers, ["节数", "连上节数", "持续节数"]),
    campus: findHeaderIndex(headers, ["校区", "校区名称"]),
    building: findHeaderIndex(headers, ["教学楼", "楼宇", "楼栋"]),
    room: findHeaderIndex(headers, ["教室", "上课教室"]),
  };
  const sectionMap = new Map();
  for (const cells of rows.slice(headerIndex + 1)) {
    const courseCode = cellAt(cells, columns.courseCode);
    const courseName = cellAt(cells, columns.courseName);
    const sectionCode = cellAt(cells, columns.sectionCode);
    if (!courseCode || !courseName) continue;
    const id = digestId("academic-section", [
      term.id,
      courseCode,
      sectionCode,
    ]);
    let meetings = columns.time >= 0
      ? parseMeetings(cellAt(cells, columns.time), cells[columns.location], id)
      : [];
    if (!meetings.length && columns.weeks >= 0) {
      meetings = parseSeparatedMeeting(cells, columns, id);
    }
    const teachers = splitTeachers(cellAt(cells, columns.teachers));
    const existing = sectionMap.get(id);
    if (existing) {
      existing.teachers = [...new Set([...existing.teachers, ...teachers])];
      const meetingIds = new Set(existing.meetings.map((meeting) => meeting.id));
      existing.meetings.push(
        ...meetings.filter((meeting) => !meetingIds.has(meeting.id)),
      );
      continue;
    }
    sectionMap.set(id, {
      id,
      courseCode,
      courseName,
      sectionCode,
      credits: cellAt(cells, columns.credits),
      property: cellAt(cells, columns.property),
      category: cellAt(cells, columns.category),
      assessmentType: cellAt(cells, columns.assessmentType),
      teachers,
      studyMode: cellAt(cells, columns.studyMode),
      selectionStatus: cellAt(cells, columns.selectionStatus),
      meetings,
    });
  }
  const sections = [...sectionMap.values()];
  if (!sections.length) throw academicError("ACADEMIC_TIMETABLE_EMPTY");
  if (!sections.some((section) => section.meetings.length)) {
    throw academicError("ACADEMIC_TIMETABLE_FORMAT_CHANGED");
  }
  return { term, sections };
}

function parseDateAndTime(value) {
  const normalized = String(value ?? "").replace(/[年/.]/gu, "-").replace(/月/gu, "-").replace(/日/gu, " ");
  const dateMatch = normalized.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/u);
  const timeMatches = [...normalized.matchAll(/([01]?\d|2[0-3]):([0-5]\d)/gu)];
  const date = dateMatch
    ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`
    : "";
  return {
    date,
    startTime: timeMatches[0]?.[0] ?? "",
    endTime: timeMatches[1]?.[0] ?? "",
  };
}

export function parseExamHtml(html, term) {
  const candidates = tables(html);
  const table = findTableHeader(candidates, (headers) => {
    const hasCourse =
      findHeaderIndex(headers, ["课程名", "课程名称"]) >= 0 ||
      findHeaderIndex(headers, ["课程号", "课程代码", "课程编号"]) >= 0;
    const hasExam = headers.some((header) => /考试|考场|座位/u.test(header));
    return hasCourse && hasExam;
  });
  if (!table) {
    const text = stripHtml(html);
    if (/暂无(?:考试|数据|记录)|没有(?:考试|数据|记录)|无考试安排/u.test(text)) {
      return [];
    }
    throw academicError("ACADEMIC_EXAM_FORMAT_CHANGED");
  }
  const { rows, headerIndex, headers } = table;
  const columns = {
    courseCode: findHeaderIndex(headers, ["课程号", "课程代码", "课程编号"]),
    courseName: findHeaderIndex(headers, ["课程名", "课程名称"]),
    sectionCode: findHeaderIndex(headers, ["课序号", "教学班号"]),
    examType: findHeaderIndex(headers, ["考试类型", "考核方式"]),
    date: findHeaderIndex(headers, ["考试日期", "日期"]),
    time: findHeaderIndex(headers, ["考试时间", "时间", "考试日期时间"]),
    location: findHeaderIndex(headers, [
      "考试地点",
      "考场",
      "地点",
    ]),
    campus: findHeaderIndex(headers, ["校区", "校区名称"]),
    building: findHeaderIndex(headers, ["教学楼", "楼宇", "楼栋"]),
    room: findHeaderIndex(headers, ["考试教室", "考场教室", "教室"]),
    seat: findHeaderIndex(headers, ["座位号", "座号", "座位"]),
    status: findHeaderIndex(headers, ["考试状态", "状态"]),
  };
  const exams = [];
  for (const cells of rows.slice(headerIndex + 1)) {
    const courseName = cellAt(cells, columns.courseName);
    const courseCode = cellAt(cells, columns.courseCode);
    if (!courseName && !courseCode) continue;
    const sectionCode = cellAt(cells, columns.sectionCode);
    const dateText = [cellAt(cells, columns.date), cellAt(cells, columns.time)]
      .filter(Boolean)
      .join(" ");
    const timing = parseDateAndTime(dateText);
    const rawLocation = cellAt(cells, columns.location);
    const parsedLocation = locationParts(rawLocation);
    const campus = cellAt(cells, columns.campus) || parsedLocation.campus;
    const building =
      cellAt(cells, columns.building) || parsedLocation.building;
    const room = cellAt(cells, columns.room) || parsedLocation.room;
    const locationText =
      rawLocation || [campus, building, room].filter(Boolean).join(" / ");
    exams.push({
      id: digestId("academic-exam", [
        term.id,
        courseCode,
        sectionCode,
        timing.date,
        timing.startTime,
        locationText,
      ]),
      courseCode,
      courseName,
      sectionCode,
      examType: cellAt(cells, columns.examType),
      ...timing,
      campus,
      building,
      room,
      location: locationText,
      seat: cellAt(cells, columns.seat),
      status: cellAt(cells, columns.status),
    });
  }
  return exams;
}

function validateCredentials(username, password) {
  if (
    typeof username !== "string" ||
    username.trim().length < 1 ||
    username.trim().length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(username)
  ) {
    throw academicError("ACADEMIC_CREDENTIALS_INVALID");
  }
  if (
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 256 ||
    /[\u0000\r\n]/u.test(password)
  ) {
    throw academicError("ACADEMIC_CREDENTIALS_INVALID");
  }
  return { username: username.trim(), password };
}

function successAuth(result) {
  return (
    !result.nextService &&
    (result.errorCode === VPN_AUTH_SUCCESS ||
      result.errorCode === VPN_AUTH_RELOGIN ||
      (result.errorCode >= VPN_REDIRECT_CODE_START &&
        result.errorCode < VPN_REDIRECT_CODE_END))
  );
}

function smsService(value) {
  return /sms|message|phone/iu.test(String(value ?? ""));
}

function maskedPhone(value) {
  const phone = String(value ?? "").trim();
  if (phone.includes("*")) return phone;
  if (/^\d{7,15}$/u.test(phone)) {
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  }
  return phone.replace(/\d(?=\d{2})/gu, "*");
}

function phoneChoices(value) {
  return String(value ?? "")
    .split(";")
    .map((phone) => phone.trim())
    .filter(Boolean);
}

function validSmsPhone(value) {
  return /^((\([\d*]{1,9}\))|(\+[\d*]{1,9})|([\d*]{1,9}-))?[\d*]{6,20}$/u.test(
    String(value ?? "").trim(),
  );
}

function smsSendError(result) {
  if (result.errorCode === 20016) {
    return academicError("ACADEMIC_SMS_PHONE_UNAVAILABLE");
  }
  if (result.errorCode === 20054 || result.errorCode === 20055) {
    return academicError("ACADEMIC_SMS_PHONE_INVALID");
  }
  return academicError("ACADEMIC_SMS_SEND_FAILED");
}

export function createAcademicConnector({
  fetchImpl = fetch,
  vpnOrigin = DEFAULT_VPN_ORIGIN,
  academicOrigin = DEFAULT_ACADEMIC_ORIGIN,
  now = () => Date.now(),
  transactionTtlMs = TRANSACTION_TTL_MS,
} = {}) {
  const vpn = new URL(vpnOrigin);
  const academic = new URL(academicOrigin);
  const isTrustedTarget = createTrustedTargetPolicy(vpn, academic);
  const transactions = new Map();

  function destroyTransaction(id) {
    const transaction = transactions.get(id);
    if (transaction) {
      transaction.password = "";
      transaction.sso = null;
    }
    transactions.delete(id);
  }

  function cleanup() {
    const current = now();
    for (const [id, transaction] of transactions) {
      if (transaction.expiresAt <= current) destroyTransaction(id);
    }
  }

  function createTransaction(jar, principalKey, credentials, details = {}) {
    const transactionId = randomBytes(24).toString("base64url");
    const transaction = {
      jar,
      principalKey,
      username: credentials.username,
      password: credentials.password,
      fingerprint: randomBytes(16).toString("hex"),
      authenticated: false,
      sso: null,
      expiresAt: now() + transactionTtlMs,
      ...details,
    };
    transactions.set(transactionId, transaction);
    return { transactionId, transaction };
  }

  async function request(jar, url, options = {}) {
    return requestWithCookies({
      fetchImpl,
      jar,
      url,
      isTrustedTarget,
      ...options,
    });
  }

  async function readAuthResponse(jar, url, options = {}, stage = "vpn_auth") {
    return atStage(stage, async () => {
      const { response } = await request(jar, url, options);
      if (!response.ok) throw academicError("ACADEMIC_UPSTREAM_UNAVAILABLE");
      const result = parseAuthResponse(
        await readLimitedText(response, 256 * 1024),
      );
      // Sangfor's official portal updates its active TWFID from the XML auth
      // response. The value is not guaranteed to arrive as a Set-Cookie header.
      if (result.twfId) jar.set("TWFID", result.twfId);
      return result;
    });
  }

  function ssoRequired(transactionId, transaction, challenge, verificationFailed = false) {
    return {
      status: "sso_verification_required",
      transactionId,
      challenge: {
        backgroundImage: challenge.backgroundImage,
        pieceImage: challenge.pieceImage,
        width: SSO_CHALLENGE_WIDTH,
        height: SSO_CHALLENGE_HEIGHT,
        pieceWidth: SSO_CHALLENGE_PIECE_WIDTH,
        maxOffset: SSO_CHALLENGE_MAX_OFFSET,
      },
      ...(verificationFailed ? { verificationFailed: true } : {}),
      expiresInSeconds: Math.floor(
        Math.max(0, transaction.expiresAt - now()) / 1000,
      ),
    };
  }

  async function prepareSsoChallenge(
    transactionId,
    transaction,
    loginUrl,
    loginHtml,
    verificationFailed = false,
  ) {
    const form = parseSsoLoginForm(loginHtml, loginUrl, isTrustedTarget);
    if (!form) throw academicError("ACADEMIC_SSO_PROTOCOL_CHANGED");
    const widgetUrl = new URL("/auth/widget", form.action);
    widgetUrl.search = new URLSearchParams({
      layer: "image_verify",
      widget: "Slider",
      action: "get_verify",
      type: "login_image_verify",
    }).toString();
    const widgetResult = await atStage("sso_challenge", () =>
      request(transaction.jar, widgetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: form.action.origin,
          Referer: loginUrl.href,
        },
        body: new URLSearchParams({
          width: String(SSO_CHALLENGE_WIDTH),
          height: String(SSO_CHALLENGE_HEIGHT),
          block_size: String(SSO_CHALLENGE_PIECE_WIDTH),
        }),
      }),
    );
    if (!widgetResult.response.ok) {
      throw stagedError("ACADEMIC_UPSTREAM_UNAVAILABLE", "sso_challenge");
    }
    const challenge = parseSsoChallenge(
      await atStage("sso_challenge", () =>
        readLimitedText(widgetResult.response, 512 * 1024),
      ),
    );
    transaction.sso = {
      action: form.action,
      csrfToken: form.csrfToken,
      encryptionSeed: form.encryptionSeed,
      loginUrl,
      sliderToken: challenge.token,
    };
    transaction.expiresAt = now() + transactionTtlMs;
    return ssoRequired(
      transactionId,
      transaction,
      challenge,
      verificationFailed,
    );
  }

  function findSsoLogin(html, finalUrl) {
    const form = parseSsoLoginForm(html, finalUrl, isTrustedTarget);
    if (form) return form;
    if (
      finalUrl.pathname === "/auth/cas/login" ||
      /<title\b[^>]*>\s*统一身份认证中心\s*<\/title>/iu.test(html)
    ) {
      throw academicError("ACADEMIC_SSO_PROTOCOL_CHANGED");
    }
    return null;
  }

  async function importSnapshot(transactionId, transaction) {
    const timetableUrl = new URL(
      "/student/courseSelect/thisSemesterCurriculum/index",
      academic,
    );
    const examUrl = new URL(
      "/student/examinationManagement/examPlan/index",
      academic,
    );
    const timetableResult = await atStage("timetable_fetch", () =>
      request(transaction.jar, timetableUrl),
    );
    if (timetableResult.finalUrl.host === vpn.host) {
      throw stagedError("ACADEMIC_SESSION_NOT_READY", "timetable_fetch");
    }
    if (!timetableResult.response.ok) {
      throw stagedError("ACADEMIC_UPSTREAM_UNAVAILABLE", "timetable_fetch");
    }
    const timetableHtml = await atStage("timetable_fetch", () =>
      readLimitedText(timetableResult.response),
    );
    if (findSsoLogin(timetableHtml, timetableResult.finalUrl)) {
      return prepareSsoChallenge(
        transactionId,
        transaction,
        timetableResult.finalUrl,
        timetableHtml,
      );
    }
    const timetable = await atStage("timetable_parse", () =>
      parseTimetableHtml(timetableHtml),
    );
    const examResult = await atStage("exam_fetch", () =>
      request(transaction.jar, examUrl),
    );
    if (!examResult.response.ok) {
      throw stagedError("ACADEMIC_UPSTREAM_UNAVAILABLE", "exam_fetch");
    }
    const examHtml = await atStage("exam_fetch", () =>
      readLimitedText(examResult.response),
    );
    if (findSsoLogin(examHtml, examResult.finalUrl)) {
      return prepareSsoChallenge(
        transactionId,
        transaction,
        examResult.finalUrl,
        examHtml,
      );
    }
    return {
      status: "imported",
      snapshot: {
        schemaVersion: 1,
        ...timetable.term,
        importedAt: new Date(now()).toISOString(),
        sections: timetable.sections,
        exams: await atStage("exam_parse", () =>
          parseExamHtml(examHtml, timetable.term),
        ),
      },
    };
  }

  async function continueImport(transactionId, transaction) {
    try {
      const result = await importSnapshot(transactionId, transaction);
      if (result.status === "imported") destroyTransaction(transactionId);
      return result;
    } catch (error) {
      if (error && typeof error === "object") error.retryable = true;
      throw error;
    }
  }

  async function requestSmsConfig(jar) {
    const config = await readAuthResponse(
      jar,
      new URL("/por/login_sms.csp?apiversion=1", vpn),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(),
      },
      "vpn_sms_config",
    );
    if (config.errorCode !== 1) throw smsSendError(config);
    return config;
  }

  function smsRequired(transactionId, transaction) {
    return {
      status: "sms_required",
      transactionId,
      maskedPhone: transaction.maskedPhone,
      expiresInSeconds: Math.floor(
        Math.max(0, transaction.expiresAt - now()) / 1000,
      ),
    };
  }

  function smsDestinationRequired(transactionId, transaction) {
    return {
      status: "sms_destination_required",
      transactionId,
      destination: transaction.destination,
      phoneOptions:
        transaction.destination === "choose"
          ? transaction.phones.map((phone, index) => ({
              index,
              label: maskedPhone(phone),
            }))
          : [],
      expiresInSeconds: Math.floor(
        Math.max(0, transaction.expiresAt - now()) / 1000,
      ),
    };
  }

  async function dispatchSms(transactionId, transaction, phone, phoneIndex) {
    const sendPath = phone ? "/por/get_sms.csp" : "/por/post_sms.csp";
    const sent = await readAuthResponse(
      transaction.jar,
      new URL(`${sendPath}?apiversion=1`, vpn),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          phone_number: phone,
          phone_index: String(phoneIndex),
        }),
      },
      "vpn_sms_send",
    );
    if (sent.errorCode !== 1) throw smsSendError(sent);
    transaction.smsPhone = phone;
    transaction.maskedPhone = maskedPhone(
      phone || transaction.phones[phoneIndex] || "",
    );
    return smsRequired(transactionId, transaction);
  }

  async function handleAuthResult(result, jar, principalKey, credentials) {
    if (successAuth(result)) {
      const { transactionId, transaction } = createTransaction(
        jar,
        principalKey,
        credentials,
        { authenticated: true },
      );
      return continueImport(transactionId, transaction);
    }
    if (result.nextService && smsService(result.nextService)) {
      const config = await requestSmsConfig(jar);
      const phones = phoneChoices(config.phone || result.phone);
      cleanup();
      const { transactionId, transaction } = createTransaction(
        jar,
        principalKey,
        credentials,
        {
          phones,
          destination:
            phones.length === 0 ? "enter" : phones.length > 1 ? "choose" : "bound",
          smsPhone: null,
          maskedPhone: phones.length === 1 ? maskedPhone(phones[0]) : "",
        },
      );
      if (phones.length !== 1) {
        return smsDestinationRequired(transactionId, transaction);
      }
      if (result.smsIsStillValid || config.smsIsStillValid) {
        transaction.smsPhone = "";
        return smsRequired(transactionId, transaction);
      }
      try {
        return await dispatchSms(transactionId, transaction, "", 0);
      } catch (error) {
        destroyTransaction(transactionId);
        throw error;
      }
    }
    if (result.errorCode === 20004) {
      throw academicError("ACADEMIC_INVALID_CREDENTIALS");
    }
    if (result.nextService) {
      throw academicError("ACADEMIC_ADDITIONAL_AUTH_REQUIRED");
    }
    throw academicError("ACADEMIC_LOGIN_FAILED");
  }

  return {
    async start({ username, password, principalKey }) {
      cleanup();
      const credentials = validateCredentials(username, password);
      if (typeof principalKey !== "string" || !principalKey) {
        throw academicError("ACADEMIC_PRINCIPAL_REQUIRED");
      }
      const jar = new CookieJar();
      const initial = await readAuthResponse(
        jar,
        new URL("/por/login_auth.csp?apiversion=1", vpn),
        {},
        "vpn_init",
      );
      if (
        !initial.csrfRandCode ||
        !initial.rsaKey ||
        initial.errorCode !== VPN_AUTH_SUCCESS
      ) {
        throw stagedError("ACADEMIC_PROTOCOL_CHANGED", "vpn_init");
      }
      let challenge = initial;
      try {
        const passwordConfig = await readAuthResponse(
          jar,
          new URL("/public/psw_config?apiversion=1", vpn),
          {},
          "vpn_password_config",
        );
        if (passwordConfig.csrfRandCode && passwordConfig.rsaKey) {
          challenge = passwordConfig;
        }
      } catch (error) {
        if (error?.code !== "ACADEMIC_UPSTREAM_UNAVAILABLE") throw error;
      }
      const encrypted = encryptPassword(
        credentials.password,
        challenge.csrfRandCode,
        challenge.rsaKey,
        challenge.rsaExponent,
      );
      const result = await readAuthResponse(
        jar,
        new URL(
          "/por/login_psw.csp?anti_replay=1&encrypt=1&apiversion=1",
          vpn,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            mitm_result: "",
            svpn_req_randcode: challenge.csrfRandCode,
            svpn_name: credentials.username,
            svpn_password: encrypted,
            svpn_rand_code: "",
          }),
        },
        "vpn_password",
      );
      return handleAuthResult(result, jar, principalKey, credentials);
    },

    async sendSms({ transactionId, phone, phoneIndex, principalKey }) {
      cleanup();
      if (
        typeof transactionId !== "string" ||
        !/^[A-Za-z0-9_-]{32,64}$/u.test(transactionId)
      ) {
        throw academicError("ACADEMIC_SMS_DESTINATION_INVALID");
      }
      const transaction = transactions.get(transactionId);
      if (!transaction || transaction.principalKey !== principalKey) {
        throw academicError("ACADEMIC_TRANSACTION_EXPIRED");
      }
      if (transaction.smsPhone !== null) {
        return smsRequired(transactionId, transaction);
      }
      if (transaction.destination === "enter") {
        const normalizedPhone = String(phone ?? "").trim();
        if (!validSmsPhone(normalizedPhone) || normalizedPhone.includes("*")) {
          throw academicError("ACADEMIC_SMS_DESTINATION_INVALID");
        }
        return dispatchSms(transactionId, transaction, normalizedPhone, 0);
      }
      if (transaction.destination === "choose") {
        const normalizedIndex = String(phoneIndex ?? "");
        if (!/^\d+$/u.test(normalizedIndex)) {
          throw academicError("ACADEMIC_SMS_DESTINATION_INVALID");
        }
        const index = Number.parseInt(normalizedIndex, 10);
        const selectedPhone = transaction.phones[index];
        if (!selectedPhone) {
          throw academicError("ACADEMIC_SMS_DESTINATION_INVALID");
        }
        return dispatchSms(transactionId, transaction, selectedPhone, index);
      }
      throw academicError("ACADEMIC_SMS_DESTINATION_INVALID");
    },

    async verifySms({ transactionId, code, principalKey }) {
      cleanup();
      if (
        typeof transactionId !== "string" ||
        !/^[A-Za-z0-9_-]{32,64}$/u.test(transactionId)
      ) {
        throw academicError("ACADEMIC_SMS_INVALID");
      }
      const transaction = transactions.get(transactionId);
      if (!transaction || transaction.principalKey !== principalKey) {
        throw academicError("ACADEMIC_TRANSACTION_EXPIRED");
      }
      if (!transaction.authenticated) {
        if (typeof code !== "string" || !/^\d{4,8}$/u.test(code)) {
          throw academicError("ACADEMIC_SMS_INVALID");
        }
        if (transaction.smsPhone === null) {
          throw academicError("ACADEMIC_SMS_NOT_SENT");
        }
        const path = transaction.smsPhone
          ? "/por/login_sms2.csp?apiversion=1"
          : "/por/login_sms1.csp?apiversion=1";
        const result = await readAuthResponse(
          transaction.jar,
          new URL(path, vpn),
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ svpn_inputsms: code }),
          },
          "vpn_sms_verify",
        );
        if (!successAuth(result)) {
          if (result.nextService) {
            throw stagedError(
              "ACADEMIC_ADDITIONAL_AUTH_REQUIRED",
              "vpn_sms_verify",
            );
          }
          throw stagedError("ACADEMIC_SMS_INVALID", "vpn_sms_verify");
        }
        transaction.authenticated = true;
        transaction.expiresAt = now() + transactionTtlMs;
      }
      return continueImport(transactionId, transaction);
    },

    async verifySso({ transactionId, verifyCode, principalKey }) {
      cleanup();
      if (
        typeof transactionId !== "string" ||
        !/^[A-Za-z0-9_-]{32,64}$/u.test(transactionId)
      ) {
        throw academicError("ACADEMIC_SSO_VERIFICATION_INVALID");
      }
      const transaction = transactions.get(transactionId);
      if (!transaction || transaction.principalKey !== principalKey) {
        throw academicError("ACADEMIC_TRANSACTION_EXPIRED");
      }
      if (!transaction.authenticated || !transaction.sso) {
        throw academicError("ACADEMIC_SSO_VERIFICATION_INVALID");
      }
      const normalizedCode = String(verifyCode ?? "").trim();
      if (!/^\d{1,3}$/u.test(normalizedCode)) {
        throw academicError("ACADEMIC_SSO_VERIFICATION_INVALID");
      }
      const code = Number.parseInt(normalizedCode, 10);
      if (code < 0 || code > SSO_CHALLENGE_MAX_OFFSET) {
        throw academicError("ACADEMIC_SSO_VERIFICATION_INVALID");
      }
      const sso = transaction.sso;
      const loginResult = await atStage("sso_verify", () =>
        request(transaction.jar, sso.action, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: sso.action.origin,
            Referer: sso.loginUrl.href,
          },
          body: new URLSearchParams({
            fingerprint: transaction.fingerprint,
            username: transaction.username,
            password: encryptSsoPassword(
              transaction.password,
              sso.encryptionSeed,
            ),
            verify_token: sso.sliderToken,
            verify_code: normalizedCode,
            __token__: sso.csrfToken,
          }),
        }),
      );
      if (!loginResult.response.ok) {
        throw stagedError("ACADEMIC_UPSTREAM_UNAVAILABLE", "sso_verify");
      }
      const loginHtml = await atStage("sso_verify", () =>
        readLimitedText(loginResult.response),
      );
      if (findSsoLogin(loginHtml, loginResult.finalUrl)) {
        if (/用户名或密码(?:错误|不正确)|账号或密码(?:错误|不正确)/u.test(stripHtml(loginHtml))) {
          destroyTransaction(transactionId);
          throw academicError("ACADEMIC_INVALID_CREDENTIALS");
        }
        return prepareSsoChallenge(
          transactionId,
          transaction,
          loginResult.finalUrl,
          loginHtml,
          true,
        );
      }
      transaction.sso = null;
      transaction.expiresAt = now() + transactionTtlMs;
      return continueImport(transactionId, transaction);
    },

    pendingCount() {
      cleanup();
      return transactions.size;
    },
  };
}
