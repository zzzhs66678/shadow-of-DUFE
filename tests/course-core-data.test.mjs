import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("course core preserves every schedule identity and home field", async () => {
  const [full, core] = await Promise.all([
    readJson("../public/data/course-data.json"),
    readJson("../public/data/course-core.json"),
  ]);
  const courseTitles = new Map(core.courseTitles);
  const decoded = new Map(
    core.schedules.map(
      ([
        id,
        encodedTerm,
        courseIndex,
        teacherIndex,
        weekday,
        block,
        weeks,
        timeTextIndex,
        venueIndex,
        roomIndex,
      ]) => {
        const [courseId, title] = core.courseTitles[courseIndex];
        return [
          id,
          {
            term: encodedTerm === 0 ? "fall" : "spring",
            courseId,
            title,
            teacher: core.dictionaries.teachers[teacherIndex],
            weekday,
            block,
            weeks,
            timeText: core.dictionaries.timeTexts[timeTextIndex],
            building: core.dictionaries.venues[venueIndex],
            room: core.dictionaries.rooms[roomIndex],
          },
        ];
      },
    ),
  );

  assert.equal(core.version, 1);
  assert.equal(courseTitles.size, full.courses.length);
  assert.equal(decoded.size, full.schedules.length);
  for (const schedule of full.schedules) {
    assert.deepEqual(decoded.get(schedule.id), {
      term: schedule.term,
      courseId: schedule.courseId,
      title: schedule.title,
      teacher: schedule.teacher,
      weekday: schedule.weekday,
      block: schedule.block,
      weeks: schedule.weeks,
      timeText: schedule.timeText,
      building: schedule.building,
      room: schedule.room,
    });
  }
});
