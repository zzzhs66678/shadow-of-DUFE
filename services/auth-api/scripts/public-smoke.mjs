const baseUrl = (process.argv[2] || "https://dufesh.cn").replace(/\/$/, "");
const concurrency = Number.parseInt(process.argv[3] || "100", 10);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const healthResponse = await fetch(`${baseUrl}/api/auth/health`);
requireCondition(healthResponse.ok, "public health endpoint failed");

const firstResponse = await fetch(`${baseUrl}/api/auth/session`);
requireCondition(firstResponse.ok, "initial anonymous session failed");
const first = await firstResponse.json();
const deviceSetCookie = firstResponse.headers
  .getSetCookie()
  .find((value) => value.startsWith("__Host-dufesh_device="));

requireCondition(first.authenticated === false, "anonymous state was incorrect");
requireCondition(first.deviceId, "anonymous device id was missing");
requireCondition(deviceSetCookie, "anonymous device cookie was missing");
for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
  requireCondition(
    deviceSetCookie.includes(attribute),
    `device cookie is missing ${attribute}`,
  );
}
requireCondition(!deviceSetCookie.includes("Domain="), "cookie must be host-only");

const deviceCookie = deviceSetCookie.split(";", 1)[0];
const startedAt = performance.now();
const responses = await Promise.all(
  Array.from({ length: concurrency }, () =>
    fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: deviceCookie },
    }),
  ),
);
const payloads = await Promise.all(responses.map((response) => response.json()));
const durationMs = Math.round(performance.now() - startedAt);

requireCondition(
  responses.every((response) => response.status === 200),
  "one or more concurrent requests failed",
);
requireCondition(
  payloads.every((payload) => payload.deviceId === first.deviceId),
  "anonymous device identity changed under concurrency",
);

const rejectedLogout = await fetch(`${baseUrl}/api/auth/logout`, {
  method: "POST",
  headers: { Origin: "https://attacker.invalid", Cookie: deviceCookie },
});
requireCondition(rejectedLogout.status === 403, "untrusted origin was accepted");

console.log(
  JSON.stringify({
    ok: true,
    baseUrl,
    concurrency,
    durationMs,
    allResponsesSuccessful: true,
    deviceIdentityStable: true,
    secureCookie: true,
    untrustedOriginRejected: true,
  }),
);
