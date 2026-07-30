import { randomBytes } from "node:crypto";
import pg from "pg";
import { tokenDigest } from "../src/tokens.mjs";

const { Pool } = pg;
const baseUrl = `http://127.0.0.1:${process.env.AUTH_API_PORT || 3100}`;
const sessionCookieName =
  process.env.AUTH_SESSION_COOKIE || "__Host-dufesh_session";
const pepper = process.env.AUTH_TOKEN_PEPPER;

if (!pepper) throw new Error("AUTH_TOKEN_PEPPER is required");

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 1,
});

function cookiePair(setCookie) {
  return setCookie.split(";", 1)[0];
}

let testUserId;

try {
  const anonymousResponse = await fetch(`${baseUrl}/api/auth/session`);
  if (!anonymousResponse.ok) throw new Error("anonymous session failed");
  const anonymous = await anonymousResponse.json();
  const deviceCookie = anonymousResponse.headers
    .getSetCookie()
    .map(cookiePair)
    .find((value) => value.startsWith("__Host-dufesh_device="));

  if (anonymous.authenticated || !anonymous.deviceId || !deviceCookie) {
    throw new Error("anonymous device contract failed");
  }

  const repeatResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: deviceCookie },
  });
  const repeat = await repeatResponse.json();
  if (repeat.deviceId !== anonymous.deviceId) {
    throw new Error("anonymous device was not stable");
  }

  const userResult = await pool.query(
    `INSERT INTO app_users (display_name)
     VALUES ('阶段二验收账号')
     RETURNING id`,
  );
  testUserId = userResult.rows[0].id;

  const rawSessionToken = randomBytes(32).toString("base64url");
  const sessionHash = tokenDigest(rawSessionToken, pepper);
  await pool.query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 day')`,
    [testUserId, sessionHash],
  );

  const authenticatedResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: {
      Cookie: `${deviceCookie}; ${sessionCookieName}=${rawSessionToken}`,
    },
  });
  const authenticated = await authenticatedResponse.json();
  if (!authenticated.authenticated || authenticated.user?.id !== testUserId) {
    throw new Error("authenticated session contract failed");
  }

  const rejectedLogout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Origin: "https://attacker.invalid" },
  });
  if (rejectedLogout.status !== 403) {
    throw new Error("cross-origin logout was not rejected");
  }

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      Origin: "https://dufesh.cn",
      Cookie: `${deviceCookie}; ${sessionCookieName}=${rawSessionToken}`,
    },
  });
  if (!logoutResponse.ok) throw new Error("logout failed");

  const afterLogoutResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: {
      Cookie: `${deviceCookie}; ${sessionCookieName}=${rawSessionToken}`,
    },
  });
  const afterLogout = await afterLogoutResponse.json();
  if (afterLogout.authenticated) {
    throw new Error("revoked session remained authenticated");
  }

  console.log(
    JSON.stringify({
      ok: true,
      anonymousDeviceStable: true,
      authenticatedSession: true,
      crossOriginRejected: true,
      logoutRevoked: true,
    }),
  );
} finally {
  if (testUserId) {
    await pool.query("DELETE FROM app_users WHERE id = $1", [testUserId]);
  }
  await pool.end();
}
