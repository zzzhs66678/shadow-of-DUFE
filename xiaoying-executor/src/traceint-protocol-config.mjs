import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { TRACEINT_PROTOCOL } from "./traceint-protocol.mjs";

const SCHEMA_VERSION = 1;
const MAX_HISTORY = 20;
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const APP_VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function requiredUrl(value, field, { protocols, hostname, pathPrefix = "/" }) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new Error(`${field} 不是有效地址`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${field} 协议不受支持`);
  }
  if (url.hostname.toLowerCase() !== hostname) {
    throw new Error(`${field} 只能使用 ${hostname}`);
  }
  if (!url.pathname.startsWith(pathPrefix)) {
    throw new Error(`${field} 路径不受支持`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

function profile(value, fallback, field) {
  const source = value && typeof value === "object" ? value : {};
  const appVersion = String(source.appVersion ?? fallback.appVersion).trim();
  if (!APP_VERSION_PATTERN.test(appVersion)) {
    throw new Error(`${field}.appVersion 格式无效`);
  }
  const origin = requiredUrl(source.origin ?? fallback.origin, `${field}.origin`, {
    protocols: ["https:"],
    hostname: "web.traceint.com",
  }).replace(/\/$/, "");
  const referer = requiredUrl(
    source.referer ?? fallback.referer,
    `${field}.referer`,
    {
      protocols: ["https:"],
      hostname: "web.traceint.com",
    },
  );
  return Object.freeze({ origin, referer, appVersion });
}

export function validateTraceIntProtocol(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("协议配置必须是对象");
  }
  const allowedKeys = new Set([
    "cookieEndpoint",
    "authorizationReturnUrl",
    "graphQlEndpoint",
    "defaultProfile",
    "tomorrowProfile",
  ]);
  const unknown = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`不支持的协议字段：${unknown}`);

  return Object.freeze({
    cookieEndpoint: requiredUrl(
      input.cookieEndpoint ?? TRACEINT_PROTOCOL.cookieEndpoint,
      "cookieEndpoint",
      {
        protocols: ["https:"],
        hostname: "wechat.v2.traceint.com",
        pathPrefix: "/index.php/urlNew/",
      },
    ),
    authorizationReturnUrl: requiredUrl(
      input.authorizationReturnUrl ?? TRACEINT_PROTOCOL.authorizationReturnUrl,
      "authorizationReturnUrl",
      {
        protocols: ["https:"],
        hostname: "web.traceint.com",
        pathPrefix: "/web/",
      },
    ),
    graphQlEndpoint: requiredUrl(
      input.graphQlEndpoint ?? TRACEINT_PROTOCOL.graphQlEndpoint,
      "graphQlEndpoint",
      {
        protocols: ["https:"],
        hostname: "wechat.v2.traceint.com",
        pathPrefix: "/index.php/graphql/",
      },
    ),
    defaultProfile: profile(
      input.defaultProfile,
      TRACEINT_PROTOCOL.defaultProfile,
      "defaultProfile",
    ),
    tomorrowProfile: profile(
      input.tomorrowProfile,
      TRACEINT_PROTOCOL.tomorrowProfile,
      "tomorrowProfile",
    ),
  });
}

function normalizeVersion(value) {
  const version = String(value ?? "").trim();
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("协议版本只能包含字母、数字、点、横线和下划线");
  }
  return version;
}

function bundledState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeVersion: "bundled-2026-07-29",
    source: "bundled",
    updatedAt: null,
    protocol: validateTraceIntProtocol(),
    history: [],
  };
}

export async function loadTraceIntProtocolConfig(configPath) {
  if (!configPath) return bundledState();
  let document;
  try {
    document = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return bundledState();
    throw new Error(`无法读取协议配置：${error.message}`);
  }
  if (document?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("协议配置版本不受支持");
  }
  const activeVersion = normalizeVersion(document.activeVersion);
  const versions = Array.isArray(document.versions) ? document.versions : [];
  const active = versions.find((item) => item?.version === activeVersion);
  if (!active) throw new Error("协议配置中没有当前版本");
  return {
    schemaVersion: SCHEMA_VERSION,
    activeVersion,
    source: "file",
    updatedAt: active.updatedAt ?? null,
    protocol: validateTraceIntProtocol(active.protocol),
    history: versions.map((item) => ({
      version: normalizeVersion(item.version),
      updatedAt: item.updatedAt ?? null,
    })),
  };
}

async function readDocument(configPath) {
  try {
    const document = JSON.parse(await readFile(configPath, "utf8"));
    if (document?.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("协议配置版本不受支持");
    }
    return document;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { schemaVersion: SCHEMA_VERSION, activeVersion: null, versions: [] };
  }
}

async function writeDocument(configPath, document) {
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, configPath);
}

export async function applyTraceIntProtocolConfig(
  configPath,
  { version, protocol },
  clock = () => new Date(),
) {
  const normalizedVersion = normalizeVersion(version);
  const validated = validateTraceIntProtocol(protocol);
  const document = await readDocument(configPath);
  const updatedAt = clock().toISOString();
  const versions = [
    {
      version: normalizedVersion,
      updatedAt,
      protocol: validated,
    },
    ...(Array.isArray(document.versions) ? document.versions : []).filter(
      (item) => item?.version !== normalizedVersion,
    ),
  ].slice(0, MAX_HISTORY);
  await writeDocument(configPath, {
    schemaVersion: SCHEMA_VERSION,
    activeVersion: normalizedVersion,
    versions,
  });
  return loadTraceIntProtocolConfig(configPath);
}

export async function rollbackTraceIntProtocolConfig(configPath, version) {
  const normalizedVersion = normalizeVersion(version);
  const document = await readDocument(configPath);
  const versions = Array.isArray(document.versions) ? document.versions : [];
  if (!versions.some((item) => item?.version === normalizedVersion)) {
    throw new Error(`没有找到协议版本 ${normalizedVersion}`);
  }
  await writeDocument(configPath, {
    ...document,
    activeVersion: normalizedVersion,
  });
  return loadTraceIntProtocolConfig(configPath);
}
