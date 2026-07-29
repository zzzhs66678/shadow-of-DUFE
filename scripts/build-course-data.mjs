import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  extractMeetingTimes,
  parseWeeks,
  splitMeetingLocations,
} from "./course-schedule-logic.mjs";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(
  root,
  ".codex_tmp/course-workbook-analysis/workbook-data.json",
);
const outputPath = resolve(root, "public/data/course-data.json");

const source = JSON.parse(await readFile(sourcePath, "utf8"));
const sheets = Object.fromEntries(source.sheets.map((sheet) => [sheet.name, sheet]));

const indexRows = sheets["专业索引1"].values.slice(1);
const rawAliases = indexRows
  .filter((row) => row[0] && row[1] && row[3])
  .map((row) => ({
    college: String(row[0]).trim(),
    alias: String(row[1]).trim(),
    name: String(row[3]).trim(),
  }));

const programMap = new Map();
for (const item of rawAliases) {
  const key = `${item.college}::${item.name}`;
  if (!programMap.has(key)) {
    programMap.set(key, {
      id: `major-${programMap.size + 1}`,
      college: item.college,
      name: item.name,
      aliases: [],
    });
  }
  programMap.get(key).aliases.push(item.alias);
}
const majors = [...programMap.values()];
const aliases = rawAliases
  .map((item) => ({
    ...item,
    majorId: programMap.get(`${item.college}::${item.name}`).id,
  }))
  .sort((a, b) => b.alias.length - a.alias.length);
const buildings = ["之远楼", "笃行楼", "书音楼", "播慧楼", "砺金楼"];
const termConfig = {
  上学期: {
    key: "fall",
    sheet: "上学期分类",
    cohortToYear: { 26: 1, 25: 2, 24: 3, 23: 4 },
  },
  下学期: {
    key: "spring",
    sheet: "下学期分类",
    cohortToYear: { 25: 1, 24: 2, 23: 3, 22: 4 },
  },
};

const clean = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text === "#NAME?" || text === "#REF!" ? "" : text;
};

const parseMajor = (className, config) => {
  const normalized = clean(className).replace(/\s/g, "");
  if (!normalized || /任选|选修/.test(normalized)) return null;

  const cohortMatch = normalized.match(/(\d{2})(?=\d{2}(?:\D|$))/);
  const cohort = cohortMatch?.[1] ?? normalized.match(/(\d{2})/)?.[1];
  const year = cohort ? config.cohortToYear[cohort] : undefined;
  const matched = aliases.find((major) => normalized.startsWith(major.alias));

  return matched && year ? { majorId: matched.majorId, year } : null;
};

const parseBuilding = (location) =>
  buildings.find((building) => clean(location).includes(building)) ?? "";

const parseVenue = (location) => {
  const value = clean(location);
  const targetBuilding = parseBuilding(value);
  if (targetBuilding) return targetBuilding;
  return value.replace(/^校本部/, "") || "地点待补";
};

const parseRoom = (location, building) => {
  if (!building || !buildings.includes(building)) return "";
  const tail = clean(location).split(building).at(-1) ?? "";
  return tail.replace(/^[（(][^）)]*[）)]/, "").replace(/[^\dA-Za-z-]/g, "");
};

const parseWeekday = (time) => {
  const match = clean(time).match(/星期([一二三四五六日])/);
  return match ? "一二三四五六日".indexOf(match[1]) + 1 : 0;
};

const parsePeriods = (time) => {
  const match = clean(time).match(/第(\d+)(?:-(\d+))?节/);
  if (!match) return [];
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
};

const blockForPeriods = (periods) => {
  if (periods.some((period) => period <= 2)) return 1;
  if (periods.some((period) => period <= 4)) return 2;
  if (periods.some((period) => period <= 7)) return 3;
  return periods.length ? 4 : 0;
};

const courseMap = new Map();
const majorCourseMap = new Map();
const schedules = [];
const publicElectives = new Map();
const unmatchedClasses = new Set();
let sourceScheduleRows = 0;
let multiMeetingRows = 0;
let allSourceScheduleRows = 0;
let allMultiMeetingRows = 0;
let roomScheduleRows = 0;

for (const config of Object.values(termConfig)) {
  const rows = sheets[config.sheet].values.slice(1);

  for (const row of rows) {
    const courseId = clean(row[7]);
    const title = clean(row[6]);
    if (!courseId || !title) continue;

    const course = courseMap.get(courseId) ?? {
      id: courseId,
      title,
      college: clean(row[5]),
      category: clean(row[12]),
      property: clean(row[11]),
      credits: clean(row[14]),
      textbook: clean(row[18]),
      publisher: clean(row[19]),
      author: clean(row[23] ?? row[22]),
      terms: [],
      teachers: [],
    };
    if (!course.terms.includes(config.key)) course.terms.push(config.key);
    const teacher = clean(row[9]);
    if (teacher && !course.teachers.includes(teacher)) course.teachers.push(teacher);
    courseMap.set(courseId, course);

    const classNames = clean(row[17])
      .split(/[，,、；;]/)
      .map((part) => part.trim())
      .filter(Boolean);
    let linked = false;

    for (const className of classNames) {
      const association = parseMajor(className, config);
      if (!association) {
        if (/任选|选修/.test(className)) {
          publicElectives.set(`${config.key}-${courseId}`, {
            courseId,
            term: config.key,
          });
        } else if (className) {
          unmatchedClasses.add(className);
        }
        continue;
      }

      linked = true;
      majorCourseMap.set(
        `${association.majorId}-${association.year}-${config.key}-${courseId}`,
        {
          majorId: association.majorId,
          year: association.year,
          term: config.key,
          courseId,
        },
      );
    }

    const meetingTimes = extractMeetingTimes(row[15]);
    const meetingLocations = splitMeetingLocations(row[16]);
    if (!meetingTimes.length) continue;

    allSourceScheduleRows += 1;
    if (meetingTimes.length > 1) allMultiMeetingRows += 1;
    const hasTargetBuilding = meetingLocations.some((location) =>
      Boolean(parseBuilding(location)),
    );
    if (hasTargetBuilding) {
      sourceScheduleRows += 1;
      if (meetingTimes.length > 1) multiMeetingRows += 1;
    }
    const sourceRow = clean(row[2]);
    const sectionNumber = clean(row[8]);
    const sectionId = `${config.key}-${courseId}-${sectionNumber}-${sourceRow}`;
    // Preserve the V10 IDs used by existing local timetables. New schedules
    // outside the five-building room map use the stable section identifier.
    const legacyId = hasTargetBuilding
      ? `${config.key}-${courseId}-${sectionNumber}-${sourceScheduleRows}`
      : `${sectionId}-venue`;

    meetingTimes.forEach((timeText, meetingIndex) => {
      const location =
        meetingLocations[meetingIndex] ??
        meetingLocations.at(-1) ??
        clean(row[16]);
      const targetBuilding = parseBuilding(location);
      const building = parseVenue(location);
      const periods = parsePeriods(timeText);
      if (targetBuilding) roomScheduleRows += 1;
      schedules.push({
        id:
          meetingIndex === 0
            ? legacyId
            : `${legacyId}-m${meetingIndex + 1}`,
        sectionId,
        meetingIndex: meetingIndex + 1,
        sourceRow,
        term: config.key,
        courseId,
        title,
        teacher,
        weekday: parseWeekday(timeText),
        block: blockForPeriods(periods),
        periods,
        weeks: parseWeeks(timeText),
        timeText,
        building,
        room: parseRoom(location, building),
        classNames: classNames.join("、"),
        linked,
      });
    });
  }
}

const colleges = [...new Set(majors.map((major) => major.college))]
  .sort((a, b) => a.localeCompare(b, "zh-CN"))
  .map((name) => ({
    name,
    majorIds: majors.filter((major) => major.college === name).map((major) => major.id),
  }));

const payload = {
  generatedAt: new Date().toISOString(),
  source: "专业课程按上下学期拆分.xlsx",
  disclaimer:
    "课程与教室状态由导入课表推算，不代表实时占用；临时调课、考试和活动请以学校官方通知为准。",
  semesters: [
    { key: "fall", label: "上学期", mode: "day" },
    { key: "spring", label: "下学期", mode: "night" },
  ],
  periods: [
    { block: 1, label: "第一大节", short: "1–2节", time: "08:00–09:35" },
    { block: 2, label: "第二大节", short: "3–4节", time: "09:55–11:30" },
    { block: 3, label: "第三大节", short: "5–7节", time: "13:00–15:25" },
    { block: 4, label: "第四大节", short: "8–10节", time: "18:15–20:40" },
  ],
  buildings,
  colleges,
  majors,
  majorAliases: aliases,
  courses: [...courseMap.values()].sort((a, b) =>
    a.title.localeCompare(b.title, "zh-CN"),
  ),
  majorCourses: [...majorCourseMap.values()],
  schedules,
  publicElectives: [...publicElectives.values()],
  quality: {
    sourceRows:
      sheets["上学期分类"].values.length +
      sheets["下学期分类"].values.length -
      2,
    unmatchedClassLabels: unmatchedClasses.size,
    sourceScheduleRows,
    multiMeetingRows,
    allSourceScheduleRows,
    allMultiMeetingRows,
    roomScheduleRows,
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      colleges: payload.colleges.length,
      majors: payload.majors.length,
      courses: payload.courses.length,
      majorCourses: payload.majorCourses.length,
      schedules: payload.schedules.length,
      sourceScheduleRows: payload.quality.sourceScheduleRows,
      multiMeetingRows: payload.quality.multiMeetingRows,
      allSourceScheduleRows: payload.quality.allSourceScheduleRows,
      allMultiMeetingRows: payload.quality.allMultiMeetingRows,
      roomScheduleRows: payload.quality.roomScheduleRows,
      publicElectives: payload.publicElectives.length,
      unmatchedClassLabels: payload.quality.unmatchedClassLabels,
      outputPath,
    },
    null,
    2,
  ),
);
