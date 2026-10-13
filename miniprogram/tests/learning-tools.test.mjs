import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readWebsiteFile, release } from '../scripts/website-source.mjs';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const domain = require('../dist/lib/domain.js'), planner = require('../dist/lib/planner.js');
const store = require('../dist/lib/store.js'), search = require('../dist/lib/course-search.js');
const catalogue = require('../dist/lib/catalog.js').getCatalog();
function environment(confirm = true, failWrite = false) {
  const memory = new Map(), modals = [], toasts = [], alerts = [], routes = [];
  globalThis.wx = { getStorageSync: key => memory.get(key) || '', setStorageSync: (key, value) => {
    if (failWrite) throw new Error('storage full'); memory.set(key, structuredClone(value)); }, removeStorageSync: key => memory.delete(key),
    showModal: options => { modals.push(options); options.success?.({ confirm }); }, showToast: options => toasts.push(options),
    enableAlertBeforeUnload: options => alerts.push(options.message), disableAlertBeforeUnload: () => alerts.push('disabled'),
    navigateTo: options => routes.push(options.url), switchTab: options => routes.push(options.url) };
  return { memory, modals, toasts, alerts, routes };
}
function page(name, options = {}) {
  const file = path.join(root, 'dist/pages', name, 'index.js'); let instance;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: createRequire(file), wx, Page: value => { instance = value; }, setTimeout, clearTimeout });
  instance.data = structuredClone(instance.data); instance.setData = patch => Object.assign(instance.data, patch);
  instance.onLoad?.(options); instance.onShow?.(); return instance;
}
const event = (patch = {}) => ({ id: 'event-1', kind: 'event', title: '自习', notes: '', date: '2026-10-12', courseId: '', completed: false,
  location: '之远楼', startTime: '10:00', endTime: '11:00', repeat: 'none', repeatUntil: '', ...patch });
const task = (patch = {}) => ({ id: 'task-1', kind: 'task', title: '完成练习', notes: '', date: '2026-10-12', courseId: '', completed: false, ...patch });
const tap = data => ({ currentTarget: { dataset: data } });

test('构建来源锁定已发布提交，完整打包目录与该提交一致', () => {
  const original = JSON.parse(readWebsiteFile('public/data/course-data.json'));
  assert.equal(release.websiteCommit, 'b36b1cf0d2a5700c4bcbcec2e90e920b0e996977');
  assert.equal(require('../dist/data/release.js').websiteCommit, release.websiteCommit);
  assert.equal(catalogue.catalogId, original.catalogId);
  original.schedules.forEach((m, i) => { assert.deepEqual(catalogue.schedules[i].weeks, m.weeks); assert.deepEqual(catalogue.schedules[i].periods, m.periods); });
});
test('课程简称排序与已发布网站对全量目录及多个查询保持一致', () => {
  const ts = require('typescript'), compiledModule = { exports: {} };
  const output = ts.transpileModule(readWebsiteFile('app/course-search.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(output, { exports: compiledModule.exports, module: compiledModule });
  const courses = JSON.parse(readWebsiteFile('public/data/course-data.json')).courses;
  for (const query of ['近代史', '高财', '高数', '概统', '会计 税', '会计', '21040022', '邹乐欢', 'ＡＢＣ', '无匹配课程']) {
    for (const c of courses) assert.equal(search.scoreCourseSearch(c, query), compiledModule.exports.scoreCourseSearch(c, query), c.id + ':' + query);
  }
  assert.ok(search.scoreCourseSearch({ id: '1', title: '中国近现代史纲要' }, '近代史') >= 0);
  assert.ok(search.scoreCourseSearch({ id: '2', title: '高级财务会计' }, '高财') >= 0);
  assert.equal(search.scoreCourseSearch({ id: '3', title: '高级数学', teachers: ['财老师'] }, '高财'), -1);
});
test('整周网格保留同日冲突与跨大节时段，分周、分学期过滤', () => {
  const base = { id: 'a', sectionId: 's', title: '课程', term: 'fall', weeks: [9], periods: [4, 5], weekday: 1, building: '之远楼', room: '101' };
  const records = [base, { ...base, id: 'b', sectionId: 'b', periods: [4], title: '重叠课程' }, { ...base, id: 'c', term: 'spring' }, { ...base, id: 'd', weeks: [10] }];
  const grid = domain.weekGrid(records, 9, 'fall');
  assert.equal(grid[1].days[0].meetings.length, 2); assert.equal(grid[2].days[0].meetings.length, 1);
  assert.equal(grid[1].days[1].meetings.length, 0);
  assert.equal(domain.weekGrid(records, null, 'fall').flatMap(r => r.days).flatMap(d => d.meetings).length, 0);
});
test('课表按官网显示五天与有课周末，七天切换和周选择不遗漏课程', () => {
  environment(); const weekend = catalogue.sections.find(s => s.term === 'fall' && s.meetings.some(m => m.weekday >= 6)); assert.ok(weekend);
  store.addSections(catalogue, [weekend.id]); const p = page('timetable'), m = weekend.meetings.find(m => m.weekday >= 6);
  p.setData({ weekIndex: m.weeks[0] - 1 }); p.refresh();
  assert.equal(p.data.view, 'week'); assert.ok(p.data.grid[0].days.length >= 6); assert.ok(p.data.grid.flatMap(row => row.days).flatMap(day => day.meetings).some(row => row.id === m.id));
  assert.ok(p.data.grid[0].days.some(day => day.weekday === m.weekday));
  p.toggleWeekends(); assert.equal(p.data.weekDays.length, 7); assert.equal(p.data.grid[0].days.length, 7);
  p.setData({ weekIndex: 0 }); p.shiftWeek(tap({ step: -1 })); assert.equal(p.data.weekIndex, 0);
  p.shiftWeek(tap({ step: 1 })); assert.equal(p.data.weekIndex, 1);
  p.setData({ weekIndex: 17 }); p.shiftWeek(tap({ step: 1 })); assert.equal(p.data.weekIndex, 17);
  assert.equal(p.data.grid[0].time, catalogue.periods[0].time);
});
test('教室周表严格匹配楼、房间、学期、周，点击定位原教学班；失效时段不猜替代', () => {
  const env = environment(), m = catalogue.schedules.find(m => catalogue.courseById.has(m.courseId) && catalogue.buildings.includes(m.building));
  const p = page('room-detail', { building: encodeURIComponent(m.building), room: encodeURIComponent(m.room), term: m.term, week: String(m.weeks[0]) });
  assert.equal(p.data.building, m.building); assert.equal(p.data.room, m.room);
  assert.ok(p.meetings.some(row => row.id === m.id)); assert.ok(p.meetings.every(row => row.building === m.building && row.room === m.room && row.term === m.term && row.weeks.includes(m.weeks[0])));
  p.open(tap({ id: m.id })); assert.ok(env.routes[0].includes('meeting=' + encodeURIComponent(m.id)));
  const detail = page('detail', { id: encodeURIComponent(m.courseId), term: m.term, meeting: encodeURIComponent(m.id) }); assert.equal(detail.data.sections.length, 1); assert.equal(detail.data.sections[0].id, m.sectionId);
  detail.expand(); assert.ok(detail.data.sections.length >= 1); assert.equal(detail.data.sections[0].id, m.sectionId);
  const stale = page('detail', { id: m.courseId, term: m.term, meeting: 'does-not-exist' }); assert.equal(stale.data.staleMeeting, true); assert.equal(stale.data.sections.length, 0);
  assert.equal(page('room-detail', { building: '%E6', room: m.room, term: m.term }).meetings.length, 0);
});
test('每周日程按真实日历和起止日期，假期之外不借用教学周', () => {
  const item = event({ repeat: 'weekly', repeatUntil: '2026-10-26' });
  assert.equal(planner.occurs(item, '2026-10-12'), true); assert.equal(planner.occurs(item, '2026-10-19'), true); assert.equal(planner.occurs(item, '2026-10-26'), true);
  assert.equal(planner.occurs(item, '2026-10-13'), false); assert.equal(planner.occurs(item, '2026-10-05'), false); assert.equal(planner.occurs(item, '2026-11-02'), false);
  assert.equal(planner.occurs(item, 'invalid'), false);
  assert.equal(planner.validateItem(event({ startTime: '25:00' })), false); assert.equal(planner.validateItem(event({ endTime: '09:00' })), false);
  assert.equal(planner.validateItem(event({ repeat: 'weekly', repeatUntil: '' })), false); assert.equal(planner.validateItem(task({ date: '2026-02-30' })), false);
});
test('作业保存、重开、编辑、完成、恢复、删除均持久；清除不影响课表', () => {
  environment(); const c = catalogue.sections[0]; store.addSections(catalogue, [c.id]);
  planner.upsert(task()); planner.upsert(event()); assert.equal(planner.load().items.length, 2);
  planner.upsert(task({ title: '修改后的作业' })); assert.equal(planner.load().items.length, 2);
  planner.toggle('task-1'); assert.equal(planner.load().items.find(i => i.id === 'task-1').completed, true);
  planner.toggle('task-1'); assert.equal(planner.load().items.find(i => i.id === 'task-1').completed, false);
  planner.remove('event-1'); assert.equal(planner.load().items.length, 1); planner.reset(); assert.equal(planner.load().items.length, 0);
  assert.deepEqual(store.load(catalogue).sectionIds, [c.id]);
});
test('今日摘要按真实日历显示日程，作业按截止日期排序，已完成隐藏', () => {
  const summary = planner.todaySummary({ items: [task({ id: 'late', date: '2026-10-11' }), task({ id: 'done', completed: true }), task(), event(), event({ id: 'next', date: '2026-10-13' })] }, '2026-10-12');
  assert.deepEqual(summary.tasks.map(t => t.id), ['late', 'task-1']); assert.equal(summary.tasks[0].dueLabel, '已逾期'); assert.equal(summary.tasks[1].dueLabel, '今天截止');
  assert.equal(summary.events.length, 1);
});
test('日程页未保存取消保护、无效输入不保存、成功后首页读到并可完成', () => {
  const env = environment(false), p = page('planner'); p.begin(tap({ kind: 'task' }));
  p.field({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '写完课后练习' } }); assert.equal(p.data.dirty, true); assert.ok(env.alerts.includes('日程或作业尚未保存。'));
  p.cancel(); assert.equal(p.data.editing, true); assert.equal(p.data.draft.title, '写完课后练习');
  p.setData({ draft: { ...p.data.draft, date: '2026-02-30' } }); p.save(); assert.equal(env.memory.has(planner.KEY), false); assert.equal(env.toasts.length, 0);
  p.setData({ draft: { ...p.data.draft, date: domain.chinaDate() } }); p.save(); assert.equal(env.toasts.at(-1).title, '已保存'); assert.equal(p.data.dirty, false);
  const home = page('home'); assert.equal(home.data.tasks.length, 1); home.complete(tap({ id: home.data.tasks[0].id })); assert.equal(home.data.tasks.length, 0);
  const reopened = page('planner'); reopened.filterChange(tap({ filter: 'all' })); assert.equal(reopened.data.rows[0].completed, true);
});
test('删除取消不改数据，损坏存储与保存失败不覆盖旧内容、不报成功', () => {
  let env = environment(false); planner.upsert(task()); const p = page('planner'); p.remove(tap({ id: 'task-1' })); assert.equal(planner.load().items.length, 1);
  env.memory.set(planner.KEY, { version: 99, items: [] }); assert.throws(() => planner.load(), /格式无法读取/); assert.equal(env.memory.get(planner.KEY).version, 99);
  env = environment(true, true); const failed = page('planner'); failed.begin(tap({ kind: 'task' })); failed.setData({ draft: task() }); failed.save();
  assert.equal(env.toasts.length, 0); assert.ok(env.modals.some(m => m.content.includes('保存失败')));
});
test('小程序五入口与官网顺序一致，主色取自发布版本；图标存在且尺寸正确', () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'dist/app.json'), 'utf8'));
  assert.deepEqual(app.tabBar.list.map(tab => tab.text), ['我的课表', '空教室', '今天', '课程', '我的']);
  const website = readWebsiteFile('app/globals.css'), native = fs.readFileSync(path.join(root, 'dist/app.wxss'), 'utf8');
  for (const name of ['paper', 'paper-raised', 'paper-deep', 'ink', 'muted', 'line', 'red', 'red-deep', 'red-soft', 'pine']) {
    const pattern = new RegExp('--dufe-' + name + ':\\s*(#[a-f0-9]+)', 'i');
    assert.equal(native.match(pattern)?.[1], website.match(pattern)?.[1], name);
  }
  for (const tab of app.tabBar.list) for (const icon of [tab.iconPath, tab.selectedIconPath]) {
    const png = fs.readFileSync(path.join(root, 'dist', icon));
    assert.equal(png.readUInt32BE(16), 48); assert.equal(png.readUInt32BE(20), 48);
  }
  assert.ok(fs.readFileSync(path.join(root, 'dist/pages/home/index.wxml'), 'utf8').includes('添加你的课表'));
});
test('校园入口只复制指定公开网址，不读取用户剪贴板；失败给出反馈', () => {
  const env = environment(), copied = [];
  wx.setClipboardData = options => { copied.push(options.data); options.success(); };
  const campus = require('../dist/lib/campus-links.js'), home = page('home');
  home.copy(tap({ key: 'ginkgo' })); assert.deepEqual(copied, [campus.LINKS.ginkgo]);
  home.copy(tap({ key: 'unknown' })); assert.equal(copied.length, 1); assert.equal(env.toasts.at(-1).title, '入口链接已复制');
  wx.setClipboardData = options => options.fail(); home.copy(tap({ key: 'library' })); assert.equal(env.toasts.at(-1).title, '复制失败，请重试');
});
test('我的统计与首页添加日程入口使用当前数据，未设置学期不伪装下一节', () => {
  const env = environment(); planner.upsert(task()); planner.upsert(event());
  const me = page('me'); assert.equal(me.data.tasks, 1); assert.equal(me.data.events, 1); assert.equal(me.data.count, 0);
  const home = page('home'); assert.equal(home.data.manual, true); assert.equal(home.data.primary, null);
  home.planner(tap({ kind: 'event' })); assert.equal(env.routes.at(-1), '/pages/planner/index?kind=event');
  const editor = page('planner', { kind: 'event' }); assert.equal(editor.data.editing, true); assert.equal(editor.data.draft.kind, 'event');
  planner.toggle('task-1'); me.onShow(); assert.equal(me.data.tasks, 0);
});
