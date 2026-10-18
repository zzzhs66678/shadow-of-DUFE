import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer, request as createProxyRequest } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startProdServer } from "./node_modules/vinext/dist/server/prod-server.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOSTNAME ?? "0.0.0.0";
const internalPort = Number.parseInt(
  process.env.VINEXT_INTERNAL_PORT ?? String(port + 1),
  10,
);
const outDir = fileURLToPath(new URL("./dist", import.meta.url));
const clientDir = resolve(outDir, "client");
const publicDirectories = [
  "/assets/",
  "/data/",
  "/images/",
  "/.well-known/",
];
const publicFiles = new Set([
  "/favicon.svg",
  "/file.svg",
  "/globe.svg",
  "/window.svg",
]);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
  [".zip", "application/zip"],
]);

async function serveBaiguoSession(req, res) {
  const reply = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
    res.end(JSON.stringify(value));
  };
  req.resume();
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (req.headers.origin !== (process.env.DUFESH_PUBLIC_ORIGIN || "https://dufesh.cn") || req.headers["content-type"]?.split(";")[0] !== "application/json") return reply(403, { error: "same_origin_required" });
  if (!req.headers.cookie) return reply(401, { error: "authentication_required" });
  try {
    const sessionURL = new URL("/api/admin/session", process.env.DUFESH_ADMIN_SESSION_ORIGIN || "https://dufesh.cn");
    const verify = async () => {
      const response = await fetch(sessionURL, { headers: { Cookie: req.headers.cookie }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
      if ([401, 403].includes(response.status)) return { status: response.status };
      if (!response.ok) return { status: 503 };
      const session = await response.json();
      const until = Date.parse(session.elevatedUntil || "");
      return session.role === "admin" && session.elevated === true && until > Date.now() ? { status: 200, until } : { status: 403 };
    };
    const access = await verify();
    if (access.status !== 200) return reply(access.status, { error: "admin_verification_required" });
    const password = process.env.BAIGUO_MANAGEMENT_KEY;
    if (!password || password.length < 12 || password.length > 256) return reply(503, { error: "connection_unavailable" });
    const expiresAt = Math.min(access.until, Date.now() + 30000) / 1000;
    if (expiresAt * 1000 - Date.now() < 1000) return reply(403, { error: "admin_verification_required" });
    const childOrigin = process.env.BAIGUO_DASHBOARD_ORIGIN || "https://baiguo.dufesh.cn";
    const response = await fetch(new URL("/api/handoff", childOrigin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/json", Origin: childOrigin }, body: JSON.stringify({ password, expires_at: expiresAt }) });
    if (!response.ok) return reply(503, { error: "connection_unavailable" });
    const { ticket } = await response.json();
    const current = await verify();
    if (current.status !== 200 || current.until < access.until) return reply(current.status === 200 ? 403 : current.status, { error: "admin_verification_required" });
    if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error("invalid_handoff");
    reply(200, { ticket });
  } catch {
    reply(503, { error: "connection_unavailable" });
  }
}

function documentContentSecurityPolicy(nonce, pathname) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "media-src 'self'",
    "connect-src 'self'",
    pathname === "/admin" || pathname === "/admin/"
      ? "frame-src 'self' https://baiguo.dufesh.cn"
      : "frame-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function resolvePublicAsset(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    decoded.includes("\0") ||
    (!publicFiles.has(decoded) &&
      !publicDirectories.some((prefix) => decoded.startsWith(prefix)))
  ) {
    return null;
  }
  const candidate = resolve(clientDir, `.${decoded}`);
  if (!candidate.startsWith(`${clientDir}${sep}`)) return null;
  return { candidate, decoded };
}

async function servePublicAsset(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const asset = resolvePublicAsset(pathname);
  if (!asset) return false;

  let details;
  try {
    details = await stat(asset.candidate);
  } catch {
    return false;
  }
  if (!details.isFile()) return false;

  const contentType = contentTypes.get(extname(asset.candidate).toLowerCase());
  const cacheControl = asset.decoded.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : asset.decoded.startsWith("/images/")
      ? "public, max-age=604800, immutable"
      : "public, max-age=3600, stale-while-revalidate=86400";
  res.writeHead(200, {
    "Cache-Control": cacheControl,
    "Content-Length": String(details.size),
    ...(contentType ? { "Content-Type": contentType } : {}),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(asset.candidate).pipe(res);
  return true;
}

function proxyToVinext(req, res) {
  const nonce = randomBytes(18).toString("base64url");
  const contentSecurityPolicy = documentContentSecurityPolicy(nonce, new URL(req.url, "http://localhost").pathname);
  const upstream = createProxyRequest(
    {
      host: "127.0.0.1",
      port: internalPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        "content-security-policy": contentSecurityPolicy,
      },
    },
    (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 502;
      const responseHeaders = {
        ...upstreamResponse.headers,
        "content-security-policy": contentSecurityPolicy,
      };
      if (upstreamResponse.statusMessage) {
        res.writeHead(
          statusCode,
          upstreamResponse.statusMessage,
          responseHeaders,
        );
      } else {
        res.writeHead(statusCode, responseHeaders);
      }
      upstreamResponse.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("Upstream unavailable");
  });
  req.pipe(upstream);
}

if (internalPort === port) {
  throw new Error("VINEXT_INTERNAL_PORT must differ from PORT");
}

await startProdServer({
  port: internalPort,
  host: "127.0.0.1",
  outDir,
});

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/admin/baiguo-session") return serveBaiguoSession(req, res);
  if (await servePublicAsset(req, res, pathname)) return;
  proxyToVinext(req, res);
});

server.listen(port, host, () => {
  console.log(`[dufesh] Production gateway running at http://${host}:${port}`);
});
