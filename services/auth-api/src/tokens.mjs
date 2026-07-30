import { createHmac, randomBytes } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function isOpaqueToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function tokenDigest(token, pepper) {
  return createHmac("sha256", pepper).update(token).digest("hex");
}
