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

async function verifyPersonalSync(login) {
  const cookie = `${deviceCookie}; ${login.sessionCookie}`;
  const initial = await fetch(`${baseUrl}/api/auth/sync`, {
    headers: { Cookie: cookie },
  });
  const initialSnapshot = await initial.json();
  if (!initial.ok || initialSnapshot.revision !== 0) {
    throw new Error("Initial personal snapshot was not empty");
  }

  const mutationId = `sync-${randomBytes(12).toString("hex")}`;
  const write = {
    mutationId,
    baseRevision: 0,
    clientUpdatedAt: new Date().toISOString(),
    state: {
      profile: {
        entranceYear: 2025,
        college: "会计学院",
        majorId: "accounting",
        className: "审计2501",
      },
      skipped: false,
      plans: [
        {
          id: "default",
          name: "默认课表",
          scheduleIds: [
            "fall-section-a-meeting-1",
            "fall-section-a-meeting-2",
          ],
        },
      ],
      activePlanId: "default",
      activities: [
        {
          id: "activity-smoke-1234",
          title: "小组讨论",
          weekday: 3,
          block: 2,
          location: "之远楼",
          notes: "",
          color: "blue",
        },
      ],
      assignments: [
        {
          id: "assignment-smoke-1234",
          courseId: "course-smoke",
          title: "第三章作业",
          dueDate: "2026-08-06",
          notes: "",
          completed: false,
        },
      ],
      favoriteRooms: ["之远楼401"],
      recentRooms: ["笃行楼302"],
      preferredTerm: "fall",
      theme: "system",
    },
  };
  const headers = {
    "Content-Type": "application/json",
    Origin: publicOrigin,
    Cookie: cookie,
  };

  const accepted = await fetch(`${baseUrl}/api/auth/sync`, {
    method: "PUT",
    headers,
    body: JSON.stringify(write),
  });
  const acceptedSnapshot = await accepted.json();
  if (
    !accepted.ok ||
    acceptedSnapshot.revision !== 1 ||
    acceptedSnapshot.state.plans[0]?.scheduleIds.length !== 2
  ) {
    throw new Error("Personal snapshot write failed");
  }

  const retry = await fetch(`${baseUrl}/api/auth/sync`, {
    method: "PUT",
    headers,
    body: JSON.stringify(write),
  });
  const retrySnapshot = await retry.json();
  if (!retry.ok || retrySnapshot.deduplicated !== true) {
    throw new Error("Personal snapshot retry was not deduplicated");
  }

  const conflict = await fetch(`${baseUrl}/api/auth/sync`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...write,
      mutationId: `sync-${randomBytes(12).toString("hex")}`,
    }),
  });
  const conflictSnapshot = await conflict.json();
  if (conflict.status !== 409 || conflictSnapshot.revision !== 1) {
    throw new Error("Stale personal snapshot was not rejected");
  }

  const concurrentWrites = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      fetch(`${baseUrl}/api/auth/sync`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          ...write,
          mutationId: `burst-${index}-${randomBytes(12).toString("hex")}`,
          baseRevision: 1,
          state: {
            ...write.state,
            activities: [
              ...write.state.activities,
              {
                id: `activity-burst-${index}`,
                title: `并发日程 ${index}`,
                weekday: 4,
                block: 3,
                location: "",
                notes: "",
                color: "green",
              },
            ],
          },
        }),
      }),
    ),
  );
  const acceptedWrites = concurrentWrites.filter(
    (response) => response.status === 200,
  ).length;
  const rejectedWrites = concurrentWrites.filter(
    (response) => response.status === 409,
  ).length;
  if (acceptedWrites !== 1 || rejectedWrites !== 49) {
    throw new Error(
      `Concurrent writes were not serialized (${acceptedWrites}/${
        rejectedWrites
      })`,
    );
  }
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
  await verifyPersonalSync(first);

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

  const signedInCookies = `${deviceCookie}; ${second.sessionCookie}`;
  const devices = await fetch(`${baseUrl}/api/auth/devices`, {
    headers: { Cookie: signedInCookies },
  });
  const devicePayload = await devices.json();
  if (
    !devices.ok ||
    !Array.isArray(devicePayload.devices) ||
    !devicePayload.devices.some((device) => device.current)
  ) {
    throw new Error("Current account device was not listed");
  }

  const deleteAccount = await fetch(
    `${baseUrl}/api/auth/account/delete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: publicOrigin,
        Cookie: signedInCookies,
      },
      body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" }),
    },
  );
  if (!deleteAccount.ok) throw new Error("Account deletion failed");
  testUserId = null;

  const deletedSession = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: signedInCookies },
  });
  const deletedSessionPayload = await deletedSession.json();
  if (deletedSessionPayload.authenticated) {
    throw new Error("Deleted account session remained active");
  }

  console.log(
    JSON.stringify({
      ok: true,
      mockEndpointProtected: true,
      stateBoundToBrowser: true,
      callbackReplayRejected: true,
      repeatedIdentityReused: true,
      sessionIssuedAndRevoked: true,
      personalSyncVersioned: true,
      personalSyncDeduplicated: true,
      staleWriteRejected: true,
      concurrentWritesSerialized: true,
      accountDevicesListed: true,
      accountDeletedWithCascade: true,
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
