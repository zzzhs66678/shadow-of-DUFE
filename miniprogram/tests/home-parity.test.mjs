import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const domain = require('../src/lib/domain.js'), planner = require('../src/lib/planner.js');
const source = fs.readFileSync(path.join(root, 'src/pages/home/index.js'), 'utf8');
const tap = dataset => ({ currentTarget: { dataset } });
function meeting(id, patch = {}) {
  return { id, sectionId: id, courseId: 'course-' + id, title: '课程' + id, teacher: '教师' + id, term: 'fall',
    weekday: 2, periods: [3], block: 2, weeks: [7], room: '101', building: '之远楼', ...patch };
}
function environment(patch = {}, time = '2026-10-13T02:41:00Z') {
  let state = { term: 'fall', readOnly: false, ready: true, hasAcademic: false, sectionCount: 1, maximumWeek: 18,
    meetings: [], settings: { mode: 'auto', week: 1, startDate: '2026-08-31' }, ...patch };
  let milliseconds = Date.parse(time), error = null, instance;
  const routes = [], pendingQueries = [], listeners = new Set(), localTasks = [], toggles = [];
  const catalog = { courseById: new Map() };
  const libs = {
    '../../lib/catalog': { getCatalog: () => catalog }, '../../lib/domain': domain,
    '../../lib/planner': { ...planner, load: () => ({ items: localTasks }), toggle: id => toggles.push(id) },
    '../../lib/campus-links': { copy: () => {} },
    '../../lib/ui': { safely: fn => { try { return fn(); } catch (err) { error = err; return null; } },
      termLabel: term => term === 'fall' ? '上学期' : '下学期', detail: (id, term, exactId) => routes.push([id, term, exactId]) },
    '../../lib/account': { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
    '../../lib/cloud-view': { read: () => state, todaySummary: () => ({ events: state.events || [],
      tasks: (state.readOnly ? state.state?.assignments || [] : localTasks).filter(t => !t.completed)
        .map(t => ({ ...t, date: t.date || t.dueDate, dueLabel: '今天截止' })).slice(0, 3) }),
      examSummary: () => ({ exams: state.exams || [], examCount: state.exams?.length || 0, examNotice: '' }) },
    '../../lib/course-entry': { setQuery: query => pendingQueries.push(query) }
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [milliseconds])); } static now() { return milliseconds; } }
  vm.runInNewContext(source, { require: name => { assert.ok(libs[name], name); return libs[name]; }, Date: Clock,
    wx: { navigateTo: o => routes.push(o.url), switchTab: o => routes.push(o.url) }, Page: value => { instance = value; } });
  instance.data = structuredClone(instance.data); instance.setData = patch => Object.assign(instance.data, patch); instance.onShow();
  return { p: instance, routes, toggles, pendingQueries, catalog, localTasks, error: () => error,
    setState: next => { state = next; for (const fn of listeners) fn(); }, setTime: next => { milliseconds = Date.parse(next); instance.refresh(); } };
}
test('首页按实际小节排序和结束时间区分正在上课，已下课不延长到整个大节', () => {
  const e = environment({ meetings: [meeting('next', { periods: [4] }), meeting('ended', { periods: [3] })] });
  assert.equal(e.error(), null); assert.equal(e.p.data.primary.id, 'next'); assert.equal(e.p.data.primaryLabel, '接下来');
  assert.equal(e.p.data.primary.blockTime, '10:45–11:30'); assert.equal(e.p.data.agenda[0].id, 'ended');
  assert.equal(e.p.data.agenda[0].past, true); assert.equal(e.p.data.agenda[1].past, false);
  e.setTime('2026-10-13T02:50:00Z'); assert.equal(e.p.data.primaryLabel, '正在上课');
  e.p.onUnload();
});
test('首页向后查看七天仍使用对应周集合，跨周不把前九周课移到后九周', () => {
  const e = environment({ meetings: [meeting('expired', { weekday: 1, periods: [1], weeks: [7] }),
    meeting('future', { weekday: 1, periods: [3], weeks: [8] }), meeting('another-term', { term: 'spring', weekday: 3 })] }, '2026-10-18T13:00:00Z');
  assert.equal(e.p.data.week, 7); assert.equal(e.p.data.primary.id, 'future');
  assert.equal(e.p.data.primary.nextDate, '2026-10-19'); assert.equal(e.p.data.primaryLabel, '下一节课 · 周一');
  assert.equal(e.p.data.meetings.length, 0); e.p.open(tap({ id: 'future' }));
  assert.deepEqual(e.routes.at(-1), ['course-future', 'fall', 'future']); e.p.onUnload();
});
test('手动周不假装当前上课，未确认的小节时间只保留原节次，30周照原数据读取', () => {
  const manual = environment({ settings: { mode: 'manual', week: 7 }, meetings: [meeting('selected')] });
  assert.equal(manual.p.data.primaryLabel, '所选周课程'); assert.equal(manual.p.data.manual, true); manual.p.onUnload();
  const unknown = environment({ readOnly: true, meetings: [meeting('late', { periods: [11, 14] })] });
  assert.equal(unknown.p.data.primaryLabel, '今日课程 · 时间待确认'); assert.equal(unknown.p.data.primary.blockTime, '');
  assert.equal(unknown.p.data.primary.periodLabel, '11、14节'); unknown.p.onUnload();
  const extended = environment({ maximumWeek: 30, readOnly: true, meetings: [meeting('week19', { weeks: [19] })] }, '2027-01-05T02:00:00Z');
  assert.equal(extended.p.data.week, 19); assert.equal(extended.p.data.primary.id, 'week19'); extended.p.onUnload();
});
test('今日时间线保留全部今日未完成作业，前三项摘要不截断安排，云端只读', () => {
  const date = '2026-10-13', assignments = Array.from({ length: 4 }, (_, n) => ({ id: 'task' + n, title: '作业' + n, dueDate: date, completed: false, courseId: '' }));
  const e = environment({ readOnly: true, meetings: [meeting('lesson')], state: { assignments: [...assignments,
    { id: 'done', title: '完成', dueDate: date, completed: true }, { id: 'later', title: '下周', dueDate: '2026-10-20', completed: false }] } });
  assert.equal(e.p.data.tasks.length, 3); assert.equal(e.p.data.agenda.filter(a => a.kind === 'task').length, 4);
  e.p.complete(tap({ id: 'task0' })); assert.equal(e.toggles.length, 0);
  e.p.open(tap({ id: 'lesson' })); assert.equal(e.routes.at(-1), '/pages/cloud-detail/index?id=lesson&term=fall');
  e.p.settings(); assert.equal(e.routes.at(-1), '/pages/account/index'); e.p.onUnload();
});
test('权威空课表显示课后状态，切号刷新失败或隐藏即清除私人课程考试安排', () => {
  const e = environment({ readOnly: true, hasAcademic: true, sectionCount: 0 });
  assert.equal(e.p.data.hasTimetable, true); assert.equal(e.p.data.primary, null);
  const state = { term: 'fall', readOnly: true, ready: true, sectionCount: 1, maximumWeek: 18,
    settings: { mode: 'auto', startDate: '2026-08-31' }, meetings: [meeting('private')],
    state: { assignments: [{ id: 'private-task', title: '私人作业', dueDate: '2026-10-13', completed: false }] },
    exams: [{ id: 'private-exam', title: '私人考试', seat: '18' }] };
  e.setState(state); assert.equal(e.p.data.exams[0].seat, '18'); assert.ok(e.p.data.agenda.length);
  e.setState({ ...state, meetings: null }); assert.ok(e.error()); assert.equal(e.p.data.agenda.length, 0);
  assert.equal(e.p.data.primary, null); assert.equal(e.p.data.exams.length, 0);
  e.setState(state); e.p.onHide(); assert.equal(e.p.data.meetings.length, 0); assert.equal(e.p.data.tasks.length, 0);
  assert.equal(e.p.data.exams.length, 0); assert.equal(e.p.data.primary, null); e.p.onUnload();
});
test('首页紧凑搜索入口直接打开课程检索，手输筛选留在课程页，不写个人课表', () => {
  const e = environment({ sectionCount: 0 }); e.p.search();
  assert.deepEqual(e.pendingQueries, ['']); assert.equal(e.routes.at(-1), '/pages/courses/index');
  assert.equal(e.p.searchInput, undefined);
  e.p.courses(); assert.equal(e.pendingQueries.at(-1), ''); assert.equal(e.toggles.length, 0); e.p.onUnload();
});
