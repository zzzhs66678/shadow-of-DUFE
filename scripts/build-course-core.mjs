import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCourseCorePayload } from "./course-core-data.mjs";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "public/data/course-data.json");
const outputPath = resolve(root, "public/data/course-core.json");
const courseData = JSON.parse(await readFile(sourcePath, "utf8"));
const payload = buildCourseCorePayload(courseData);

await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      courses: payload.courseTitles.length,
      schedules: payload.schedules.length,
      outputPath,
    },
    null,
    2,
  ),
);
