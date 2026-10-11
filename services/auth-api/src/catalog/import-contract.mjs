// Shared by the browser preview and the authoritative server import. No Node APIs.
export const CATALOG_COLUMNS = Object.freeze({
  courses: Object.freeze(['操作', '课程号', '课程名称', '开课学院', '学分', '课程类别', '课程性质', '教材', '出版社', '作者', '学期', '教学班编号', '课序号', '教师', '主修班级', '时段编号', '星期', '节次', '周次', '地点', '专业编号', '年级']),
  materials: Object.freeze(['操作', '资料编号', '标题', '课程号', '分类', '链接', '描述']),
});
const MAX_ROWS = 10000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ERRORS = 100;
const COURSE_FIELDS = { 课程名称: 'title', 开课学院: 'college', 学分: 'credits', 课程类别: 'category', 课程性质: 'property', 教材: 'textbook', 出版社: 'publisher', 作者: 'author' };
const KNOWN_BUILDINGS = ['之远楼', '笃行楼', '书音楼', '播慧楼', '砺金楼'];
const copy = (value) => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clean = (value) => String(value ?? '').trim();
const safeId = (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
const formulaPrefix = /^(?:[=+\-@\t\r']|\s+[=+\-@])/;

export class CatalogImportError extends Error {
  constructor(errors) {
    super(errors[0]?.message ?? '表格格式错误');
    this.name = 'CatalogImportError';
    this.errors = errors.slice(0, MAX_ERRORS);
  }
}

function csvError(row, message, field = '表格') {
  throw new CatalogImportError([{ row, field, message }]);
}

/** Strict CSV (comma, UTF-8, quoted multiline cells); never silently drops cells. */
export function parseCatalogCsv(text) {
  if (typeof text !== 'string') csvError(1, '请上传 UTF-8 CSV 文本');
  if (new TextEncoder().encode(text).length > MAX_BYTES) csvError(1, 'CSV 不得超过 8 MB');
  const source = text.replace(/^\uFEFF/, '');
  if (source.includes('\0')) csvError(1, 'CSV 含有无效字符');
  const records = [];
  let cells = [], cell = '', state = 'plain', logicalRow = 1;
  const pushCell = () => {
    cells.push(cell.startsWith("'") && formulaPrefix.test(cell.slice(1)) ? cell.slice(1) : cell);
    cell = '';
    state = 'plain';
  };
  const pushRow = () => {
    pushCell();
    if (cells.some((value) => clean(value))) records.push({ cells, row: logicalRow });
    cells = [];
    logicalRow += 1;
    if (records.length > MAX_ROWS + 1) csvError(logicalRow, '一次最多导入 10,000 行');
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 1; }
        else state = 'closed';
      } else cell += char;
    } else if (char === ',') pushCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      pushRow();
    } else if (state === 'closed') csvError(logicalRow, '引号闭合后只能是逗号或换行');
    else if (char === '"') {
      if (cell) csvError(logicalRow, '单元格引号必须从首字符开始');
      state = 'quoted';
    } else cell += char;
    if (cell.length > 65536) csvError(logicalRow, '单元格内容过长');
  }
  if (state === 'quoted') csvError(logicalRow, '单元格引号未闭合');
  if (cell || cells.length || state === 'closed') pushRow();
  if (!records.length) csvError(1, '表格为空，请使用下载的模板');
  const headers = records.shift().cells.map(clean);
  if (new Set(headers).size !== headers.length) csvError(1, '表头重复');
  const kind = headers.includes('资料编号') ? 'materials' : 'courses';
  const allowed = CATALOG_COLUMNS[kind];
  const unknown = headers.filter((header) => !allowed.includes(header));
  const missing = allowed.filter((header) => !headers.includes(header));
  if (unknown.length) csvError(1, `未知表头：${unknown.join('、')}`);
  if (missing.length) csvError(1, `缺少表头：${missing.join('、')}`);
  const errors = [], rows = [];
  for (const record of records) {
    if (record.cells.length !== headers.length) {
      if (errors.length < MAX_ERRORS) errors.push({ row: record.row, field: '表格', message: `此行有 ${record.cells.length} 列，应为 ${headers.length} 列` });
      continue;
    }
    rows.push(Object.fromEntries(headers.map((header, index) => [header, record.cells[index]])));
  }
  if (errors.length) throw new CatalogImportError(errors);
  return rows;
}

export function writeCatalogCsv(rows, columns) {
  if (!Array.isArray(rows) || !Array.isArray(columns)) throw new TypeError('rows 和 columns 必须是数组');
  const quote = (value) => {
    const raw = String(value ?? '');
    const protectedValue = formulaPrefix.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(protectedValue) ? `"${protectedValue.replaceAll('"', '""')}"` : protectedValue;
  };
  return `\uFEFF${[columns.map(quote).join(','), ...rows.map((row) => columns.map((column) => quote(row[column])).join(','))].join('\r\n')}\r\n`;
}

function sequenceFor(meeting) {
  if (meeting.courseSequence !== undefined) return String(meeting.courseSequence);
  if (meeting.sequence !== undefined) return String(meeting.sequence);
  const prefix = `${meeting.term}-${meeting.courseId}-`;
  const suffix = `-${meeting.sourceRow}`;
  return meeting.sourceRow && meeting.sectionId?.startsWith(prefix) && meeting.sectionId.endsWith(suffix)
    ? meeting.sectionId.slice(prefix.length, -suffix.length) : '';
}

function compactNumbers(values) {
  if (!values?.length) return '';
  const parts = [];
  let start = values[0], end = start;
  for (const value of values.slice(1)) {
    if (value === end + 1) end = value;
    else { parts.push(start === end ? `${start}` : `${start}-${end}`); start = end = value; }
  }
  parts.push(start === end ? `${start}` : `${start}-${end}`);
  return parts.join(',');
}

function courseRow(course, meeting) {
  const row = Object.fromEntries(CATALOG_COLUMNS.courses.map((column) => [column, '']));
  row.操作 = '更新'; row.课程号 = course.id;
  for (const [column, field] of Object.entries(COURSE_FIELDS)) row[column] = course[field] ?? '';
  if (meeting) Object.assign(row, {
    学期: meeting.term, 教学班编号: meeting.sectionId, 课序号: sequenceFor(meeting), 教师: meeting.teacher ?? '', 主修班级: meeting.classNames ?? '',
    时段编号: meeting.id, 星期: String(meeting.weekday), 节次: compactNumbers(meeting.periods), 周次: `${compactNumbers(meeting.weeks)}周`, 地点: `${meeting.building ?? ''}${meeting.room ?? ''}`,
  });
  return row;
}

/** Export is a patch template: blank major/year cells preserve existing relations. */
export function exportCatalogRows(kind, payload) {
  if (kind === 'materials') return [...materialGroups(payload.materials ?? []).values()].map((group) => {
    const material = group[0];
    return { 操作: '更新', 资料编号: material.id, 标题: material.name, 课程号: [...new Set(group.flatMap((item) => item.courseIds ?? []))].join(';'), 分类: material.category, 链接: material.downloadUrl, 描述: material.description ?? '' };
  });
  if (kind !== 'courses') throw new TypeError('未知目录类型');
  const courses = new Map((payload.courses ?? []).map((course) => [course.id, course]));
  const seen = new Set();
  const rows = (payload.schedules ?? []).map((meeting) => {
    const course = courses.get(meeting.courseId);
    if (!course) throw new Error(`时段 ${meeting.id} 的课程不存在`);
    seen.add(course.id);
    return courseRow(course, meeting);
  });
  for (const course of courses.values()) if (!seen.has(course.id)) rows.push(courseRow(course));
  return rows;
}

function parseNumbers(expression, limit, suffix) {
  let value = expression.replace(/[，；;]/g, ',').replace(/[–—]/g, '-').replace(/\s/g, '').replace(/^第/, '');
  let parity = '';
  if (suffix === '周') {
    const match = value.match(/(?:\(?([单双])周\)?|\(([单双])\))$/);
    if (match) { parity = match[1] ?? match[2]; value = value.slice(0, match.index); }
  }
  value = value.replace(new RegExp(`${suffix}$`), '');
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) return null;
  const numbers = new Set();
  for (const part of value.split(',')) {
    const [a, b = a] = part.split('-').map(Number);
    if (a < 1 || b > limit || a > b) return null;
    for (let number = a; number <= b; number += 1) if (!parity || number % 2 === (parity === '单' ? 1 : 0)) numbers.add(number);
  }
  return numbers.size ? [...numbers].sort((a, b) => a - b) : null;
}

function blockFor(period) { return period <= 2 ? 1 : period <= 4 ? 2 : period <= 7 ? 3 : 4; }
function periodValid(periods) { return periods?.every((value, index) => (!index || value === periods[index - 1] + 1) && blockFor(value) === blockFor(periods[0])); }
function weekdayFor(value) {
  if (/^[1-7]$/.test(value)) return Number(value);
  const match = value.match(/^(?:星期|周)([一二三四五六日天])$/);
  return match ? match[1] === '天' ? 7 : '一二三四五六日'.indexOf(match[1]) + 1 : 0;
}

function locationFor(value) {
  const building = KNOWN_BUILDINGS.find((name) => value.includes(name));
  if (!building) return { building: value, room: '' };
  const room = value.slice(value.indexOf(building) + building.length).replace(/^[（(][^）)]*[）)]/, '').trim();
  if (!/^[\dA-Za-z-]*$/.test(room)) return null;
  return { building, room };
}

/** URLs are metadata only. The server does not fetch external links. */
export function isSafeMaterialUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (value.startsWith('/resources/files/')) {
    if (/[?#]/.test(value)) return false;
    let decoded = value;
    for (let i = 0; i < 5; i += 1) {
      if (decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded) || decoded.split('/').some((part) => part === '.' || part === '..')) return false;
      let next;
      try { next = decodeURIComponent(decoded); } catch { return false; }
      if (next === decoded) return decoded.startsWith('/resources/files/') && decoded.slice('/resources/files/'.length).length > 0;
      decoded = next;
    }
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

function resultFor(base, payload, errors, warnings, changes, unchanged) {
  if (errors.length) return { payload: copy(base), summary: { added: 0, updated: 0, removed: 0, unchanged: 0 }, changes: [], errors, warnings };
  return { payload, summary: { added: changes.filter((item) => item.action === 'added').length, updated: changes.filter((item) => item.action === 'updated').length, removed: changes.filter((item) => item.action === 'removed').length, unchanged }, changes, errors, warnings };
}

function collectChanges(before, after, label, prefix = '') {
  const changes = [], old = new Map(before.map((item) => [item.id, item])), next = new Map(after.map((item) => [item.id, item]));
  for (const item of after) {
    const previous = old.get(item.id);
    if (!previous || !equal(previous, item)) changes.push({ id: `${prefix}${item.id}`, label: label(item), action: previous ? 'updated' : 'added', before: previous ?? null, after: item });
  }
  for (const item of before) if (!next.has(item.id)) changes.push({ id: `${prefix}${item.id}`, label: label(item), action: 'removed', before: item, after: null });
  return changes;
}

/** Atomic patch validation: any error returns an unchanged copy of the base. */
export function applyCatalogImport(kind, rows, base, courseCatalog) {
  const errors = [], warnings = [];
  const addError = (row, field, message) => { if (errors.length < MAX_ERRORS) errors.push({ row, field, message }); };
  if (!CATALOG_COLUMNS[kind]) throw new TypeError('未知目录类型');
  if (!base || typeof base !== 'object') throw new TypeError('缺少当前目录');
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
    addError(1, '表格', '一次最多导入 10,000 行');
    return resultFor(base, copy(base), errors, warnings, [], 0);
  }
  if (new TextEncoder().encode(JSON.stringify(rows)).length > MAX_BYTES) {
    addError(1, '表格', '表格不得超过 8 MB');
    return resultFor(base, copy(base), errors, warnings, [], 0);
  }
  const normalized = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { addError(rowNumber, '表格', '每行须为表头对应的对象'); return; }
    for (const key of Object.keys(row)) if (!CATALOG_COLUMNS[kind].includes(key)) addError(rowNumber, key, '未知表头');
    const value = Object.fromEntries(CATALOG_COLUMNS[kind].map((column) => [column, clean(row[column])]));
    if (!Object.values(value).some(Boolean)) return;
    for (const [column, text] of Object.entries(value)) if (text.length > (column === '描述' ? 4000 : column === '链接' ? 2000 : 1000)) addError(rowNumber, column, '内容过长');
    normalized.push({ value, row: rowNumber });
  });
  if (!normalized.length && !errors.length) addError(2, '表格', '没有可导入的内容');
  return kind === 'courses' ? importCourses(normalized, base, errors, warnings, addError) : importMaterials(normalized, base, courseCatalog, errors, warnings, addError);
}

function importCourses(rows, base, errors, warnings, addError) {
  const payload = copy(base), courses = new Map((payload.courses ?? []).map((item) => [item.id, item])), meetings = new Map((payload.schedules ?? []).map((item) => [item.id, item]));
  const baseMeetings = new Map((base.schedules ?? []).map((item) => [item.id, item]));
  const majors = new Set((base.majors ?? []).map((item) => item.id));
  const courseValues = new Map(), sectionValues = new Map(), seen = new Set(), touchedCourses = new Set(), affectedScheduleCourses = new Set(), relations = new Map((payload.majorCourses ?? []).map((item) => [JSON.stringify([item.majorId, item.year, item.term, item.courseId]), item]));
  let unchanged = 0;
  for (const { value: row, row: number } of rows) {
    const operation = row.操作 || '更新', id = row.课程号;
    if (!['更新', '新增', '删除时段'].includes(operation)) { addError(number, '操作', '仅支持更新、新增或删除时段'); continue; }
    if (!safeId(id)) { addError(number, '课程号', '请填写稳定的课程号（字母、数字或 . _ : -）'); continue; }
    if (operation === '删除时段') {
      const meeting = meetings.get(row.时段编号);
      if (!meeting || !baseMeetings.has(row.时段编号)) { addError(number, '时段编号', '只能删除当前目录中明确存在的时段'); continue; }
      if (meeting.courseId !== id || meeting.sectionId !== row.教学班编号 || meeting.term !== row.学期) { addError(number, '时段编号', '删除时段时课程号、教学班编号和学期须与当前记录一致'); continue; }
      if (seen.has(meeting.id)) { addError(number, '时段编号', '同一时段在文件中重复操作'); continue; }
      seen.add(meeting.id); meetings.delete(meeting.id); affectedScheduleCourses.add(id); continue;
    }
    const existingCourse = courses.get(id);
    const metadata = Object.fromEntries(Object.entries(COURSE_FIELDS).map(([column, field]) => [field, row[column]]));
    if (!metadata.title) addError(number, '课程名称', '课程名称不能为空');
    if (!/^\d+(?:\.\d+)?$/.test(metadata.credits) || Number(metadata.credits) > 100) addError(number, '学分', '学分须为 0–100 之间的数字');
    if (courseValues.has(id) && !equal(courseValues.get(id), metadata)) addError(number, '课程号', '同一课程的目录字段必须一致');
    else courseValues.set(id, metadata);
    const course = existingCourse ? { ...existingCourse, ...metadata } : { id, ...metadata, terms: [], teachers: [] };
    courses.set(id, course); touchedCourses.add(id);
    const hasMeeting = ['教学班编号', '课序号', '教师', '主修班级', '时段编号', '星期', '节次', '周次', '地点'].some((field) => row[field]);
    if (!hasMeeting) {
      if (row.专业编号 || row.年级) {
        addRelations(row, number, id, majors, relations, addError);
      }
      if (equal(existingCourse, course)) unchanged += 1;
      continue;
    }
    if (!/^(?:fall|spring)$/.test(row.学期)) addError(number, '学期', '当前课程目录学期仅支持 fall（上学期）或 spring（下学期）');
    if (!safeId(row.教学班编号)) addError(number, '教学班编号', '教学班编号不能为空，须为稳定标识');
    if (!safeId(row.时段编号)) addError(number, '时段编号', '时段编号不能为空，须为稳定标识');
    if (!row.课序号 || row.课序号.length > 80) addError(number, '课序号', '请填写学校课序号');
    if (seen.has(row.时段编号)) { addError(number, '时段编号', '同一时段在文件中重复操作'); continue; }
    seen.add(row.时段编号);
    const previous = baseMeetings.get(row.时段编号);
    if (previous && (previous.courseId !== id || previous.sectionId !== row.教学班编号 || previous.term !== row.学期)) addError(number, '时段编号', '已有时段不得改挂课程、教学班或学期；请删除旧时段并新增稳定编号');
    const section = [id, row.学期, row.课序号, row.教师, row.主修班级];
    if (sectionValues.has(row.教学班编号) && !equal(sectionValues.get(row.教学班编号).value, section)) addError(number, '教学班编号', '同一教学班的课程、学期、课序号、教师和主修班级必须一致');
    else sectionValues.set(row.教学班编号, { value: section, row: number });
    const weekday = weekdayFor(row.星期), periods = parseNumbers(row.节次, 10, '节'), weeks = parseNumbers(row.周次, 18, '周'), location = locationFor(row.地点);
    if (!weekday) addError(number, '星期', '星期须为 1–7 或星期一至星期日');
    if (!periods || (!periodValid(periods) && !equal(previous?.periods, periods))) addError(number, '节次', '节次须为 1–10 的连续节次，并在同一大节内');
    if (!weeks) addError(number, '周次', '当前课程目录周次须为 1–18，可填 1-9周、1,3,5周或 1-18周单周');
    if (!row.地点 || !location) addError(number, '地点', '请填写完整地点；五栋教学楼的教室号须为字母、数字或连字符');
    if (!weekday || !periods || !weeks || !location) continue;
    const meeting = previous ? { ...meetings.get(previous.id) } : { id: row.时段编号, sectionId: row.教学班编号, meetingIndex: Math.max(0, ...[...meetings.values()].filter((item) => item.sectionId === row.教学班编号).map((item) => item.meetingIndex ?? 0)) + 1, term: row.学期, courseId: id, linked: false };
    Object.assign(meeting, { title: metadata.title, teacher: row.教师, classNames: row.主修班级, weekday, periods, weeks, ...location });
    if (!previous || sequenceFor(previous) !== row.课序号) meeting.courseSequence = row.课序号;
    if (!previous || !equal(previous.periods, periods)) meeting.block = blockFor(periods[0]);
    if (!previous || previous.weekday !== weekday || !equal(previous.periods, periods) || !equal(previous.weeks, weeks)) meeting.timeText = `${compactNumbers(weeks)}周 星期${'一二三四五六日'[weekday - 1]} 第${compactNumbers(periods)}节`;
    const relationCount = relations.size;
    addRelations(row, number, id, majors, relations, addError);
    if (!previous && (row.专业编号 || relations.size > relationCount)) meeting.linked = true;
    meetings.set(meeting.id, meeting);
    if (!equal(previous, meeting)) affectedScheduleCourses.add(id);
    if (equal(previous, meeting) && equal(existingCourse, course)) unchanged += 1;
  }
  const sectionMembers = new Map();
  for (const meeting of meetings.values()) {
    if (!sectionMembers.has(meeting.sectionId)) sectionMembers.set(meeting.sectionId, []);
    sectionMembers.get(meeting.sectionId).push(meeting);
  }
  // Compare section metadata with untouched meetings too, so partial edits cannot split a section.
  for (const [sectionId, { value, row }] of sectionValues) {
    for (const meeting of sectionMembers.get(sectionId) ?? []) {
      if (!equal([meeting.courseId, meeting.term, sequenceFor(meeting), meeting.teacher ?? '', meeting.classNames ?? ''], value)) {
        addError(row, '教学班编号', '教学班仍有未同步修改的时段；教师、主修班级和课序号应一次更新该班全部时段'); break;
      }
    }
  }
  for (const meeting of meetings.values()) {
    if (touchedCourses.has(meeting.courseId)) meeting.title = courses.get(meeting.courseId).title;
  }
  for (const id of affectedScheduleCourses) {
    const course = courses.get(id), schedules = [...meetings.values()].filter((meeting) => meeting.courseId === id);
    if (!course) continue;
    const terms = [...new Set(schedules.map((meeting) => meeting.term))], teachers = [...new Set(schedules.map((meeting) => meeting.teacher).filter(Boolean))];
    course.terms = [...(course.terms ?? []).filter((term) => terms.includes(term)), ...terms.filter((term) => !(course.terms ?? []).includes(term))];
    course.teachers = [...(course.teachers ?? []).filter((teacher) => teachers.includes(teacher)), ...teachers.filter((teacher) => !(course.teachers ?? []).includes(teacher))];
  }
  payload.courses = [...courses.values()]; payload.schedules = [...meetings.values()]; payload.majorCourses = [...relations.values()];
  const changes = [...collectChanges(base.courses ?? [], payload.courses, (item) => item.title, 'course:'), ...collectChanges(base.schedules ?? [], payload.schedules, (item) => `${item.title} · ${item.sectionId} · ${item.id}`)];
  if (changes.some((item) => item.after?.sectionId && item.action === 'updated' &&
      (item.before.teacher !== item.after.teacher || item.before.classNames !== item.after.classNames || sequenceFor(item.before) !== sequenceFor(item.after)))) {
    warnings.push('修改教师、主修班级或课序号后，该教学班不再沿用原有已核验的教师档案关联；姓名不能自动确认教师身份。');
  }
  if (changes.some((item) => item.after?.sectionId && item.action === 'added' && item.after.teacher)) {
    warnings.push('新增时段保留填写的教师姓名，教师档案入口须另经身份核验后建立。');
  }
  const baseRelations = new Set((base.majorCourses ?? []).map((item) => JSON.stringify([item.majorId, item.year, item.term, item.courseId])));
  for (const [key, relation] of relations) if (!baseRelations.has(key)) changes.push({ id: `relation:${key}`, label: `${relation.majorId} · ${relation.courseId}`, action: 'added', before: null, after: relation });
  if (changes.some((item) => item.action === 'removed')) warnings.push('删除时段会改变课程与空教室结果；已有个人课表中的旧记录不会被代替或合并。');
  return resultFor(base, payload, errors, warnings, changes, unchanged);
}

function addRelations(row, number, courseId, majors, relations, addError) {
  if (!row.专业编号 && !row.年级) return;
  if (!row.专业编号 || !/^[1-4]$/.test(row.年级) || !/^(?:fall|spring)$/.test(row.学期)) { addError(number, '专业编号', '新增专业关系必须同时填写专业编号、1–4 年级和 fall/spring 学期'); return; }
  const ids = row.专业编号.split(/[;；]/).map(clean);
  if (new Set(ids).size !== ids.length || ids.some((id) => !majors.has(id))) { addError(number, '专业编号', '专业编号不存在或重复；多个专业用分号分隔'); return; }
  for (const majorId of ids) {
    const relation = { majorId, year: Number(row.年级), term: row.学期, courseId };
    relations.set(JSON.stringify([majorId, relation.year, relation.term, courseId]), relation);
  }
}

function materialKind(extension) {
  if (extension === '.pdf') return 'PDF';
  if (['.ppt', '.pptx'].includes(extension)) return '课件';
  if (['.doc', '.docx', '.txt'].includes(extension)) return '文档';
  if (['.xls', '.xlsx', '.csv'].includes(extension)) return '表格';
  if (['.mp4', '.webm', '.mov'].includes(extension)) return '视频';
  if (['.zip', '.rar', '.7z'].includes(extension)) return '压缩包';
  return '其他';
}

function materialGroups(materials) {
  const groups = new Map();
  for (const material of materials) {
    if (!groups.has(material.id)) groups.set(material.id, []);
    groups.get(material.id).push(material);
  }
  return groups;
}

function importMaterials(rows, base, courseCatalog, errors, warnings, addError) {
  const payload = copy(base), groups = materialGroups(payload.materials ?? []), replacements = new Map(), courses = new Map((courseCatalog?.courses ?? []).map((item) => [item.id, item])), seen = new Set(), changes = [];
  let unchanged = 0;
  if (!courseCatalog?.courses) addError(1, '课程号', '缺少当前课程目录，无法校验资料关联');
  for (const { value: row, row: number } of rows) {
    const operation = row.操作 || '更新', id = row.资料编号;
    if (!['更新', '新增', '下架'].includes(operation)) { addError(number, '操作', '仅支持更新、新增或下架'); continue; }
    if (!/^[a-f0-9]{20}$/.test(id)) { addError(number, '资料编号', '资料编号须为固定 20 位小写十六进制标识'); continue; }
    if (seen.has(id)) { addError(number, '资料编号', '同一资料在文件中重复操作'); continue; }
    seen.add(id);
    const group = groups.get(id), previous = group?.[0];
    if (operation === '下架') {
      if (!group) addError(number, '资料编号', '只能下架当前目录中明确存在的资料');
      else {
        replacements.set(id, null);
        changes.push({ id, label: previous.name, action: 'removed', before: group.length > 1 ? { entries: group } : previous, after: null });
      }
      continue;
    }
    const courseIds = row.课程号.split(/[;；]/).map(clean);
    if (!row.课程号 || new Set(courseIds).size !== courseIds.length || courseIds.some((courseId) => !courses.has(courseId))) addError(number, '课程号', '所有关联课程号必须存在且不重复；多个课程用分号分隔');
    if (!row.标题) addError(number, '标题', '资料标题不能为空');
    if (!row.分类 || row.分类.length > 80) addError(number, '分类', '分类不能为空且不能超过 80 字');
    if (!isSafeMaterialUrl(row.链接)) addError(number, '链接', '链接须为 HTTPS 或 /resources/files/ 文件路径，不允许路径穿越');
    const basic = { name: row.标题, courseIds, category: row.分类, downloadUrl: row.链接, description: row.描述 };
    const projected = previous ? { ...previous, courseIds: [...new Set(group.flatMap((item) => item.courseIds ?? []))] } : null;
    if (projected && Object.entries(basic).every(([key, value]) => equal(projected[key], value))) { unchanged += 1; continue; }
    const path = row.链接.split(/[?#]/)[0], extension = path.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0]?.toLowerCase() ?? '', kind = materialKind(extension);
    const associated = courseIds.map((courseId) => courses.get(courseId)).filter(Boolean);
    const metadata = {
      courseTitle: associated.map((course) => course.title).filter((title, index, all) => all.indexOf(title) === index).join('、'),
      teachers: [...new Set(associated.flatMap((course) => course.teachers ?? []))], colleges: [...new Set(associated.map((course) => course.college).filter(Boolean))], terms: [...new Set(associated.flatMap((course) => course.terms ?? []))],
      years: [...new Set((courseCatalog?.majorCourses ?? []).filter((relation) => courseIds.includes(relation.courseId)).map((relation) => relation.year))],
    };
    const material = previous ? { ...previous, ...basic } : { id, ...metadata, ...basic, tags: [...new Set([row.分类, kind])], kind, extension, sizeBytes: 0, catalogedAt: '', previewable: false, previewUrl: '' };
    if (!previous || !equal(previous.courseIds, courseIds)) Object.assign(material, metadata);
    if (previous?.category !== row.分类) material.tags = [...new Set([row.分类, material.kind ?? kind])];
    if (previous && previous.downloadUrl !== row.链接) Object.assign(material, { kind, extension, sizeBytes: 0, previewable: false, previewUrl: '' });
    replacements.set(id, material);
    changes.push({ id, label: material.name, action: previous ? 'updated' : 'added', before: group?.length > 1 ? { entries: group } : previous ?? null, after: material });
    if (group?.length > 1) warnings.push(`资料 ${id} 原有 ${group.length} 条同编号历史记录；此次修改将合并为一份资料，关联课程以本行课程号为准。`);
  }
  const emitted = new Set();
  payload.materials = [];
  for (const material of base.materials ?? []) {
    if (!replacements.has(material.id)) payload.materials.push(copy(material));
    else if (!emitted.has(material.id)) {
      emitted.add(material.id);
      const replacement = replacements.get(material.id);
      if (replacement) payload.materials.push(replacement);
    }
  }
  for (const [id, replacement] of replacements) if (!groups.has(id) && replacement) payload.materials.push(replacement);
  if (changes.some((item) => item.action === 'removed')) warnings.push('下架只移除公开资料条目，保留服务器原文件和已有收藏的清理入口。');
  return resultFor(base, payload, errors, warnings, changes, unchanged);
}
