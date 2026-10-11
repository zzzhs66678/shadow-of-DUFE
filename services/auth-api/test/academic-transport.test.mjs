import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Agent, fetch } from "undici";
import { createAcademicTransport, createPublicLookup } from "../src/academic-transport.mjs";

function resolve(lookup, options = {}) {
  return new Promise((accept, reject) => lookup("school.example.test", options,
    (error, address, family) => error ? reject(error) : accept({ address, family })));
}

test("school socket lookup rejects private, metadata, special and mixed DNS answers", async () => {
  for (const address of ["127.0.0.1", "10.0.0.2", "172.18.0.5", "192.168.1.1", "169.254.169.254",
    "100.100.100.200", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1",
    "64:ff9b::a00:1", "not-an-address"]) {
    const lookup = createPublicLookup(async () => [{ address, family: address.includes(":") ? 6 : 4 }]);
    await assert.rejects(resolve(lookup), { code: "ACADEMIC_UNSAFE_ADDRESS" });
  }
  await assert.rejects(resolve(createPublicLookup(async () => [])), { code: "ACADEMIC_UNSAFE_ADDRESS" });
  await assert.rejects(resolve(createPublicLookup(async () => [
    { address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 },
  ])), { code: "ACADEMIC_UNSAFE_ADDRESS" });
});

test("lookup pins validated addresses and rechecks every new connection", async () => {
  let calls = 0;
  const lookup = createPublicLookup(async (host, options) => {
    assert.equal(host, "school.example.test"); assert.equal(options.all, true);
    calls += 1;
    return calls < 3 ? [{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }]
      : [{ address: "169.254.169.254", family: 4 }];
  });
  assert.deepEqual(await resolve(lookup, { all: true }), { address: [
    { address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 },
  ], family: undefined });
  assert.deepEqual(await resolve(lookup, { family: 6 }), { address: "2001:4860:4860::8888", family: 6 });
  await assert.rejects(resolve(lookup), { code: "ACADEMIC_UNSAFE_ADDRESS" });
});

test("real HTTP transport blocks a DNS answer pointing at a loopback service", async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end("private data"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const agent = new Agent({ connect: { lookup: createPublicLookup(async () => [{ address: "127.0.0.1", family: 4 }]) } });
  const transport = createAcademicTransport();
  try {
    await assert.rejects(fetch(`http://school.example.test:${server.address().port}/`, { dispatcher: agent }),
      (error) => error.cause?.code === "ACADEMIC_UNSAFE_ADDRESS");
    assert.equal(requests, 0);
    for (const url of [`http://127.0.0.1:${server.address().port}/`, "http://[::1]/"]) {
      await assert.rejects(async () => transport.fetch(url), { code: "ACADEMIC_UNSAFE_ADDRESS" });
    }
    assert.equal(requests, 0);
  } finally { transport.close(); await agent.destroy(); await new Promise(resolve => server.close(resolve)); }
});
