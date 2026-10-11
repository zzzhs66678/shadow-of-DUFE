import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = process.cwd();
const inventoryPath = path.join(
  workspace,
  "outputs",
  "resource-inventory",
  "resource-inventory.csv",
);
const duplicatePath = path.join(
  workspace,
  "outputs",
  "resource-inventory",
  "duplicate-candidates-hashed.csv",
);
const courseDataPath = path.join(workspace, "public", "data", "course-data.json");
const outputDirectory = path.join(workspace, "outputs", "resource-publish");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const headers = rows.shift().map((item) => item.replace(/^\uFEFF/, ""));
  return rows.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
  );
}

function publicPath(relativePath) {
  return relativePath
    .split(/[\\/]/)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function kindFor(extension) {
  if (extension === ".pdf") return "PDF";
  if ([".ppt", ".pptx"].includes(extension)) return "课件";
  if ([".doc", ".docx"].includes(extension)) return "文档";
  if ([".xls", ".xlsx", ".csv"].includes(extension)) return "表格";
  if (extension === ".mp4") return "视频";
  if (extension === ".sav") return "数据";
  if ([".jpg", ".jpeg", ".png"].includes(extension)) return "图片";
  return "文件";
}

function aliasesForFolder(folder) {
  if (folder === "毛概") {
    return ["毛泽东思想和中国特色社会主义理论体系概论"];
  }
  return [folder];
}

await mkdir(outputDirectory, { recursive: true });
const inventory = parseCsv(await readFile(inventoryPath, "utf8")).filter((item) =>
  ["preview_and_download", "download_only"].includes(item.delivery),
);
const duplicateRows = parseCsv(
  await readFile(duplicatePath, "utf8").catch(() => ""),
);
const duplicateHashByPath = new Map(
  duplicateRows.map((item) => [item.relativePath, item.sha256]),
);
const courseData = JSON.parse(await readFile(courseDataPath, "utf8"));
const courseYears = new Map();
for (const relation of courseData.majorCourses) {
  const years = courseYears.get(relation.courseId) ?? new Set();
  years.add(relation.year);
  courseYears.set(relation.courseId, years);
}

const generatedAt = new Date().toISOString();

const materials = inventory.map((item) => {
  const extension = item.extension.toLowerCase();
  const sizeBytes = Number(item.sizeBytes);
  const courseTitles = aliasesForFolder(item.course);
  const matchingCourses = courseData.courses.filter((course) =>
    courseTitles.includes(course.title),
  );
  const relativeUrl = publicPath(item.relativePath);
  const duplicateHash = duplicateHashByPath.get(item.relativePath);
  const id = (
    duplicateHash ??
    createHash("sha256")
      .update(`${item.relativePath}\0${item.sizeBytes}`)
      .digest("hex")
  ).slice(0, 20);
  const previewable =
    (extension === ".pdf" && sizeBytes <= 50 * 1024 * 1024) ||
    [".jpg", ".jpeg", ".png", ".txt"].includes(extension);
  const teachers = [
    ...new Set(matchingCourses.flatMap((course) => course.teachers ?? [])),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const colleges = [
    ...new Set(matchingCourses.map((course) => course.college).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const terms = [
    ...new Set(matchingCourses.flatMap((course) => course.terms ?? [])),
  ].sort();
  const years = [
    ...new Set(
      matchingCourses.flatMap((course) => [
        ...(courseYears.get(course.id) ?? []),
      ]),
    ),
  ].sort((a, b) => a - b);
  const category = item.category === item.fileName ? "其他" : item.category;
  const kind = kindFor(extension);
  return {
    id,
    courseTitle: item.course,
    courseIds: matchingCourses.map((course) => course.id),
    teachers,
    colleges,
    terms,
    years,
    tags: [...new Set([category, kind].filter(Boolean))],
    category,
    name: item.fileName,
    kind,
    extension,
    sizeBytes,
    catalogedAt: generatedAt,
    description: `${item.course}的${category === "其他" ? "学习" : category}资料`,
    previewable,
    previewUrl: previewable ? `/resources/files/${relativeUrl}` : "",
    downloadUrl: `/resources/files/${relativeUrl}`,
  };
});

const manifest = {
  schemaVersion: 2,
  generatedAt,
  previewLimitBytes: 50 * 1024 * 1024,
  materials,
};
await writeFile(
  path.join(outputDirectory, "resource-manifest.json"),
  `${JSON.stringify(manifest)}\n`,
  "utf8",
);
await writeFile(
  path.join(outputDirectory, "upload-list.txt"),
  `${inventory.map((item) => item.relativePath.replaceAll("\\", "/")).join("\n")}\n`,
  "utf8",
);
await writeFile(
  path.join(outputDirectory, "upload-download-only-list.txt"),
  `${inventory
    .filter((item) => item.delivery === "download_only")
    .map((item) => item.relativePath.replaceAll("\\", "/"))
    .join("\n")}\n`,
  "utf8",
);

const unmatched = [...new Set(materials.filter((item) => !item.courseIds.length).map((item) => item.courseTitle))];
console.log(
  JSON.stringify(
    {
      files: materials.length,
      bytes: materials.reduce((sum, item) => sum + item.sizeBytes, 0),
      previewable: materials.filter((item) => item.previewable).length,
      unmatchedCourseFolders: unmatched,
    },
    null,
    2,
  ),
);
