import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import readExcelFile from "read-excel-file/node";

const MAPPING_VERSION = "academic-workbooks-v1";
const PLACEHOLDER_ISBN = /^97811122233\d{2}$/;
const PHONE_OR_CONTACT = /(?:1[3-9]\d{9}|[1-9]\d{4,10}|(?:qq|QQ|微信|vx|手机号|电话)\s*[:：]?\s*[A-Za-z0-9_-]{5,})/g;

export function normalizeText(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function classifyIsbn(value) {
  const isbn = normalizeText(value).replace(/[\s-]/g, "");
  if (!isbn) return "missing";
  if (PLACEHOLDER_ISBN.test(isbn)) return "placeholder";
  if (!/^(?:\d{10}|\d{13})$/.test(isbn)) return "invalid";
  return "valid";
}

export function parsePublicationDate(value) {
  const raw = normalizeText(value);
  if (!raw) return { raw: null, date: null, status: "missing" };
  const compact = raw.replace(/[-/.年月日]/g, "");
  if (!/^\d{8}$/.test(compact)) return { raw, date: null, status: "invalid" };
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return { raw, date: null, status: "invalid" };
  }
  return { raw, date: candidate.toISOString().slice(0, 10), status: "valid" };
}

export function classifyReview(body, teacherName, knownTeacherNames = []) {
  const normalized = normalizeText(body);
  const mentionedTeachers = knownTeacherNames.filter(
    (name) => name !== teacherName && name.length >= 2 && normalized.includes(name),
  );
  const riskFlags = [];
  if (PHONE_OR_CONTACT.test(normalized)) riskFlags.push("possible_personal_contact");
  PHONE_OR_CONTACT.lastIndex = 0;
  if (mentionedTeachers.length) riskFlags.push("mentions_other_teachers");
  if (/挂了|挂科率|给分|分数|九十|八十|六十|期末|考试|闭卷|开卷|重点/.test(normalized)) {
    riskFlags.push("time_sensitive_assessment_claim");
  }
  if (/避雷|谁上谁|不会讲|并不知道|一上一个不吱声|垃圾|傻|蠢|滚/.test(normalized)) {
    riskFlags.push("possible_personal_attack");
  }
  if (normalized.length > 500) riskFlags.push("over_500_chars");
  if (normalized.length > 3000) riskFlags.push("over_3000_chars");
  return {
    normalized,
    sanitized: normalized.replace(PHONE_OR_CONTACT, "[已隐去联系方式]"),
    riskFlags,
    mentionedTeacherCount: mentionedTeachers.length,
  };
}

function splitNames(value) {
  return normalizeText(value)
    .split(/[、,，;；/]+/)
    .map(normalizeText)
    .filter(Boolean);
}

function valueAt(row, index) {
  return normalizeText(row?.[index]);
}

function teacherPair(college, name) {
  return `${normalizeText(college)}\u0000${normalizeText(name)}`;
}

function csvEscape(value) {
  const raw = Array.isArray(value) ? value.join("|") : String(value ?? "");
  const text = /^[=+@-]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  const headers = [
    "import_type",
    "source_sheet",
    "source_row",
    "source_column",
    "disposition",
    "error_codes",
    "entity_key",
  ];
  return `${headers.join(",")}\r\n${rows
    .map((row) =>
      [
        row.importType,
        row.sourceSheet,
        row.sourceRow,
        row.sourceColumn ?? "",
        row.disposition,
        row.errorCodes,
        row.entityKey,
      ]
        .map(csvEscape)
        .join(","),
    )
    .join("\r\n")}\r\n`;
}

function addResult(results, result) {
  results.push({
    importType: result.importType,
    sourceSheet: result.sourceSheet,
    sourceRow: result.sourceRow,
    sourceColumn: result.sourceColumn ?? null,
    disposition: result.disposition,
    errorCodes: [...new Set(result.errorCodes)].sort(),
    entityKey: result.entityKey,
  });
}

function summarizeResults(results) {
  const counts = { accepted: 0, warning: 0, rejected: 0 };
  const errorCodes = {};
  for (const result of results) {
    counts[result.disposition] += 1;
    for (const code of result.errorCodes) {
      errorCodes[code] = (errorCodes[code] ?? 0) + 1;
    }
  }
  return { rowCount: results.length, ...counts, errorCodes };
}

function requireSheet(workbook, name) {
  const sheet = workbook.find((candidate) => candidate.sheet === name);
  if (!sheet) throw new Error(`缺少工作表：${name}`);
  return sheet.data;
}

function extractSectionNo(sectionId, courseId) {
  const escapedCourseId = courseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sectionId.match(new RegExp(`^[^-]+-${escapedCourseId}-(.+)-[^-]+$`));
  return match?.[1] ?? "";
}

export function analyzeTeacherWorkbook(rows) {
  const results = [];
  const teacherRecords = [];
  const reviewCandidateRecords = [];
  const parsed = rows.slice(1).map((row, index) => ({
    sourceRow: index + 2,
    externalKey: valueAt(row, 0),
    college: valueAt(row, 1),
    name: valueAt(row, 2),
    reviews: row.slice(3).map((value) => ({
      raw: String(value ?? ""),
      normalized: normalizeText(value),
    })),
  })).filter(
    (row) => row.externalKey || row.college || row.name || row.reviews.some((review) => review.normalized),
  );

  const knownNames = [...new Set(parsed.map((row) => row.name).filter(Boolean))];
  const nameColleges = new Map();
  const externalKeyCounts = new Map();
  const reviewDigests = new Map();
  for (const row of parsed) {
    if (!nameColleges.has(row.name)) nameColleges.set(row.name, new Set());
    if (row.name) nameColleges.get(row.name).add(row.college);
    if (row.externalKey) {
      externalKeyCounts.set(row.externalKey, (externalKeyCounts.get(row.externalKey) ?? 0) + 1);
    }
  }

  let reviewCandidates = 0;
  let riskFlaggedReviewCandidates = 0;
  for (const row of parsed) {
    const identityErrors = [];
    if (!row.externalKey) identityErrors.push("teacher_external_key_missing");
    if (!row.name) identityErrors.push("teacher_name_missing");
    if (!row.college) identityErrors.push("teacher_college_missing");
    if (row.externalKey && externalKeyCounts.get(row.externalKey) > 1) {
      identityErrors.push("teacher_external_key_duplicate");
    }
    if (row.name && nameColleges.get(row.name)?.size > 1) {
      identityErrors.push("teacher_name_cross_college");
    }
    addResult(results, {
      importType: "teacher_identity",
      sourceSheet: "做在这个表",
      sourceRow: row.sourceRow,
      disposition: identityErrors.some((code) => code.endsWith("missing") || code.endsWith("duplicate"))
        ? "rejected"
        : identityErrors.length ? "warning" : "accepted",
      errorCodes: identityErrors,
      entityKey: row.externalKey || `row:${row.sourceRow}`,
    });
    const identityRejected = identityErrors.some(
      (code) => code.endsWith("missing") || code.endsWith("duplicate"),
    );
    if (!identityRejected) {
      teacherRecords.push({
        sourceLocator: `做在这个表!C${row.sourceRow}`,
        externalTeacherKey: row.externalKey,
        displayName: row.name,
        collegeName: row.college,
        sourceDigest: sha256([row.externalKey, row.name, row.college].join("\u0000")),
      });
    }

    row.reviews.forEach((review, reviewIndex) => {
      const body = review.normalized;
      if (!body) return;
      reviewCandidates += 1;
      const classified = classifyReview(body, row.name, knownNames);
      const digestKey = `${teacherPair(row.college, row.name)}\u0000${sha256(classified.normalized.toLocaleLowerCase("zh-CN"))}`;
      const duplicate = reviewDigests.has(digestKey);
      reviewDigests.set(digestKey, (reviewDigests.get(digestKey) ?? 0) + 1);
      if (classified.riskFlags.length) riskFlaggedReviewCandidates += 1;
      const errors = [
        "legacy_review_requires_moderation",
        ...classified.riskFlags,
        ...(duplicate ? ["duplicate_legacy_review"] : []),
        ...(!row.name || !row.college || !row.externalKey ? ["teacher_identity_unresolved"] : []),
      ];
      addResult(results, {
        importType: "teacher_review_candidate",
        sourceSheet: "做在这个表",
        sourceRow: row.sourceRow,
        sourceColumn: reviewIndex + 4,
        disposition: classified.riskFlags.includes("over_3000_chars") || errors.includes("teacher_identity_unresolved")
          ? "rejected"
          : "warning",
        errorCodes: errors,
        entityKey: `${row.externalKey || `row:${row.sourceRow}`}#${reviewIndex + 4}`,
      });
      if (
        !identityRejected &&
        !duplicate &&
        !classified.riskFlags.includes("over_3000_chars")
      ) {
        reviewCandidateRecords.push({
          sourceLocator: `做在这个表!${String.fromCharCode(68 + reviewIndex)}${row.sourceRow}`,
          sourceRow: row.sourceRow,
          sourceColumn: reviewIndex + 4,
          externalTeacherKey: row.externalKey,
          sanitizedBody: classified.sanitized,
          originalBodySha256: sha256(review.raw),
          normalizedBodySha256: sha256(classified.normalized.toLocaleLowerCase("zh-CN")),
          riskFlags: classified.riskFlags,
        });
      }
    });
  }

  return {
    results,
    bundle: { teachers: teacherRecords, reviewCandidates: reviewCandidateRecords },
    facts: {
      teacherRows: parsed.length,
      reviewCandidates,
      riskFlaggedReviewCandidates,
      sameNameAcrossColleges: [...nameColleges]
        .filter(([, colleges]) => colleges.size > 1)
        .map(([name, colleges]) => ({ name, colleges: [...colleges].sort() })),
    },
  };
}

export function analyzeTextbookWorkbook(planRows, joinedRows, courseData, teacherRecords = []) {
  const results = [];
  const textbookRecords = [];
  const courses = new Map(courseData.courses.map((course) => [normalizeText(course.id), course]));
  const scheduleKeys = new Set(
    courseData.schedules.map((schedule) => {
      const courseId = normalizeText(schedule.courseId);
      return [
        normalizeText(schedule.term),
        courseId,
        extractSectionNo(normalizeText(schedule.sectionId), courseId),
        normalizeText(schedule.teacher),
      ].join("|");
    }),
  );

  const official = planRows.slice(2).map((row, index) => ({
    sourceRow: index + 3,
    courseId: valueAt(row, 2),
    courseName: valueAt(row, 3),
    teachers: splitNames(row?.[4]),
    title: valueAt(row, 5),
    isbn: valueAt(row, 7),
    publicationDate: valueAt(row, 9),
  })).filter((row) => row.courseId || row.courseName || row.title);
  const officialByCourseTeacherTitle = new Map();
  for (const row of official) {
    for (const teacherName of row.teachers) {
      const key = [row.courseId, teacherName, normalizeText(row.title).toLocaleLowerCase("zh-CN")].join("\u0000");
      if (!officialByCourseTeacherTitle.has(key)) officialByCourseTeacherTitle.set(key, []);
      officialByCourseTeacherTitle.get(key).push(row);
    }
  }
  const externalTeacherKeyByPair = new Map(
    teacherRecords.map((teacher) => [
      teacherPair(teacher.collegeName, teacher.displayName),
      teacher.externalTeacherKey,
    ]),
  );

  let placeholderIsbnRows = 0;
  let invalidPublicationDateRows = 0;
  for (const row of official) {
    const errors = [];
    const isbnStatus = classifyIsbn(row.isbn);
    const date = parsePublicationDate(row.publicationDate);
    if (isbnStatus === "placeholder") {
      placeholderIsbnRows += 1;
      errors.push("placeholder_isbn");
    } else if (isbnStatus === "invalid") {
      errors.push("invalid_isbn");
    }
    if (date.status === "invalid") {
      invalidPublicationDateRows += 1;
      errors.push("invalid_publication_date");
    }
    if (row.title.startsWith("不指定教材")) errors.push("textbook_not_specified");
    if (row.teachers.length > 1) errors.push("multiple_teachers_in_plan_row");
    addResult(results, {
      importType: "textbook_plan_metadata",
      sourceSheet: "00",
      sourceRow: row.sourceRow,
      disposition: errors.length ? "warning" : "accepted",
      errorCodes: errors,
      entityKey: `${row.courseId}#${row.sourceRow}`,
    });
  }

  const joined = joinedRows.slice(1).map((row, index) => ({
    sourceRow: index + 2,
    termClass: valueAt(row, 0),
    courseCollege: valueAt(row, 5),
    courseName: valueAt(row, 6),
    courseId: valueAt(row, 7),
    sectionNo: valueAt(row, 8),
    teacherName: valueAt(row, 9),
    teacherCollege: valueAt(row, 10),
    title: valueAt(row, 18),
    publisher: valueAt(row, 19),
    publicationDate: valueAt(row, 20),
    edition: valueAt(row, 21),
    printing: valueAt(row, 22),
    author: valueAt(row, 23),
  })).filter((row) => row.courseId || row.courseName);

  const variantsByCourse = new Map();
  for (const row of joined) {
    if (!variantsByCourse.has(row.courseId)) variantsByCourse.set(row.courseId, new Set());
    variantsByCourse.get(row.courseId).add(
      [row.title, row.publisher, row.publicationDate, row.edition, row.printing, row.author].join("|"),
    );
  }

  let missingSiteCourseRows = 0;
  let missingSiteSectionRows = 0;
  for (const row of joined) {
    const errors = [];
    const termKey = row.termClass === "上学期" ? "fall" : row.termClass === "下学期" ? "spring" : row.termClass;
    if (!courses.has(row.courseId)) {
      missingSiteCourseRows += 1;
      errors.push("course_not_in_site_catalog");
    }
    if (!scheduleKeys.has([termKey, row.courseId, row.sectionNo, row.teacherName].join("|"))) {
      missingSiteSectionRows += 1;
      errors.push("teaching_section_not_in_site_schedule");
    }
    if (!row.teacherCollege) errors.push("teacher_college_missing");
    if ((variantsByCourse.get(row.courseId)?.size ?? 0) > 1) {
      errors.push("course_has_multiple_textbook_variants");
    }
    if (parsePublicationDate(row.publicationDate).status === "invalid") {
      errors.push("invalid_publication_date");
    }
    const rejected = errors.includes("course_not_in_site_catalog");
    addResult(results, {
      importType: "teaching_section_textbook",
      sourceSheet: "Sheet1",
      sourceRow: row.sourceRow,
      disposition: rejected ? "rejected" : errors.length ? "warning" : "accepted",
      errorCodes: errors,
      entityKey: `${termKey}|${row.courseId}|${row.sectionNo}|${row.teacherName}`,
    });
    if (!rejected) {
      const officialKey = [
        row.courseId,
        row.teacherName,
        normalizeText(row.title).toLocaleLowerCase("zh-CN"),
      ].join("\u0000");
      const officialMatches = officialByCourseTeacherTitle.get(officialKey) ?? [];
      const officialSignatures = new Map(
        officialMatches.map((candidate) => [
          [candidate.isbn, candidate.publicationDate].join("\u0000"),
          candidate,
        ]),
      );
      const officialMatch = officialSignatures.size === 1
        ? [...officialSignatures.values()][0]
        : null;
      const workbookDate = parsePublicationDate(row.publicationDate);
      const officialDate = officialMatch
        ? parsePublicationDate(officialMatch.publicationDate)
        : { raw: null, date: null, status: "missing" };
      const publicationDate = workbookDate.status === "valid" ? workbookDate : officialDate;
      const isbn = officialMatch?.isbn ?? "";
      const externalTeacherKey = externalTeacherKeyByPair.get(
        teacherPair(row.teacherCollege, row.teacherName),
      ) ?? null;
      const needsReview = errors.length > 0 || !externalTeacherKey || officialSignatures.size > 1;
      const selectionStatus = row.title.startsWith("不指定教材")
        ? "not_specified"
        : needsReview ? "needs_review" : "specified";
      const materialPayload = {
        title: row.title || null,
        author: row.author || null,
        publisher: row.publisher || null,
        publicationDate: publicationDate.date,
        publicationDateRaw: publicationDate.raw,
        edition: row.edition || null,
        printing: row.printing || null,
        isbn: isbn || null,
        isbnStatus: classifyIsbn(isbn),
      };
      textbookRecords.push({
        sourceLocator: `Sheet1!A${row.sourceRow}:Y${row.sourceRow}`,
        sourceRow: row.sourceRow,
        termKey,
        courseId: row.courseId,
        courseTitle: row.courseName,
        sectionNo: row.sectionNo,
        teacherName: row.teacherName,
        teacherCollege: row.teacherCollege,
        externalTeacherKey,
        materialKind: "book",
        selectionStatus,
        position: 1,
        recordStatus: needsReview ? "needs_review" : "current",
        materialSha256: sha256(JSON.stringify(materialPayload)),
        ...materialPayload,
      });
    }
  }

  return {
    results,
    bundle: { textbooks: textbookRecords },
    facts: {
      officialPlanRows: official.length,
      joinedSectionRows: joined.length,
      distinctCourses: new Set(joined.map((row) => row.courseId)).size,
      coursesWithMultipleTextbookVariants: [...variantsByCourse.values()].filter((variants) => variants.size > 1).length,
      placeholderIsbnRows,
      invalidPublicationDateRows,
      missingSiteCourseRows,
      missingSiteSectionRows,
    },
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`参数格式错误：${key ?? "<empty>"}`);
    values[key.slice(2)] = value;
  }
  for (const required of ["teacher", "textbook", "course-data", "out"]) {
    if (!values[required]) throw new Error(`缺少参数：--${required}`);
  }
  return values;
}

async function hashFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function assertWorkbookSize(filePath) {
  const { size } = await fs.stat(filePath);
  if (size > 50 * 1024 * 1024) {
    throw new Error(`工作簿超过 50MB 安全上限：${path.basename(filePath)}`);
  }
}

function assertPrivateOutputDirectory(outputDirectory) {
  const resolved = path.resolve(outputDirectory);
  for (const publicRoot of [path.resolve("public"), path.resolve("app")]) {
    if (resolved === publicRoot || resolved.startsWith(`${publicRoot}${path.sep}`)) {
      throw new Error("私有导入包不能写入公开页面或静态资源目录");
    }
  }
  return resolved;
}

export async function runPreflight(options) {
  await Promise.all([
    assertWorkbookSize(options.teacher),
    assertWorkbookSize(options.textbook),
  ]);
  const [teacherWorkbook, textbookWorkbook, courseData, teacherHash, textbookHash] = await Promise.all([
    readExcelFile(options.teacher),
    readExcelFile(options.textbook),
    fs.readFile(options["course-data"], "utf8").then(JSON.parse),
    hashFile(options.teacher),
    hashFile(options.textbook),
  ]);
  const teacher = analyzeTeacherWorkbook(requireSheet(teacherWorkbook, "做在这个表"));
  const textbook = analyzeTextbookWorkbook(
    requireSheet(textbookWorkbook, "00"),
    requireSheet(textbookWorkbook, "Sheet1"),
    courseData,
    teacher.bundle.teachers,
  );
  const results = [...teacher.results, ...textbook.results];
  const summary = {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    mappingVersion: MAPPING_VERSION,
    sources: {
      teacher: { filename: path.basename(options.teacher), sha256: teacherHash },
      textbook: { filename: path.basename(options.textbook), sha256: textbookHash },
    },
    teacher: teacher.facts,
    textbook: textbook.facts,
    totals: summarizeResults(results),
    safety: {
      sourceWorkbooksModified: false,
      rawReviewBodiesIncludedInReports: false,
      databaseWritesPerformed: false,
      legacyReviewsPubliclyPublished: false,
    },
  };
  const privateBundle = {
    schemaVersion: 1,
    mappingVersion: MAPPING_VERSION,
    private: true,
    sources: summary.sources,
    teachers: teacher.bundle.teachers,
    reviewCandidates: teacher.bundle.reviewCandidates,
    textbooks: textbook.bundle.textbooks,
  };
  const outputDirectory = assertPrivateOutputDirectory(options.out);
  await fs.mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outputDirectory, "preflight-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
    fs.writeFile(path.join(outputDirectory, "preflight-errors.csv"), toCsv(results), { encoding: "utf8", mode: 0o600 }),
    fs.writeFile(path.join(outputDirectory, "private-import-bundle.json"), `${JSON.stringify(privateBundle)}\n`, { encoding: "utf8", mode: 0o600 }),
  ]);
  return summary;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  runPreflight(parseArguments(process.argv.slice(2)))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`academic import preflight failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
