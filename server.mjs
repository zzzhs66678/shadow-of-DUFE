import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
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
]);

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
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(asset.candidate).pipe(res);
  return true;
}

function proxyToVinext(req, res) {
  const upstream = createProxyRequest(
    {
      host: "127.0.0.1",
      port: internalPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 502;
      if (upstreamResponse.statusMessage) {
        res.writeHead(
          statusCode,
          upstreamResponse.statusMessage,
          upstreamResponse.headers,
        );
      } else {
        res.writeHead(statusCode, upstreamResponse.headers);
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
  if (await servePublicAsset(req, res, pathname)) return;
  proxyToVinext(req, res);
});

server.listen(port, host, () => {
  console.log(`[dufesh] Production gateway running at http://${host}:${port}`);
});
