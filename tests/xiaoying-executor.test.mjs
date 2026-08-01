import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeBaiguoSnapshot } from "../xiaoying-executor/src/baiguo-normalizer.mjs";
import {
  BaiguoClient,
  extractBaiguoAuthorization,
  mapBaiguoApiSnapshot,
} from "../xiaoying-executor/src/baiguo-client.mjs";
import { DemoLibraryAdapter } from "../xiaoying-executor/src/demo-library-adapter.mjs";
import { XiaoyingExecutor } from "../xiaoying-executor/src/executor.mjs";
import { XiaoyingLocalStore } from "../xiaoying-executor/src/local-store.mjs";
import { PairingService } from "../xiaoying-executor/src/pairing-service.mjs";
import { SeatWatchRunner } from "../xiaoying-executor/src/seat-watch-runner.mjs";
import { ScheduledReservationRunner } from "../xiaoying-executor/src/scheduled-reservation-runner.mjs";
import { ReservationGuardRunner } from "../xiaoying-executor/src/reservation-guard-runner.mjs";
import { decryptSecret, encryptSecret } from "../xiaoying-executor/src/secret-vault.mjs";
import {
  TraceIntClient,
  extractAuthorizationCode,
} from "../xiaoying-executor/src/traceint-client.mjs";
import {
  applyTraceIntProtocolConfig,
  loadTraceIntProtocolConfig,
  rollbackTraceIntProtocolConfig,
  validateTraceIntProtocol,
} from "../xiaoying-executor/src/traceint-protocol-config.mjs";

const baseTime = Date.parse("2026-07-29T10:00:00.000Z");

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("X1 local console inline script remains valid JavaScript", () => {
  const html = readFileSync(
    new URL("../xiaoying-executor/public/index.html", import.meta.url),
    "utf8",
  );
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
});

test("production HTTP surface isolates cookies, paths, origins, and invite bursts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiaoying-http-"));
  const port = await freePort();
  const inviteCode = "vip-test-code-2026";
  const child = spawn(process.execPath, ["xiaoying-executor/bin/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "production",
      XIAOYING_EXECUTOR_HOST: "127.0.0.1",
      XIAOYING_EXECUTOR_PORT: String(port),
      XIAOYING_PUBLIC_BASE_URL: "https://dufesh.cn/campus-lab",
      XIAOYING_BASE_PATH: "/campus-lab",
      XIAOYING_DEFAULT_INVITE_CODE: inviteCode,
      XIAOYING_MASTER_KEY: Buffer.alloc(32, 19).toString("base64"),
      XIAOYING_DATABASE_PATH: join(directory, "xiaoying.sqlite"),
      XIAOYING_TRACEINT_PROTOCOL_PATH: join(directory, "protocol.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    let health;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        health = await fetch(`http://127.0.0.1:${port}/health`);
        if (health.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    }
    assert.equal(health?.status, 200);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.match(html, /\/campus-lab\/v1\/me/);

    const missingOrigin = await fetch(
      `http://127.0.0.1:${port}/v1/auth/invite`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "同学", inviteCode }),
      },
    );
    assert.equal(missingOrigin.status, 403);

    const valid = await fetch(`http://127.0.0.1:${port}/v1/auth/invite`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://dufesh.cn",
      },
      body: JSON.stringify({ displayName: "同学", inviteCode }),
    });
    assert.equal(valid.status, 201);
    assert.match(
      valid.headers.get("set-cookie") ?? "",
      /__Secure-dufesh_xiaoying_session=.*Path=\/campus-lab.*HttpOnly.*SameSite=Strict.*Secure/,
    );
    const sessionCookie = (valid.headers.get("set-cookie") ?? "").split(";")[0];
    const currentUser = await fetch(`http://127.0.0.1:${port}/v1/me`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(currentUser.status, 200);

    const missingDeleteOrigin = await fetch(
      `http://127.0.0.1:${port}/v1/me`,
      { method: "DELETE", headers: { cookie: sessionCookie } },
    );
    assert.equal(missingDeleteOrigin.status, 403);

    const deleted = await fetch(`http://127.0.0.1:${port}/v1/me`, {
      method: "DELETE",
      headers: { cookie: sessionCookie, origin: "https://dufesh.cn" },
    });
    assert.equal(deleted.status, 200);
    assert.match(deleted.headers.get("set-cookie") ?? "", /Max-Age=0/);
    const removedUser = await fetch(`http://127.0.0.1:${port}/v1/me`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(removedUser.status, 401);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const rejected = await fetch(
        `http://127.0.0.1:${port}/v1/auth/invite`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://dufesh.cn",
          },
          body: JSON.stringify({ displayName: "同学", inviteCode: "wrong" }),
        },
      );
      assert.equal(rejected.status, 400);
    }
    const limited = await fetch(
      `http://127.0.0.1:${port}/v1/auth/invite`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://dufesh.cn",
        },
        body: JSON.stringify({ displayName: "同学", inviteCode: "wrong" }),
      },
    );
    assert.equal(limited.status, 429);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 1_500);
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("TraceInt protocol overrides reject untrusted endpoints", () => {
  assert.throws(
    () =>
      validateTraceIntProtocol({
        graphQlEndpoint: "https://attacker.example/graphql/",
      }),
    /只能使用 wechat\.v2\.traceint\.com/,
  );
  assert.throws(
    () =>
      validateTraceIntProtocol({
        authorizationReturnUrl: "http://web.traceint.com/web/index.html",
      }),
    /协议不受支持/,
  );
});

test("TraceInt protocol configuration is versioned and can roll back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xiaoying-protocol-"));
  const configPath = join(directory, "protocol.json");
  try {
    const bundled = await loadTraceIntProtocolConfig(configPath);
    assert.equal(bundled.source, "bundled");

    await applyTraceIntProtocolConfig(configPath, {
      version: "traceint-2.2.6",
      protocol: {
        defaultProfile: { appVersion: "2.2.6" },
      },
    });
    await applyTraceIntProtocolConfig(configPath, {
      version: "traceint-2.2.7",
      protocol: {
        defaultProfile: { appVersion: "2.2.7" },
      },
    });
    const current = await loadTraceIntProtocolConfig(configPath);
    assert.equal(current.activeVersion, "traceint-2.2.7");
    assert.equal(current.protocol.defaultProfile.appVersion, "2.2.7");

    const rolledBack = await rollbackTraceIntProtocolConfig(
      configPath,
      "traceint-2.2.6",
    );
    assert.equal(rolledBack.activeVersion, "traceint-2.2.6");
    assert.equal(rolledBack.protocol.defaultProfile.appVersion, "2.2.6");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function task(type, payload = {}, overrides = {}) {
  return {
    taskId: `${type}-1`,
    type,
    issuedAt: new Date(baseTime - 1_000).toISOString(),
    expiresAt: new Date(baseTime + 60_000).toISOString(),
    payload,
    ...overrides,
  };
}

test("X0 executor exposes only the narrow read surface", async () => {
  const adapter = new DemoLibraryAdapter();
  const executor = new XiaoyingExecutor({ libraryAdapter: adapter, clock: () => baseTime });

  const status = await executor.execute(task("library.get_status"));
  const favorites = await executor.execute(task("library.list_favorites"));
  const forbidden = await executor.execute(task("library.scan_all_seats"));

  assert.equal(status.status, "succeeded");
  assert.equal(status.data.adapter, "demo");
  assert.equal(favorites.data.seats.length, 2);
  assert.equal(forbidden.status, "failed");
  assert.equal(forbidden.error.code, "TASK_NOT_ALLOWED");
});

test("reservation requires a fresh preview and explicit confirmation", async () => {
  const adapter = new DemoLibraryAdapter();
  const executor = new XiaoyingExecutor({ libraryAdapter: adapter, clock: () => baseTime });
  const preview = await executor.execute(
    task("library.preview_reservation", {
      seatId: "LIB-3F-032",
      date: "2026-07-30",
      reservationKind: "tomorrow",
    }),
  );

  assert.equal(preview.status, "succeeded");
  assert.equal(preview.data.requiresConfirmation, true);

  const unconfirmed = await executor.execute(
    task(
      "library.confirm_reservation",
      { previewDigest: preview.data.previewDigest },
      { idempotencyKey: "reserve-20260730-032" },
    ),
  );
  assert.equal(unconfirmed.status, "failed");
  assert.equal(unconfirmed.error.code, "CONFIRMATION_REQUIRED");
  assert.equal(adapter.executionCounts.reserve, 0);

  const confirmedTask = task(
    "library.confirm_reservation",
    { previewDigest: preview.data.previewDigest },
    {
      taskId: "confirm-reservation-1",
      idempotencyKey: "reserve-20260730-032-confirmed",
      confirmation: {
        confirmed: true,
        confirmedAt: new Date(baseTime).toISOString(),
      },
    },
  );
  const confirmed = await executor.execute(confirmedTask);
  const repeated = await executor.execute(confirmedTask);

  assert.equal(confirmed.status, "succeeded");
  assert.equal(confirmed.data.seatId, "LIB-3F-032");
  assert.deepEqual(repeated, confirmed);
  assert.equal(adapter.executionCounts.reserve, 1);
});

test("expired tasks and credential-bearing payloads never reach the adapter", async () => {
  const adapter = new DemoLibraryAdapter();
  const executor = new XiaoyingExecutor({ libraryAdapter: adapter, clock: () => baseTime });

  const expired = await executor.execute(
    task("library.get_status", {}, { expiresAt: new Date(baseTime - 1).toISOString() }),
  );
  const credential = await executor.execute(
    task("library.check_seat", {
      seatId: "LIB-3F-032",
      date: "2026-07-30",
      cookie: "school-session=must-not-leak",
    }),
  );

  assert.equal(expired.error.code, "TASK_EXPIRED");
  assert.equal(credential.error.code, "CREDENTIAL_MATERIAL_REJECTED");
  assert.equal(JSON.stringify(executor.getAuditLog()).includes("school-session"), false);
});

test("Baiguo normalization keeps only structured records and stable hashes", () => {
  const snapshot = {
    cookie: "ignored-at-source-boundary",
    profile: { studentNumber: "private" },
    courses: [
      {
        externalId: "course-1",
        title: "高等数学",
        sectionExternalId: "section-9",
        teacherPhone: "private",
        accessToken: "ignored",
      },
    ],
    assignments: [
      {
        externalId: "assignment-1",
        courseExternalId: "course-1",
        title: "第三章作业",
        dueAt: "2026-08-01T12:00:00+08:00",
        status: "open",
        authorization: "ignored",
      },
    ],
  };

  const first = normalizeBaiguoSnapshot(snapshot, "2026-07-29T10:00:00.000Z");
  const second = normalizeBaiguoSnapshot(snapshot, "2026-07-29T11:00:00.000Z");
  const serialized = JSON.stringify(first);

  assert.equal(first.courses[0].contentHash, second.courses[0].contentHash);
  assert.equal(first.assignments[0].contentHash, second.assignments[0].contentHash);
  assert.equal(serialized.includes("cookie"), false);
  assert.equal(serialized.includes("accessToken"), false);
  assert.equal(serialized.includes("studentNumber"), false);
  assert.equal(serialized.includes("teacherPhone"), false);
});

test("VIP invite creates an expiring local session without storing the raw code", () => {
  const store = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 7),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });

  assert.throws(
    () => store.unlockVip({ inviteCode: "wrong", displayName: "同学" }),
    /邀请码无效/,
  );
  const unlocked = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "  测试同学  ",
  });
  const authenticated = store.authenticate(unlocked.sessionToken);

  assert.equal(unlocked.user.displayName, "测试同学");
  assert.equal(authenticated.vip, true);
  assert.equal(
    store.db.prepare("SELECT code_hash FROM invite_codes").get().code_hash.includes("fjbadguy"),
    false,
  );

  store.revokeSession(unlocked.sessionToken);
  assert.equal(store.authenticate(unlocked.sessionToken), null);
  store.close();
});

test("per-user model key is encrypted and API summaries never expose plaintext", () => {
  const masterKey = Buffer.alloc(32, 9);
  const store = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey,
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const { user } = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "密钥测试",
  });

  const summary = store.setModelKey(user.id, {
    provider: "openai-compatible",
    model: "test-model",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test-12345678",
  });
  const row = store.db
    .prepare("SELECT ciphertext, iv, tag FROM user_secrets WHERE user_id = ?")
    .get(user.id);

  assert.equal(summary.connected, true);
  assert.equal(summary.last4, "5678");
  assert.equal(JSON.stringify(summary).includes("sk-test"), false);
  assert.equal(JSON.stringify(row).includes("sk-test"), false);
  assert.equal(store.readModelKey(user.id), "sk-test-12345678");
  store.close();
});

test("third-party sessions are encrypted, replaceable, and can require reauthorization", () => {
  const store = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 5),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const { user } = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "连接测试",
  });

  const connected = store.setExternalCredential(
    user.id,
    "traceint",
    "wechatSESS_ID=private; SERVERID=private-node",
  );
  const stored = store.db
    .prepare("SELECT ciphertext FROM user_secrets WHERE user_id = ? AND provider = 'traceint'")
    .get(user.id);

  assert.equal(connected.status, "connected");
  assert.equal(stored.ciphertext.includes("wechatSESS_ID"), false);
  assert.equal(
    store.readExternalCredential(user.id, "traceint"),
    "wechatSESS_ID=private; SERVERID=private-node",
  );

  const expired = store.markExternalConnection(user.id, "traceint", {
    status: "needs_reauthorization",
    errorCode: "SESSION_EXPIRED",
  });
  assert.equal(expired.status, "needs_reauthorization");
  assert.equal(store.readExternalCredential(user.id, "traceint"), null);

  store.disconnectExternal(user.id, "traceint");
  assert.equal(store.getExternalConnection(user.id, "traceint").status, "disconnected");
  store.close();
});

test("VIP favorite seats are user-scoped and deduplicated", () => {
  const store = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 3),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const firstUser = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "收藏用户",
  }).user;
  const secondUser = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "其他用户",
  }).user;

  store.saveFavoriteSeat(firstUser.id, {
    libraryId: 8,
    seatKey: "A-01",
    label: "四楼 · 001",
  });
  store.saveFavoriteSeat(firstUser.id, {
    libraryId: 8,
    seatKey: "A-01",
    label: "四楼安静区 · 001",
  });

  assert.equal(store.listFavoriteSeats(firstUser.id).length, 1);
  assert.equal(store.listFavoriteSeats(firstUser.id)[0].label, "四楼安静区 · 001");
  assert.equal(store.listFavoriteSeats(secondUser.id).length, 0);
  store.close();
});

test("vault binds ciphertext to its owning record", () => {
  const key = Buffer.alloc(32, 4);
  const encrypted = encryptSecret("secret-value", key, "user-a:model");
  assert.equal(decryptSecret(encrypted, key, "user-a:model"), "secret-value");
  assert.throws(
    () => decryptSecret(encrypted, key, "user-b:model"),
    /authenticate data|unable to authenticate/i,
  );
});

test("TraceInt authorization accepts only a code or a link containing a code", () => {
  assert.equal(extractAuthorizationCode("abcdefgh1234"), "abcdefgh1234");
  assert.equal(
    extractAuthorizationCode("https://example.com/callback?code=abcdefgh1234&state=1"),
    "abcdefgh1234",
  );
  assert.throws(
    () => extractAuthorizationCode("https://example.com/callback?state=1"),
    /没有有效 code/,
  );
});

test("TraceInt client exchanges authorization and maps normal library data", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/urlNew/auth.html")) {
      return {
        status: 302,
        ok: false,
        headers: {
          getSetCookie: () => ["wechatSESS_ID=abc; Path=/", "SERVERID=node-1; Path=/"],
          get: (name) => (name === "location" ? "https://web.traceint.com/web/index.html" : null),
        },
      };
    }
    if (String(url) === "https://web.traceint.com/web/index.html") {
      return {
        status: 200,
        ok: true,
        headers: { getSetCookie: () => [], get: () => null },
      };
    }

    const operation = JSON.parse(options.body);
    if (operation.operationName === "list") {
      return new Response(
        JSON.stringify({
          data: {
            userAuth: {
              reserve: {
                libs: [
                  {
                    lib_id: 12,
                    lib_name: "三楼东区",
                    lib_floor: "3",
                    is_open: true,
                    lib_rt: { seats_total: 100, seats_used: 20, seats_booking: 5 },
                  },
                  { lib_id: 1, lib_name: "汇总", lib_floor: "0", is_open: true },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected operation ${operation.operationName}`);
  };
  const client = new TraceIntClient({ fetchImpl });
  const cookie = await client.exchangeAuthorization("abcdefgh1234");
  const libraries = await client.listLibraries(cookie);

  assert.equal(cookie.includes("wechatSESS_ID=abc"), true);
  assert.equal(cookie.includes("SERVERID=node-1"), true);
  assert.equal(libraries.length, 1);
  assert.deepEqual(libraries[0], {
    libraryId: 12,
    name: "三楼东区",
    floor: "3",
    isOpen: true,
    totalSeats: 100,
    usedSeats: 20,
    bookedSeats: 5,
  });
  assert.equal(requests.some((request) => request.options.headers?.cookie === cookie), true);
});

test("TraceInt client maps layouts and reports expired sessions without leaking cookies", async () => {
  const client = new TraceIntClient({
    fetchImpl: async (_url, options) => {
      const operation = JSON.parse(options.body);
      if (operation.operationName === "libLayout") {
        return new Response(
          JSON.stringify({
            data: {
              userAuth: {
                reserve: {
                  libs: [
                    {
                      lib_id: 8,
                      lib_name: "四楼",
                      lib_floor: "4",
                      is_open: true,
                      lib_layout: {
                        seats_total: 2,
                        seats_booking: 0,
                        seats_used: 1,
                        seats: [
                          { key: "A-01", name: "001", type: 1, status: false, x: 1, y: 2 },
                          { key: "A-02", name: "002", type: 1, status: true, x: 2, y: 2 },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          errors: [{ message: "access denied!", code: 40001 }],
          data: { userAuth: null },
        }),
        { status: 200 },
      );
    },
  });

  const layout = await client.getLibraryLayout("private-session-cookie", 8);
  assert.equal(layout.availableSeats, 1);
  assert.equal(layout.seats[0].isAvailable, true);
  await assert.rejects(
    () => client.listLibraries("private-session-cookie"),
    (error) =>
      error.code === "SESSION_EXPIRED" &&
      !error.message.includes("private-session-cookie"),
  );
});

test("Baiguo API data maps to stable courses, assignments, and notifications", () => {
  const input = {
    currentDate: { today: "20260729", theWeek: 4 },
    courseSchedule: [
      {
        dayList: [
          {
            courseList: [
              {
                courseNo: "ACC101",
                courseSeq: "03",
                courseName: "中级财务会计",
                teacherName: "张老师",
              },
            ],
          },
        ],
      },
    ],
    homework: [
      {
        courseNo: "ACC101",
        courseSeq: "03",
        courseName: "中级财务会计",
        paperId: "paper-7",
        endDate: "2026-08-03 23:59:59",
        homeworkStatus: "1",
        weekTime: "4",
        week: "1",
        section: "3",
      },
    ],
    messages: {
      list: [
        {
          messageId: "notice-2",
          title: "课程安排调整",
          createTime: "2026-07-29 10:00:00",
          readStatus: "0",
        },
      ],
    },
  };
  const first = mapBaiguoApiSnapshot(input);
  const second = mapBaiguoApiSnapshot(input);

  assert.equal(first.courses.length, 1);
  assert.equal(first.assignments.length, 1);
  assert.equal(first.assignments[0].status, "open");
  assert.equal(first.notifications[0].read, false);
  assert.equal(first.courses[0].externalId, second.courses[0].externalId);
  assert.equal(
    first.assignments[0].courseExternalId,
    first.courses[0].externalId,
  );
});

test("Baiguo authorization accepts only the trusted callback and decodes SSO tokens", () => {
  const token = Buffer.from("sso-token").toString("base64");
  const refresh = Buffer.from("sso-refresh").toString("base64");
  const credentials = extractBaiguoAuthorization(
    `https://ginkgostu.dufe.edu.cn/auth/callback?token=${encodeURIComponent(token)}&refresh_token=${encodeURIComponent(refresh)}`,
  );

  assert.equal(credentials.token, "sso-token");
  assert.equal(credentials.refreshToken, "sso-refresh");
  assert.throws(
    () =>
      extractBaiguoAuthorization(
        `https://evil.example/callback?token=${token}&refresh_token=${refresh}`,
      ),
    /不受信任/,
  );
});

test("Baiguo client reads direct APIs and refreshes an expired token once", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, token: options.headers.token });
    if (path === "/student/currentDate" && options.headers.token === "expired-token") {
      return new Response("", { status: 401 });
    }
    if (path === "/student/resetToken") {
      return new Response(
        JSON.stringify({ data: { data: { token: "fresh-token" } } }),
        { status: 200 },
      );
    }
    const dataByPath = {
      "/student/currentDate": { data: { data: { today: "20260729", theWeek: 3 } } },
      "/student/queryCourseList": {
        data: {
          data: [
            {
              courseNo: "MATH1",
              courseSeq: "01",
              courseName: "高等数学",
            },
          ],
        },
      },
      "/student/queryNetCourseList": { data: { data: [] } },
      "/student/queryNoWeekTimeCourseList": { data: { data: [] } },
      "/student/HomeworkList": {
        data: {
          data: [
            {
              courseNo: "MATH1",
              courseSeq: "01",
              courseName: "高等数学",
              paperId: "p1",
              homeworkStatus: "1",
              endDate: "2026-08-01 23:59:59",
            },
          ],
        },
      },
      "/student/message/getMessageAll": { data: { data: { list: [] } } },
    };
    return new Response(JSON.stringify(dataByPath[path]), { status: 200 });
  };
  const client = new BaiguoClient({ fetchImpl });
  const result = await client.sync({
    token: "expired-token",
    refreshToken: "refresh-token",
    batchNo: "20251",
    fingerprint: "device-fingerprint",
  });

  assert.equal(result.credentials.token, "fresh-token");
  assert.equal(result.snapshot.courses[0].title, "高等数学");
  assert.equal(result.snapshot.assignments[0].status, "open");
  assert.equal(
    requests.filter((request) => request.path === "/student/resetToken").length,
    1,
  );
  assert.equal(
    requests
      .filter((request) => request.path !== "/student/resetToken")
      .slice(1)
      .every((request) => request.token === "fresh-token"),
    true,
  );
});

test("Baiguo snapshots upsert idempotently and retire records missing from the next sync", () => {
  const store = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 6),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const { user } = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "同步测试",
  });
  const first = normalizeBaiguoSnapshot({
    courses: [
      { externalId: "course-1", title: "高等数学", sectionExternalId: "section-1" },
    ],
    assignments: [
      {
        externalId: "assignment-1",
        courseExternalId: "course-1",
        title: "第一章作业",
        dueAt: "2026-08-01 23:59:59",
        status: "open",
      },
    ],
    notifications: [
      { externalId: "notice-1", title: "停课通知", read: false },
    ],
  }, "2026-07-29T10:00:00.000Z");
  store.syncBaiguoSnapshot(user.id, first);
  store.syncBaiguoSnapshot(user.id, first);
  assert.equal(store.getBaiguoItems(user.id).assignments.length, 1);

  const second = normalizeBaiguoSnapshot({
    courses: [
      { externalId: "course-1", title: "高等数学", sectionExternalId: "section-1" },
    ],
    assignments: [],
    notifications: [],
  }, "2026-07-29T11:00:00.000Z");
  store.syncBaiguoSnapshot(user.id, second);
  const items = store.getBaiguoItems(user.id);

  assert.equal(items.courses.length, 1);
  assert.equal(items.assignments.length, 0);
  assert.equal(items.notifications.length, 0);
  assert.equal(items.syncState.itemCount, 1);
  store.close();
});

test("QR pairing is short-lived, user-scoped, and never returns submitted authorization", async () => {
  let now = baseTime;
  const service = new PairingService({ clock: () => now, ttlMs: 60_000 });
  const pairing = service.create({
    userId: "user-a",
    publicBaseUrl: "https://dufesh.cn",
  });
  let submitted = "";

  assert.equal(pairing.mobileUrl.startsWith("https://dufesh.cn/pair?token="), true);
  assert.equal(service.getForUser(pairing.id, "user-b"), null);
  const completed = await service.submit({
    token: pairing.token,
    authorization: "https://trusted.example/callback?code=secret",
    complete: async (_session, authorization) => {
      submitted = authorization;
    },
  });

  assert.equal(completed.status, "completed");
  assert.equal(submitted.includes("code=secret"), true);
  assert.equal(JSON.stringify(completed).includes("secret"), false);

  const expiring = service.create({
    userId: "user-a",
    publicBaseUrl: "http://127.0.0.1:43120",
  });
  now += 61_000;
  await assert.rejects(
    () =>
      service.submit({
        token: expiring.token,
        authorization: "code",
        complete: async () => {},
      }),
    /已经失效/,
  );
});

test("seat availability watches notify once without auto-reserving", async () => {
  const store = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 8),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const { user } = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "候补提醒测试",
  });
  store.saveSeatWatch(user.id, {
    libraryId: "8",
    libraryName: "四楼",
    seatKey: "A-01",
    seatLabel: "001",
  });
  let checkCount = 0;
  const runner = new SeatWatchRunner({
    store,
    adapterForUser: () => ({
      checkSeat: async () => {
        checkCount += 1;
        return { available: true };
      },
    }),
    clock: () => baseTime,
  });

  await runner.runDue();
  await runner.runDue();
  const watches = store.listSeatWatches(user.id);
  const notifications = store.listNotifications(user.id);

  assert.equal(checkCount, 1);
  assert.equal(watches[0].status, "available");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title.includes("001"), true);
  store.close();
});

test("venue discovery reports available counts without writing reservations", async () => {
  const store = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 10),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const { user } = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "空位发现测试",
  });
  store.saveSeatWatch(user.id, {
    libraryId: "9",
    libraryName: "南区四楼",
    seatKey: "*",
    seatLabel: "南区四楼任意座位",
  });
  let layoutReads = 0;
  const runner = new SeatWatchRunner({
    store,
    adapterForUser: () => ({
      getLibraryLayout: async () => {
        layoutReads += 1;
        return { availableSeats: 12 };
      },
    }),
    clock: () => baseTime,
  });

  await runner.runDue();
  await runner.runDue();
  const notification = store.listNotifications(user.id)[0];
  assert.equal(layoutReads, 1);
  assert.equal(notification.title, "南区四楼 有空位了");
  assert.equal(notification.body.includes("12"), true);
  store.close();
});

test("scheduled reservations claim once and persist a user notification", async () => {
  const store = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 11),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const { user } = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "定时预约测试",
  });
  store.saveScheduledReservation(user.id, {
    libraryId: "12",
    libraryName: "北区三楼",
    seatKey: "B-18",
    seatLabel: "018",
    reservationKind: "tomorrow",
    runAt: new Date(baseTime).toISOString(),
    maxAttempts: 3,
  });
  let reserveCount = 0;
  const runner = new ScheduledReservationRunner({
    store,
    adapterForUser: () => ({
      reserve: async () => {
        reserveCount += 1;
        return { reservationId: "reservation-1" };
      },
    }),
  });

  await runner.runDue();
  await runner.runDue();
  const action = store.listScheduledReservations(user.id)[0];
  const notification = store.listNotifications(user.id)[0];

  assert.equal(reserveCount, 1);
  assert.equal(action.status, "succeeded");
  assert.equal(notification.title.includes("预约成功"), true);
  store.close();
});

test("reservation guard performs only the user-approved number of rebook cycles", async () => {
  const store = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 12),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const { user } = store.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "预约守护测试",
  });
  store.enableReservationGuard(user.id, {
    rebookBeforeSeconds: 30,
    rebookDelaySeconds: 1,
    maxCycles: 1,
  });
  let cancelCount = 0;
  let reserveCount = 0;
  const runner = new ReservationGuardRunner({
    store,
    clock: () => baseTime,
    waitFor: async () => {},
    adapterForUser: () => ({
      getStatus: async () => ({
        currentReservation: {
          reservationToken: "token-1",
          libraryId: 8,
          libraryName: "四楼",
          seatKey: "A-01",
          seatName: "001",
          date: "2026-07-29",
          expiresAt: new Date(baseTime + 10_000).toISOString(),
        },
      }),
      cancel: async () => {
        cancelCount += 1;
        return { cancelled: true };
      },
      reserve: async () => {
        reserveCount += 1;
        return { reservationId: "new-reservation" };
      },
    }),
  });

  await runner.runDue();
  await runner.runDue();
  const guard = store.getReservationGuard(user.id);

  assert.equal(cancelCount, 1);
  assert.equal(reserveCount, 1);
  assert.equal(guard.status, "completed");
  assert.equal(guard.cycleCount, 1);
  store.close();
});

test("user backups exclude credentials and do not reactivate imported automations", () => {
  const source = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 13),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const sourceUser = source.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "备份源",
  }).user;
  source.setExternalCredential(sourceUser.id, "traceint", "private-cookie");
  source.setModelKey(sourceUser.id, {
    provider: "test",
    apiKey: "private-api-key",
    model: "test-model",
    baseUrl: "https://api.example.com",
  });
  source.saveFavoriteSeat(sourceUser.id, {
    libraryId: "8",
    seatKey: "A-01",
    label: "四楼 · 001",
  });
  source.saveScheduledReservation(sourceUser.id, {
    libraryId: "8",
    libraryName: "四楼",
    seatKey: "A-01",
    seatLabel: "001",
    runAt: new Date(baseTime + 60_000).toISOString(),
  });
  const backup = source.exportUserData(sourceUser.id);
  const serialized = JSON.stringify(backup);

  assert.equal(serialized.includes("private-cookie"), false);
  assert.equal(serialized.includes("private-api-key"), false);
  assert.equal(backup.security.includesCredentials, false);

  const target = new XiaoyingLocalStore({
    databasePath: ":memory:",
    masterKey: Buffer.alloc(32, 14),
    defaultInviteCode: "fjbadguy",
    clock: () => baseTime,
  });
  const targetUser = target.unlockVip({
    inviteCode: "fjbadguy",
    displayName: "备份目标",
  }).user;
  const summary = target.importUserData(targetUser.id, backup);

  assert.equal(target.listFavoriteSeats(targetUser.id).length, 1);
  assert.equal(target.listScheduledReservations(targetUser.id).length, 0);
  assert.equal(summary.skippedAutomations, 1);
  source.close();
  target.close();
});
