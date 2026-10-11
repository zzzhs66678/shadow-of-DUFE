import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applyCatalogImport, CATALOG_COLUMNS, CatalogImportError, exportCatalogRows, isSafeMaterialUrl, parseCatalogCsv, writeCatalogCsv } from '../services/auth-api/src/catalog/import-contract.mjs';

const fixture = () => ({
  catalogId: 'fixture', generatedAt: '2026-01-01T00:00:00Z', source: 'fixture',
  courses: [{ id: 'C1', title: '同名课程', college: '学院', credits: '2.00', category: '专业必修', property: '必修', textbook: '教材', publisher: '出版社', author: '作者', terms: ['fall'], teachers: ['甲老师'] }],
  schedules: [
    { id: 'M1', sectionId: 'S1', courseSequence: '01', meetingIndex: 1, courseId: 'C1', term: 'fall', title: '同名课程', teacher: '甲老师', classNames: '甲2401', weekday: 1, periods: [1, 2], block: 1, weeks: [1, 2, 3], building: '之远楼', room: '101', timeText: '1-3周 星期一 第1-2节', linked: true },
    { id: 'M2', sectionId: 'S1', courseSequence: '01', meetingIndex: 2, courseId: 'C1', term: 'fall', title: '同名课程', teacher: '甲老师', classNames: '甲2401', weekday: 3, periods: [3, 4], block: 2, weeks: [1, 2, 3], building: '体育场', room: '', timeText: '1-3周 星期三 第3-4节', linked: true },
  ],
  majors: [{ id: 'major-1', name: '甲专业', aliases: ['甲'], college: '学院' }],
  majorCourses: [{ majorId: 'major-1', year: 2, term: 'fall', courseId: 'C1' }],
  buildings: ['之远楼', '笃行楼', '书音楼', '播慧楼', '砺金楼'], publicElectives: [],
});
const newRow = (changes = {}) => ({ ...exportCatalogRows('courses', fixture())[0], 操作: '新增', 课程号: 'C2', 教学班编号: 'S2', 时段编号: 'M3', 主修班级: '甲2501', 地点: '体育场西区', ...changes });
const materialRow = (changes = {}) => ({ 操作: '新增', 资料编号: 'abcdef1234567890abcd', 标题: '复习讲义', 课程号: 'C1', 分类: '课件', 链接: '/resources/files/uploads/12345678-1234-1234-1234-123456789012.pdf', 描述: '带逗号,和\n换行', ...changes });

test('actual 5,870-meeting catalog roundtrips without altering any baseline fact', async () => {
  const base = JSON.parse(await readFile(new URL('../public/data/course-data.json', import.meta.url), 'utf8'));
  assert.equal(base.schedules.length, 5870);
  const rows = parseCatalogCsv(writeCatalogCsv(exportCatalogRows('courses', base), CATALOG_COLUMNS.courses));
  const result = applyCatalogImport('courses', rows, base);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.payload, base);
  assert.equal(result.summary.unchanged, 5881);
  assert.equal(result.payload.courses.length, 1759);
});

test('actual materials roundtrip retains previews, bytes, tags and shared associations', async () => {
  const [courseText, materialText] = await Promise.all([
    readFile(new URL('../public/data/course-data.json', import.meta.url), 'utf8'),
    readFile(new URL('../public/data/resource-manifest.json', import.meta.url), 'utf8'),
  ]);
  const courses = JSON.parse(courseText), base = JSON.parse(materialText);
  const result = applyCatalogImport('materials', parseCatalogCsv(writeCatalogCsv(exportCatalogRows('materials', base), CATALOG_COLUMNS.materials)), base, courses);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.payload, base);
  assert.deepEqual(result.changes, []);
  assert.equal(result.summary.unchanged, new Set(base.materials.map((material) => material.id)).size);
});

test('CSV handles BOM, reordered headers, quotes, commas and quoted newlines', () => {
  const row = materialRow({ 标题: '标题 "引号",逗号\n次行' });
  const reversed = [...CATALOG_COLUMNS.materials].reverse();
  const csv = writeCatalogCsv([row], reversed);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.deepEqual(parseCatalogCsv(csv), [row]);
});

test('Excel formulas and literal apostrophes are neutralized and reversed on import', () => {
  for (const dangerous of ['=1+1', '+CMD', '-10', '@SUM(A1)', '\t=1', "'literal", ' =SUM(A1)']) {
    const row = materialRow({ 标题: dangerous });
    const csv = writeCatalogCsv([row], CATALOG_COLUMNS.materials);
    assert.ok(csv.includes(`'${dangerous}`));
    assert.equal(parseCatalogCsv(csv)[0].标题, dangerous);
  }
});

test('CSV refuses duplicate/unknown/missing headers, broken quotes and extra cells', () => {
  const header = CATALOG_COLUMNS.materials.join(',');
  for (const csv of [header.replace('标题', '链接'), `${header},其他\n`, header.replace(',描述', ''), `${header}\n"未闭合`, `${header}\n"a"oops`, `${header}\na,b,c,d,e,f,g,h`]) {
    assert.throws(() => parseCatalogCsv(csv), CatalogImportError);
  }
  assert.throws(() => parseCatalogCsv('x'.repeat(8 * 1024 * 1024 + 1)), /8 MB/);
});

test('distinct course IDs retain same titles and multiple meetings retain stable IDs', () => {
  const base = fixture();
  const first = newRow(), second = newRow({ 时段编号: 'M4', 星期: '5', 节次: '3-4', 地点: '笃行楼303' });
  const result = applyCatalogImport('courses', [first, second], base);
  assert.deepEqual(result.errors, []);
  assert.equal(result.payload.courses.length, 2);
  assert.equal(result.payload.courses[1].title, base.courses[0].title);
  assert.deepEqual(result.payload.schedules.slice(2).map((meeting) => [meeting.id, meeting.sectionId, meeting.meetingIndex]), [['M3', 'S2', 1], ['M4', 'S2', 2]]);
  assert.deepEqual(base, fixture());
});

test('exact half-term, discontinuous, odd and even weeks remain distinct', () => {
  const expressions = ['1-9周', '9-18周', '1-18周', '1-3,9,17-18周', '1-18周单周', '1-18周(双周)'];
  const result = applyCatalogImport('courses', expressions.map((周次, index) => newRow({ 周次, 教学班编号: `S${index + 2}`, 时段编号: `W${index}` })), fixture());
  assert.deepEqual(result.errors, []);
  const actual = result.payload.schedules.slice(2).map((meeting) => meeting.weeks);
  assert.deepEqual(actual[0], Array.from({ length: 9 }, (_, i) => i + 1));
  assert.deepEqual(actual[1], Array.from({ length: 10 }, (_, i) => i + 9));
  assert.deepEqual(actual[2], Array.from({ length: 18 }, (_, i) => i + 1));
  assert.deepEqual(actual[3], [1, 2, 3, 9, 17, 18]);
  assert.ok(actual[4].every((week) => week % 2 === 1));
  assert.ok(actual[5].every((week) => week % 2 === 0));
});

test('new invalid/cross-block periods and invalid weeks are rejected atomically', () => {
  for (const changes of [{ 节次: '1-4' }, { 节次: '1,3' }, { 节次: '10-11' }, { 周次: '18-9周' }, { 周次: '0-4周' }, { 周次: '1-19周' }, { 周次: '19周' }, { 星期: '8' }]) {
    const base = fixture(), result = applyCatalogImport('courses', [newRow(changes)], base);
    assert.ok(result.errors.length);
    assert.deepEqual(result.payload, base);
    assert.deepEqual(result.changes, []);
  }
});

test('dated term identifiers are rejected until the public catalog supports academic years', () => {
  const result = applyCatalogImport('courses', [newRow({ 学期: '2026-2027-fall' })], fixture());
  assert.ok(result.errors.some((error) => error.field === '学期'));
  assert.deepEqual(result.payload, fixture());
});

test('partial teacher/class/sequence edits cannot split an existing teaching section', () => {
  for (const changes of [{ 教师: '乙老师' }, { 主修班级: '甲2402' }, { 课序号: '02' }]) {
    const base = fixture(), rows = exportCatalogRows('courses', base);
    const rejected = applyCatalogImport('courses', [{ ...rows[0], ...changes }], base);
    assert.ok(rejected.errors.some((error) => error.field === '教学班编号'));
    assert.deepEqual(rejected.payload, base);
    const accepted = applyCatalogImport('courses', rows.map((row) => ({ ...row, ...changes })), base);
    assert.deepEqual(accepted.errors, []);
    assert.equal(accepted.payload.schedules.length, 2);
    assert.ok(accepted.warnings.some((warning) => warning.includes('教师档案关联')));
  }
});

test('IDs cannot be reassigned or inferred from a title, and conflicting metadata is rejected', () => {
  const base = fixture(), row = exportCatalogRows('courses', base)[0];
  for (const rows of [[{ ...row, 课程号: 'C2' }], [newRow({ 时段编号: '' })], [newRow(), newRow({ 时段编号: 'M4', 课程名称: '不一致' })], [newRow(), newRow()]]) {
    const result = applyCatalogImport('courses', rows, base);
    assert.ok(result.errors.length);
    assert.deepEqual(result.payload, base);
  }
});

test('major relations are explicit additions, with no class-name guessing or baseline loss', () => {
  const base = fixture();
  const automatic = applyCatalogImport('courses', [newRow()], base);
  assert.deepEqual(automatic.payload.majorCourses, base.majorCourses);
  assert.equal(automatic.payload.schedules.at(-1).linked, false);
  const explicit = applyCatalogImport('courses', [newRow({ 专业编号: 'major-1', 年级: '3' })], base);
  assert.deepEqual(explicit.errors, []);
  assert.deepEqual(explicit.payload.majorCourses.at(-1), { majorId: 'major-1', year: 3, term: 'fall', courseId: 'C2' });
  assert.equal(explicit.payload.schedules.at(-1).linked, true);
  for (const changes of [{ 专业编号: 'major-1' }, { 专业编号: 'missing', 年级: '3' }, { 专业编号: 'major-1', 年级: '0' }, { 专业编号: 'major-1', 年级: '5' }]) assert.ok(applyCatalogImport('courses', [newRow(changes)], base).errors.length);
});

test('venues outside the five buildings are retained and never given a guessed room', () => {
  const result = applyCatalogImport('courses', [newRow({ 星期: '星期天', 地点: '体育馆·羽毛球场' })], fixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.payload.schedules.at(-1).building, '体育馆·羽毛球场');
  assert.equal(result.payload.schedules.at(-1).room, '');
  assert.equal(result.payload.schedules.at(-1).weekday, 7);
});

test('explicit deletion removes only the named existing meeting and omission preserves records', () => {
  const base = fixture(), row = exportCatalogRows('courses', base)[0];
  const patch = applyCatalogImport('courses', [row], base);
  assert.deepEqual(patch.payload, base);
  const removed = applyCatalogImport('courses', [{ ...row, 操作: '删除时段' }], base);
  assert.deepEqual(removed.errors, []);
  assert.deepEqual(removed.payload.schedules.map((item) => item.id), ['M2']);
  assert.equal(removed.summary.removed, 1);
  assert.equal(removed.payload.courses.length, 1);
  assert.ok(applyCatalogImport('courses', [{ ...row, 操作: '删除时段', 教学班编号: 'OTHER' }], base).errors.length);
});

test('new materials use explicit many-course associations and preserve no-op metadata', () => {
  const courses = fixture(); courses.courses.push({ ...courses.courses[0], id: 'C2', title: '第二课程', teachers: ['乙老师'] });
  const result = applyCatalogImport('materials', [materialRow({ 课程号: 'C1;C2' })], { schemaVersion: 2, materials: [] }, courses);
  assert.deepEqual(result.errors, []);
  const material = result.payload.materials[0];
  assert.deepEqual(material.courseIds, ['C1', 'C2']);
  assert.deepEqual(material.teachers, ['甲老师', '乙老师']);
  assert.equal(material.extension, '.pdf');
  material.sizeBytes = 123; material.catalogedAt = '2026-01-01'; material.previewable = true; material.previewUrl = '/resources/files/preview.pdf';
  const noOp = applyCatalogImport('materials', exportCatalogRows('materials', result.payload), result.payload, courses);
  assert.deepEqual(noOp.payload, result.payload);
  assert.deepEqual(noOp.changes, []);
  for (const changes of [{ 课程号: '同名课程' }, { 课程号: 'C1;missing' }, { 课程号: 'C1;C1' }, { 资料编号: 'not-stable' }]) assert.ok(applyCatalogImport('materials', [materialRow(changes)], { materials: [] }, courses).errors.length);
});

test('material path validation rejects executable schemes and deeply encoded traversal', () => {
  for (const value of ['https://example.org/file.pdf', '/resources/files/uploads/a.pdf', '/resources/files/%E8%AF%BE%E4%BB%B6/a.pdf']) assert.equal(isSafeMaterialUrl(value), true, value);
  for (const value of ['http://example.org/a.pdf', 'javascript:alert(1)', 'data:text/html,a', '//evil.org/file.pdf', '/resources/files/../a.pdf', '/resources/files/%2e%2e/a.pdf', '/resources/files/%252e%252e%252fa.pdf', '/resources/files/a%5c..%5cfile.pdf', '/resources/files/a%00.pdf', '/resources/files/%', '/resources/files/a.pdf?redirect=evil', 'https://name:password@example.org/a.pdf']) assert.equal(isSafeMaterialUrl(value), false, value);
});

test('material 下架 affects metadata only; duplicate rows and absent course catalogs reject', () => {
  const courses = fixture(), first = applyCatalogImport('materials', [materialRow()], { materials: [] }, courses).payload;
  const removed = applyCatalogImport('materials', [{ ...materialRow(), 操作: '下架' }], first, courses);
  assert.deepEqual(removed.errors, []);
  assert.deepEqual(removed.payload.materials, []);
  assert.equal(removed.summary.removed, 1);
  assert.ok(removed.warnings.length);
  assert.ok(applyCatalogImport('materials', [materialRow(), materialRow()], first, courses).errors.length);
  assert.ok(applyCatalogImport('materials', [materialRow()], first).errors.length);
});

test('legacy duplicate material IDs are preserved until an explicit reviewed edit', () => {
  const courses = fixture(); courses.courses.push({ ...courses.courses[0], id: 'C2' });
  const material = applyCatalogImport('materials', [materialRow()], { materials: [] }, courses).payload.materials[0];
  const base = { materials: [material, { ...material, courseIds: ['C2'], downloadUrl: '/resources/files/legacy-copy.pdf', description: '历史课程资料' }] };
  const exported = exportCatalogRows('materials', base);
  assert.equal(exported.length, 1);
  assert.equal(exported[0].课程号, 'C1;C2');
  const noOp = applyCatalogImport('materials', exported, base, courses);
  assert.deepEqual(noOp.errors, []);
  assert.deepEqual(noOp.payload, base);
  const unrelated = applyCatalogImport('materials', [materialRow({ 资料编号: '1234567890abcdef1234' })], base, courses);
  assert.deepEqual(unrelated.payload.materials.slice(0, 2), base.materials);
  const edited = applyCatalogImport('materials', [{ ...exported[0], 标题: '合并后资料' }], base, courses);
  assert.deepEqual(edited.errors, []);
  assert.equal(edited.payload.materials.length, 1);
  assert.deepEqual(edited.payload.materials[0].courseIds, ['C1', 'C2']);
  assert.equal(edited.changes[0].before.entries.length, 2);
  assert.ok(edited.warnings.length);
});

test('row limits, bounded errors, blank rows and unknown object columns are enforced', () => {
  const base = fixture();
  assert.ok(applyCatalogImport('courses', Array.from({ length: 10001 }, () => ({})), base).errors.length);
  const invalid = applyCatalogImport('courses', Array.from({ length: 200 }, () => ({ 课程名称: 'bad' })), base);
  assert.equal(invalid.errors.length, 100);
  assert.deepEqual(invalid.payload, base);
  const withBlank = applyCatalogImport('courses', [{}, newRow()], base);
  assert.deepEqual(withBlank.errors, []);
  assert.ok(applyCatalogImport('courses', [newRow({ 不存在的列: 'bad' })], base).errors.length);
  const csv = writeCatalogCsv(Array.from({ length: 10001 }, () => materialRow()), CATALOG_COLUMNS.materials);
  assert.throws(() => parseCatalogCsv(csv), /10,000/);
});
