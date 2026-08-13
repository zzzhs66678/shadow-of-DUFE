export function parseCookies(header = "") {
  const cookies = new Map();

  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;

    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }

  return cookies;
}

export function serializeSecureCookie(
  name,
  value,
  maxAgeSeconds,
  { sameSite = "Lax" } = {},
) {
  if (!new Set(["Lax", "Strict", "None"]).has(sameSite)) {
    throw new Error("SameSite must be Lax, Strict, or None");
  }
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
    "HttpOnly",
    "Secure",
    `SameSite=${sameSite}`,
  ].join("; ");
}

export function clearSecureCookie(name, options) {
  return serializeSecureCookie(name, "", 0, options);
}
