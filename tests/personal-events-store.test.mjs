import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { validateSyncWrite } from "../services/auth-api/src/sync-contract.mjs";
import { createPersonalStore } from "../services/auth-api/src/personal-store.mjs";

const legacy = { id: "legacy", title: "旧例会", weekday: 7, block: 2, location: "", notes: "", color: "red" };
const clock = { ...legacy, id: "clock", date: "2026-10-11", repeat: "none", startTime: "12:05", endTime: "12:45" };
function write(activities, revision = 0) {
  return { mutationId: `event-mutation-${revision}-test`, baseRevision: revision, clientUpdatedAt: new Date().toISOString(), state: {
    profile: null, skipped: true, plans: [{ id: "default", name: "默认", scheduleIds: [] }], activePlanId: "default", activities, assignments: [], academicSnapshots: [], trainingPlan: null, favoriteRooms: [], recentRooms: [], preferredTerm: "fall", theme: "system",
  } };
}
test("sync API contract retains clocks and rejects partial/invalid clock tuples", () => {
  assert.deepEqual(validateSyncWrite(write([legacy, clock])).state.activities, [legacy, clock]);
  for (const bad of [ { ...clock, endTime: "12:05" }, { ...clock, endTime: "00:01" }, { ...clock, startTime: "9:00" }, { ...clock, date: "2026-02-30" }, { ...clock, date: undefined }, { ...clock, weekday: 1 }, { ...clock, repeat: "daily" }, { ...legacy, startTime: "12:00" } ]) {
    assert.throws(() => validateSyncWrite(write([bad])), { code: "SYNC_PAYLOAD_INVALID" });
  }
});
test("additive migration and real SQL round-trip retain clocks across old-client writes, conflicts and transitions", async () => {
  const database = new PGlite();
  await database.waitReady;
  const userId = "00000000-0000-4000-8000-000000000924";
  try {
    const directory = path.resolve("ops/postgres/migrations");
    const migrations = (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrations.filter((file) => !file.startsWith("0024"))) await database.exec(await fs.readFile(path.join(directory, file), "utf8"));
    await database.query("INSERT INTO app_users (id, status, display_name) VALUES ($1, 'active', '事件测试')", [userId]);
    await database.query("INSERT INTO personal_activities (user_id, client_id, title, weekday, block, revision, client_updated_at) VALUES ($1, 'legacy', '旧例会', 7, 2, 1, now())", [userId]);
    await database.exec(await fs.readFile(path.join(directory, "0024_personal_event_clock.sql"), "utf8"));
    const pool = { connect: async () => ({ query: async (...args) => {
      const result = await database.query(...args);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    }, release() {} }) };
    const store = createPersonalStore(pool);
    assert.deepEqual((await store.getPersonalState(userId)).state.activities, [legacy]);
    const first = await store.replacePersonalState(userId, validateSyncWrite(write([legacy, clock])));
    assert.deepEqual(first.state.activities, [legacy, clock]);
    const oldClientClock = { ...legacy, id: "clock", weekday: 1, block: 4, title: "旧标签改标题" };
    const second = await store.replacePersonalState(userId, validateSyncWrite(write([legacy, oldClientClock], 1)));
    assert.deepEqual(second.state.activities[1], { ...clock, title: oldClientClock.title });
    const stale = await store.replacePersonalState(userId, validateSyncWrite({ ...write([legacy], 1), mutationId: "event-stale-mutation" }));
    assert.equal(stale.conflict, true);
    assert.equal(stale.state.activities.length, 2);
    const weekly = { ...clock, repeat: "weekly", date: "2026-10-10", weekday: 6, startTime: "23:00", endTime: "23:59" };
    const third = await store.replacePersonalState(userId, validateSyncWrite(write([legacy, weekly], 2)));
    assert.deepEqual(third.state.activities[1], weekly);
    const fourth = await store.replacePersonalState(userId, validateSyncWrite(write([legacy, clock], 3)));
    assert.deepEqual(fourth.state.activities[1], clock);
    await assert.rejects(database.query("UPDATE personal_activities SET end_time = start_time WHERE client_id = 'clock'"));
    const deleted = await store.replacePersonalState(userId, validateSyncWrite(write([legacy], 4)));
    assert.deepEqual(deleted.state.activities, [legacy]);
    const tombstone = await database.query("SELECT start_time, deleted_at FROM personal_activities WHERE client_id = 'clock'");
    assert.equal(tombstone.rows[0].start_time, "12:05");
    assert.ok(tombstone.rows[0].deleted_at);
  } finally { await database.close(); }
});
