import { randomBytes } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const baseUrl = `http://127.0.0.1:${process.env.AUTH_API_PORT || 3100}`;
const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN || "https://dufesh.cn";
const mockSecret = process.env.AUTH_MOCK_LOGIN_SECRET;
const mockSubject =
  `stage3-${randomBytes(8).toString("hex")}`;

if (!mockSecret) throw new Error("AUTH_MOCK_LOGIN_SECRET is required");

const cookieNames = {
  device: process.env.AUTH_DEVICE_COOKIE || "__Host-dufesh_device",
  oauth: process.env.AUTH_OAUTH_COOKIE || "__Host-dufesh_oauth",
  session: process.env.AUTH_SESSION_COOKIE || "__Host-dufesh_session",
};

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 1,
});

function cookiePair(value) {
  return value.split(";", 1)[0];
}

function findCookie(response, name) {
  const value = response.headers
    .getSetCookie()
    .find((item) => item.startsWith(`${name}=`));
  return value ? cookiePair(value) : null;
}

function localPath(location) {
  const url = new URL(location);
  return `${url.pathname}${url.search}`;
}

const forwardedHeaders = {
  "X-Forwarded-Proto": "https",
  "X-Forwarded-Host": new URL(publicOrigin).host,
  "X-Dufesh-Mock-Secret": mockSecret,
};

let deviceCookie;
let anonymousDeviceId;
let testUserId;

async function beginLogin() {
  const headers = { ...forwardedHeaders };
  if (deviceCookie) headers.Cookie = deviceCookie;

  const start = await fetch(
    `${baseUrl}/api/auth/wechat/start?returnTo=%2Fmy%3Ftab%3Dsync`,
    { headers, redirect: "manual" },
  );
  if (start.status !== 302) throw new Error("OAuth start failed");

  deviceCookie ||= findCookie(start, cookieNames.device);
  const oauthCookie = findCookie(start, cookieNames.oauth);
  if (!deviceCookie || !oauthCookie) {
    throw new Error("OAuth browser cookies were not issued");
  }

  const authorize = await fetch(
    `${baseUrl}${localPath(start.headers.get("location"))}`,
    {
      headers: {
        "X-Dufesh-Mock-Secret": mockSecret,
        "X-Dufesh-Mock-Subject": mockSubject,
      },
      redirect: "manual",
    },
  );
  if (authorize.status !== 302) {
    throw new Error("Mock authorization failed");
  }

  return {
    oauthCookie,
    callbackPath: localPath(authorize.headers.get("location")),
  };
}

async function completeLogin() {
  const { oauthCookie, callbackPath } = await beginLogin();

  const missingBrowserCookie = await fetch(`${baseUrl}${callbackPath}`, {
    headers: { Cookie: deviceCookie },
    redirect: "manual",
  });
  if (missingBrowserCookie.status !== 400) {
    throw new Error("OAuth browser binding was not enforced");
  }

  const callback = await fetch(`${baseUrl}${callbackPath}`, {
    headers: { Cookie: `${deviceCookie}; ${oauthCookie}` },
    redirect: "manual",
  });
  if (
    callback.status !== 302 ||
    callback.headers.get("location") !== `${publicOrigin}/my?tab=sync`
  ) {
    throw new Error("OAuth callback failed");
  }

  const sessionCookie = findCookie(callback, cookieNames.session);
  if (!sessionCookie) throw new Error("Session cookie was not issued");

  const session = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: `${deviceCookie}; ${sessionCookie}` },
  });
  const sessionPayload = await session.json();
  if (!sessionPayload.authenticated || !sessionPayload.user?.id) {
    throw new Error("OAuth session was not authenticated");
  }

  const replay = await fetch(`${baseUrl}${callbackPath}`, {
    headers: { Cookie: `${deviceCookie}; ${oauthCookie}` },
    redirect: "manual",
  });
  if (replay.status !== 400) {
    throw new Error("OAuth callback replay was not rejected");
  }

  return {
    userId: sessionPayload.user.id,
    deviceId: sessionPayload.deviceId,
    sessionCookie,
  };
}

try {
  const forbidden = await fetch(`${baseUrl}/api/auth/wechat/start`, {
    headers: {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": new URL(publicOrigin).host,
    },
    redirect: "manual",
  });
  if (forbidden.status !== 403) {
    throw new Error("Mock authorization was exposed without its secret");
  }

  const first = await completeLogin();
  testUserId = first.userId;
  anonymousDeviceId = first.deviceId;

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      Origin: publicOrigin,
      Cookie: `${deviceCookie}; ${first.sessionCookie}`,
    },
  });
  if (!logout.ok) throw new Error("OAuth session logout failed");

  const second = await completeLogin();
  if (second.userId !== first.userId) {
    throw new Error("Repeated OAuth login created a duplicate user");
  }

  console.log(
    JSON.stringify({
      ok: true,
      mockEndpointProtected: true,
      stateBoundToBrowser: true,
      callbackReplayRejected: true,
      repeatedIdentityReused: true,
      sessionIssuedAndRevoked: true,
    }),
  );
} finally {
  if (testUserId) {
    await pool.query("DELETE FROM app_users WHERE id = $1", [testUserId]);
  }
  if (anonymousDeviceId) {
    await pool.query(
      `DELETE FROM anonymous_devices
       WHERE public_id = $1
         AND claimed_device_id IS NULL`,
      [anonymousDeviceId],
    );
  }
  await pool.end();
}
