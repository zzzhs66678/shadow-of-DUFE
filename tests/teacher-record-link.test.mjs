import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  resolveTeacherScheduleHref,
  teacherHrefFromSchedulePayload,
  teacherSearchHref,
} from "../app/teacher-record-link.ts";

const catalogId = `course-v1:${"a".repeat(64)}`;
const teacherId = "11111111-1111-4111-8111-111111111111";

test("teacher schedule lookup only opens one explicit UUID", async () => {
  const calls = [];
  const href = await resolveTeacherScheduleHref({
    catalogId,
    scheduleId: "fall-C1-01-1",
    teacherName: "Same-name teacher",
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return { ok: true, async json() { return { items: [{ id: teacherId }] }; } };
    },
  });
  assert.equal(href, `/teachers/${teacherId}`);
  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /catalogId=course-v1%3A/u);
  assert.match(calls[0].input, /scheduleId=fall-C1-01-1/u);
  assert.equal(calls[0].init.method, "GET");
});

test("zero, multiple, malformed, and unversioned lookups keep name disambiguation", async () => {
  const fallback = teacherSearchHref("Same-name teacher");
  assert.equal(teacherHrefFromSchedulePayload("Same-name teacher", { items: [] }), fallback);
  assert.equal(
    teacherHrefFromSchedulePayload("Same-name teacher", {
      items: [{ id: teacherId }, { id: "22222222-2222-4222-8222-222222222222" }],
    }),
    fallback,
  );
  assert.equal(
    teacherHrefFromSchedulePayload("Same-name teacher", { items: [{ id: "not-a-uuid" }] }),
    fallback,
  );
  let called = false;
  assert.equal(
    await resolveTeacherScheduleHref({
      catalogId: "legacy",
      scheduleId: "fall-C1-01-1",
      teacherName: "Same-name teacher",
      fetcher: async () => {
        called = true;
        throw new Error("must not fetch");
      },
    }),
    fallback,
  );
  assert.equal(called, false);
});

test("teacher link performs no render-time lookup and covers every contextual entry", async () => {
  const [component, hub] = await Promise.all([
    readFile(new URL("../app/TeacherRecordLink.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/DufeHubV2.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(component, /useEffect/u);
  assert.match(component, /async function openTeacher/u);
  assert.match(component, /window\.location\.assign\(fallbackHref\)/u);
  assert.equal((hub.match(/<TeacherRecordLink/g) ?? []).length, 3);
});
