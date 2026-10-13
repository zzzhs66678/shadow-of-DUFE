import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readWebsiteFile } from '../scripts/website-source.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const domain = require('../src/lib/domain.js');
const codec = require('../src/lib/codec.js');
const store = require('../dist/lib/store.js');
const { getCatalog } = require('../dist/lib/catalog.js');
const catalogue = getCatalog();
const original = JSON.parse(readWebsiteFile('public/data/course-data.json'));
const meeting = (overrides = {}) => ({ id: 'a', sectionId: 'section-a', courseId: '01', title: '课程', teacher: '教师',
  term: 'fall', weekday: 1, block: 1, periods: [1, 2], weeks: [1, 2], classNames: '甲班', building: '之远楼', room: '101', ...overrides });

test('全量公开目录压缩往返，保留身份、所有时段、实际周次与节次', () => {
  const result = codec.decode(codec.encode(original));
  assert.equal(result.catalogId, original.catalogId);
  assert.equal(result.courses.length, 1759);
  assert.equal(result.schedules.length, 5870);
  const keys = [...codec.STRING_FIELDS, 'term', 'weekday', 'block', 'weeks', 'periods'];
  original.schedules.forEach((source, i) => { for (const key of keys) assert.deepEqual(result.schedules[i][key], source[key], source.id + ':' + key); });
  original.courses.forEach((source, i) => { for (const key of [...codec.COURSE_FIELDS, 'terms']) assert.deepEqual(result.courses[i][key], source[key] || '', source.id + ':' + key); });
  assert.equal(catalogue.sections.length, new Set(original.schedules.map(m => m.sectionId)).size);
});
test('同名不同课程、同一课程不同教学班和同班多个时段分别保存', () => {
  const records = [meeting(), meeting({ id: 'a2', weekday: 3 }), meeting({ id: 'b', sectionId: 'section-b', teacher: '另一教师' }), meeting({ id: 'c', sectionId: 'section-c', courseId: '02' })];
  const groups = domain.groupSections(records);
  assert.equal(groups.length, 3); assert.equal(groups[0].meetings.length, 2);
  assert.equal(groups[2].courseId, '02');
});
test('班级导入只匹配明确的完整班级，保留同班全部时段，未选择不猜测', () => {
  const records = [meeting({ classNames: '甲班、乙班' }), meeting({ id: 'a2', classNames: '甲班', weekday: 3 }), meeting({ id: 'b', sectionId: 'b', classNames: '甲班1' })];
  assert.deepEqual(domain.classSectionIds(records, 'fall', ''), []);
  assert.deepEqual(domain.classSectionIds(records, 'fall', '甲'), []);
  assert.deepEqual(domain.classSectionIds(records, 'spring', '甲班'), []);
  assert.deepEqual(domain.classSectionIds(records, 'fall', '甲班'), ['section-a']);
});
test('冲突需要同学期、同一天、有效周交集与实际节次交集', () => {
  const a = meeting({ weeks: [1, 2, 9], periods: [3, 4], block: 2 });
  assert.equal(domain.conflict(a, meeting({ weeks: [9, 10], periods: [4, 5] })), true);
  assert.equal(domain.conflict(a, meeting({ weeks: [10, 11], periods: [3, 4] })), false);
  assert.equal(domain.conflict(a, meeting({ weeks: [9], periods: [5, 6], block: 2 })), false);
  assert.equal(domain.conflict(a, meeting({ term: 'spring', weeks: [9], periods: [4] })), false);
  assert.equal(domain.conflict(a, meeting({ weekday: 2, weeks: [9], periods: [4] })), false);
});
test('1–9、9–18与1–18周保持不同；空周和学期之外不展示上课', () => {
  const records = [meeting({ weeks: [1, 9] }), meeting({ id: 'b', sectionId: 'b', weeks: [9, 18] }), meeting({ id: 'c', sectionId: 'c', weeks: [1, 9, 18] })];
  const ids = ['section-a', 'b', 'c'];
  assert.equal(domain.dayMeetings(records, ids, 'fall', 1, 1).length, 2);
  assert.equal(domain.dayMeetings(records, ids, 'fall', 9, 1).length, 3);
  assert.equal(domain.dayMeetings(records, ids, 'fall', 18, 1).length, 2);
  assert.equal(domain.dayMeetings(records, ids, 'fall', null, 1).length, 0);
  assert.equal(domain.dayMeetings(records, ids, 'fall', 19, 1).length, 0);
  assert.equal(domain.formatWeeks([1, 2, 4, 9, 10, 18]), '1–2、4、9–10、18周');
});
test('空教室按实际节次及周次推算，同名教室按楼区分，只使用已知房间', () => {
  const records = [meeting({ periods: [4], block: 1 }), meeting({ id: 'b', building: '笃行楼', weeks: [3] }), meeting({ id: 'c', room: '102', weekday: 2 }), meeting({ building: '体育馆', room: '101' })];
  const options = { buildings: ['之远楼', '笃行楼'], term: 'fall', week: 1, weekday: 1, block: 2 };
  const rooms = domain.classroomAvailability(records, options);
  assert.equal(rooms.length, 3);
  assert.equal(rooms.find(r => r.building === '之远楼' && r.room === '101').free, false);
  assert.equal(rooms.find(r => r.building === '笃行楼').free, true);
  assert.equal(rooms.find(r => r.room === '102').free, true);
  assert.equal(domain.classroomAvailability(records, { ...options, block: 1 }).every(r => r.free), true);
});
test('北京时间与教学周边界，假期不夹到第1或18周，无开学日期不猜', () => {
  assert.equal(domain.chinaDate(new Date('2026-08-30T16:00:00Z')), '2026-08-31');
  assert.equal(domain.weekdayOf('2026-08-31'), 1);
  assert.ok(Number.isNaN(domain.dateNumber('2026-02-30')));
  assert.equal(domain.teachingWeek({ mode: 'auto', startDate: '' }).week, null);
  const s = { mode: 'auto', startDate: '2026-08-31' };
  assert.equal(domain.teachingWeek(s, new Date('2026-08-30T15:59:59Z')).state, 'before');
  assert.equal(domain.teachingWeek(s, new Date('2026-08-30T16:00:00Z')).week, 1);
  assert.equal(domain.teachingWeek(s, new Date('2026-09-06T16:00:00Z')).week, 2);
  assert.equal(domain.teachingWeek(s, new Date('2027-01-03T16:00:00Z')).state, 'after');
});

function environment({ confirm = true, failWrite = false } = {}) {
  const memory = new Map(), modals = [], toasts = [], navigation = [];
  globalThis.wx = {
    getStorageSync: key => memory.get(key) || '',
    setStorageSync: (key, value) => { if (failWrite) throw new Error('disk full'); memory.set(key, structuredClone(value)); },
    removeStorageSync: key => memory.delete(key),
    showModal: options => { modals.push(options); if (options.success) options.success({ confirm, cancel: !confirm }); },
    showToast: options => toasts.push(options),
    navigateTo: options => navigation.push(options), switchTab: options => navigation.push(options)
  };
  return { memory, modals, toasts, navigation };
}
function page(name, options = {}) {
  const filename = path.join(root, 'dist/pages', name, 'index.js');
  let definition;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: createRequire(filename), Page: value => { definition = value; }, wx: globalThis.wx, setTimeout, clearTimeout }, { filename });
  definition.data = structuredClone(definition.data);
  definition.setData = patch => { Object.assign(definition.data, patch); };
  if (definition.onLoad) definition.onLoad(options);
  if (definition.onShow) definition.onShow();
  return definition;
}
test('原生页面流程：搜索教师→课程→加入完整教学班→重开读取→删除全部时段', () => {
  const env = environment();
  const s = catalogue.sections.find(s => s.term === 'fall' && s.meetings.length > 1 && catalogue.courseById.has(s.courseId));
  const courses = page('courses'); courses.setData({ query: s.teacher }); courses.search();
  assert.ok(courses.data.rows.some(row => row.id === s.courseId) || courses.results.some(row => row.id === s.courseId));
  const detail = page('detail', { id: s.courseId, term: 'fall' });
  detail.add({ currentTarget: { dataset: { id: s.id } } });
  assert.equal(env.toasts.at(-1).title, '已加入课表');
  const state = store.load(catalogue); assert.deepEqual(state.sectionIds, [s.id]);
  detail.add({ currentTarget: { dataset: { id: s.id } } }); assert.equal(store.load(catalogue).sectionIds.length, 1);
  const timetable = page('timetable');
  const m = s.meetings[0]; timetable.setData({ weekIndex: m.weeks[0] - 1, weekday: m.weekday }); timetable.refresh();
  assert.ok(timetable.data.meetings.some(row => row.id === m.id));
  for (const n of s.meetings) assert.equal(domain.dayMeetings(catalogue.schedules, state.sectionIds, 'fall', n.weeks[0], n.weekday).some(row => row.id === n.id), true);
  timetable.remove({ currentTarget: { dataset: { section: s.id } } });
  assert.deepEqual(store.load(catalogue).sectionIds, []);
});
test('冲突确认取消不写入，确认才合并；写入失败不报告成功', () => {
  const s = catalogue.sections.find(s => s.term === 'fall' && catalogue.courseById.has(s.courseId));
  const other = catalogue.sections.find(n => n.id !== s.id && n.meetings.some(m => s.meetings.some(a => domain.conflict(a, m))));
  assert.ok(other);
  let env = environment({ confirm: false }); store.addSections(catalogue, [other.id]);
  page('detail', { id: s.courseId }).add({ currentTarget: { dataset: { id: s.id } } });
  assert.deepEqual(store.load(catalogue).sectionIds, [other.id]); assert.equal(env.modals[0].title, '上课时间有冲突');
  env = environment(); store.addSections(catalogue, [other.id]);
  page('detail', { id: s.courseId }).add({ currentTarget: { dataset: { id: s.id } } });
  assert.ok(store.load(catalogue).sectionIds.includes(s.id));
  env = environment({ failWrite: true });
  page('detail', { id: s.courseId }).add({ currentTarget: { dataset: { id: s.id } } });
  assert.equal(env.toasts.length, 0); assert.ok(env.modals.some(m => m.content.includes('保存失败')));
});
test('明确选班预览并确认才导入，取消保持原课表', () => {
  let env = environment({ confirm: false }), p = page('classes');
  p.importClass(); assert.equal(env.memory.size, 0);
  const name = catalogue.schedules.find(m => m.term === 'fall' && m.classNames).classNames.split('、')[0];
  p.choose({ currentTarget: { dataset: { name } } }); assert.ok(p.data.sections.length);
  p.importClass(); assert.equal(env.memory.size, 0);
  env = environment(); p = page('classes'); p.choose({ currentTarget: { dataset: { name } } }); p.importClass();
  assert.deepEqual(store.load(catalogue).sectionIds, domain.classSectionIds(catalogue.schedules, 'fall', name));
});
test('设置读写、学期分离、空教室筛选、首页及说明页可运行', () => {
  environment(); const settings = page('settings');
  settings.setData({ termIndex: 1, auto: true, startDate: '2027-03-01', weekIndex: 3 }); settings.save();
  const s = store.load(catalogue); assert.equal(s.term, 'spring'); assert.equal(s.terms.spring.week, 4); assert.equal(s.terms.fall.mode, 'manual');
  const rooms = page('rooms'); assert.equal(rooms.data.termIndex, 1); assert.ok(rooms.data.blocks.length);
  rooms.change({ currentTarget: { dataset: { field: 'buildingIndex' } }, detail: { value: '1' } });
  assert.ok(rooms.data.rows.every(r => r.building === catalogue.buildings[0]));
  assert.equal(page('home').data.termLabel, '下学期'); assert.ok(page('about').data.generatedAt);
});
test('无法读取/损坏存储不覆盖，目录升级保留未识别班次，主动清除才删除', () => {
  const env = environment(); env.memory.set(store.KEY, { version: 9 });
  assert.throws(() => store.load(catalogue), /格式无法读取/); assert.equal(env.memory.get(store.KEY).version, 9);
  store.reset(); const value = store.defaults('old'); value.sectionIds = ['unknown-section']; store.save(value);
  const loaded = store.load(catalogue); assert.deepEqual(loaded.sectionIds, ['unknown-section']); assert.equal(loaded.catalogId, 'old');
  assert.equal(page('timetable').data.missing, 1);
  globalThis.wx.getStorageSync = () => { throw new Error('failed'); };
  assert.throws(() => store.load(catalogue), /无法读取/);
});
