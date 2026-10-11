// Kept in this service because its Docker image is built independently.
import ipaddr from "ipaddr.js";

export function parseTrustedProxies(value = "") {
  return String(value).split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const range = ipaddr.parseCIDR(part);
    if (range[1] === 0) throw new Error("Trusting every proxy is forbidden");
    return range;
  });
}

function address(value) {
  try { return ipaddr.process(value); } catch { return null; }
}

export function trustedProxy(request, config) {
  const peer = address(request.socket.remoteAddress);
  return Boolean(peer && (config.trustedProxyRanges ?? []).some(([network, bits]) =>
    peer.kind() === network.kind() && peer.match(network, bits)));
}

export function clientAddress(request, config = {}) {
  const peer = address(request.socket.remoteAddress);
  if (trustedProxy(request, config)) {
    // Caddy replaces the header with its observed client. Never take the leftmost
    // caller-provided value, and walk only explicitly trusted proxy hops.
    const chain = String(request.headers["x-forwarded-for"] ?? "").split(",").map((v) => v.trim());
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const candidate = address(chain[index]);
      if (!candidate) return peer?.toString() ?? "unknown";
      if (!(config.trustedProxyRanges ?? []).some(([network, bits]) =>
        candidate.kind() === network.kind() && candidate.match(network, bits))) return candidate.toString();
    }
  }
  return peer?.toString() ?? "unknown";
}

export function forwardedOrigin(request, config = {}) {
  const secure = request.socket.encrypted || (trustedProxy(request, config) && request.headers["x-forwarded-proto"] === "https");
  const host = trustedProxy(request, config)
    ? request.headers["x-forwarded-host"] || request.headers.host
    : request.headers.host;
  return host ? `${secure ? "https" : "http"}://${host}` : "";
}

export function secureRequest(request, config) {
  return Boolean(request.socket.encrypted ||
    (trustedProxy(request, config) && request.headers["x-forwarded-proto"] === "https"));
}
