import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the branded data-loading shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>东财之影｜课表、空教室与学习资料｜东财之影<\/title>/i);
  assert.match(html, /正在加载课程数据/);
  assert.match(html, /稍等一下，马上就好/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("course index preserves the expected source relationships", async () => {
  const raw = await readFile(
    new URL("../public/data/course-data.json", import.meta.url),
    "utf8",
  );
  const data = JSON.parse(raw);

  assert.equal(data.colleges.length, 19);
  assert.equal(data.majors.length, 72);
  assert.equal(data.courses.length, 1759);
  assert.equal(data.buildings.length, 5);
  assert.deepEqual(data.buildings, [
    "之远楼",
    "笃行楼",
    "书音楼",
    "播慧楼",
    "砺金楼",
  ]);
  assert.ok(data.majorCourses.length > 4000);
  assert.ok(data.schedules.length > 5800);
  const roomSchedules = data.schedules.filter((item) =>
    data.buildings.includes(item.building),
  );
  assert.equal(roomSchedules.length, data.quality.roomScheduleRows);
  assert.ok(
    data.schedules.some((item) => !data.buildings.includes(item.building)),
  );
  assert.ok(data.courses.every((course) => course.id && course.title));
});
