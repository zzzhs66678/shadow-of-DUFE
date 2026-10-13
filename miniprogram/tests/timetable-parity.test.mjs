import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const domain = require('../dist/lib/domain.js');
const preview = require('../dist/lib/website-preview.js');
const cloudView = require('../dist/lib/cloud-view.js');
const tap = dataset => ({ currentTarget: { dataset } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

function environment({ sections = [] } = {}) {
  const cross = { id: 'exact/跨大节', courseId: 'c1', sectionId: 's1', title: '统计学', teacher: '甲', term: 'fall',
    weekday: 1, block: 2, periods: [4, 5], weeks: [9], building: '之远楼', room: '101', classNames: '实验一班' };
  const catalog = { schedules: [cross, { ...cross, id: 'other-day', weekday: 3, periods: [3, 4] },
    { ...cross, id: 'overlap', sectionId: 's2', teacher: '乙', periods: [4] }],
    periods: [{ time: '08:00–09:35' }, { time: '09:55–11:30' }, { time: '13:00–15:25' }, { time: '18:15–20:40' }] };
  const snapshot = { revision: 1, state: { preferredTerm: 'fall', activePlanId: 'main',
    plans: [{ id: 'main', name: '默认课表', scheduleIds: [cross.id, 'overlap', 'unknown/meeting'] },
      { id: 'alternative', name: '备用方案', scheduleIds: ['other-day'] }],
    activities: [], assignments: [], academicSnapshots: [{ id: 'official', term: 'fall', academicYear: '2026-2027',
      importedAt: '2026-10-13T00:00:00Z', sections }] } };
  let identity = { userId: A, epoch: 1 }, website = true, listener;
  const routes = [], mutations = [], modals = [];
  const account = { context: () => identity, websiteSource: () => website,
    subscribe: fn => { listener = fn; return () => { listener = null; }; } };
  const local = { source: 'local', readOnly: false, ready: true, term: 'fall', plans: [], maximumWeek: 18,
    meetings: catalog.schedules, sectionCount: 2, missing: 0, settings: { mode: 'manual', week: 1 } };
  const store = { removeSection: (_, id) => mutations.push(id) };
  const wx = { navigateTo: o => routes.push(o.url), switchTab: o => routes.push(o.url),
    showModal: o => { modals.push(o); o.success?.({ confirm: true }); } };
  const modules = { '../../lib/catalog': { getCatalog: () => catalog }, '../../lib/store': store,
    '../../lib/domain': domain, '../../lib/account': account,
    '../../lib/ui': { safely: fn => fn(), termLabel: t => t === 'spring' ? '下学期' : '上学期',
      detail: (id, term, meeting) => routes.push('local:' + id + ':' + term + ':' + meeting) },
    '../../lib/cloud-view': { read: (_, options) => website ? cloudView.deriveCloud(
      preview.acceptSnapshot(identity, identity, snapshot, catalog), options) : local } };
  let page;
  vm.runInNewContext(fs.readFileSync(new URL('../dist/pages/timetable/index.js', import.meta.url), 'utf8'),
    { require: name => modules[name], wx, Page: value => { page = value; } });
  page.data = structuredClone(page.data);
  page.setData = patch => Object.assign(page.data, patch);
  page.onShow();
  return { page, routes, mutations, modals, snapshot, notify: () => listener?.(),
    setIdentity: (userId, epoch) => { identity = { userId, epoch }; listener?.(); },
    setWebsite: value => { website = value; listener?.(); } };
}

test('教务空表保持为空，方案仅查询精确时段，缺失和部分班次不扩展、不写入', () => {
  const e = environment(), p = e.page;
  assert.equal(p.data.selectedCount, 0);
  assert.equal(p.data.hasAcademic, true);
  assert.equal(p.data.missing, 0);
  assert.equal(p.data.partial, 0);
  p.weekChange({ detail: { value: 8 } });
  p.selectPlan(tap({ plan: 'main' }));
  assert.equal(p.data.weekIndex, 8);
  assert.equal(p.data.missing, 1);
  assert.equal(p.data.partial, 1);
  assert.deepEqual(p.selectedMeetings.map(m => m.id), ['exact/跨大节', 'overlap']);
  assert.ok(!p.selectedMeetings.some(m => m.id === 'other-day'));
  p.open(tap({ id: 'exact/跨大节' }));
  assert.match(e.routes.at(-1), /id=exact%2F%E8%B7%A8%E5%A4%A7%E8%8A%82/);
  assert.match(e.routes.at(-1), /plan=main&planning=1/);
  p.remove(tap({ section: 's1' })); p.classes();
  assert.deepEqual(e.mutations, []); assert.equal(e.modals.length, 0);
  p.modeChange(tap({ mode: 'academic' }));
  assert.equal(p.selectedMeetings.length, 0); assert.equal(p.data.missing, 0);
});

test('课表冲突按实际节次判断，跨大节同一时段保留，30周/14节与周末完整展示', () => {
  const official = [{ id: 'late-section', courseName: '晚间课程', courseCode: 'C01', sectionCode: '02', teachers: ['丙', '丁'],
    meetings: [{ id: 'late-exact', weekday: 7, block: 4, periods: [11, 14], weeks: [9, 30], campus: '本部', building: '之远楼', room: '101' }] }];
  const e = environment({ sections: official }), p = e.page;
  p.weekChange({ detail: { value: 29 } });
  assert.equal(p.data.weeks.length, 30);
  assert.equal(p.data.grid[3].label, '8–14');
  assert.ok(p.data.grid[3].days.some(day => day.weekday === 7 && day.meetings.some(m => m.id === 'late-exact')));
  assert.equal(p.selectedMeetings[0].teacher, '丙 / 丁');
  p.weekChange({ detail: { value: 8 } });
  p.selectPlan(tap({ plan: 'main' }));
  assert.equal(p.data.grid[1].days[0].conflict, true);
  assert.equal(p.data.grid[2].days[0].conflict, false);
  assert.ok(p.data.grid[1].days[0].meetings.some(m => m.id === 'exact/跨大节'));
  assert.ok(p.data.grid[2].days[0].meetings.some(m => m.id === 'exact/跨大节'));
  p.toggleWeekends(); assert.equal(p.data.dayHeaders.length, 7);
  p.onUnload();
});

test('方案和读取通知保留当前查询周，切账号与网站/本机来源重置查询且不泄漏旧方案', () => {
  const e = environment(), p = e.page;
  p.weekChange({ detail: { value: 8 } });
  p.selectPlan(tap({ plan: 'alternative' }));
  e.notify();
  assert.equal(p.queryPlan, 'alternative'); assert.equal(p.data.weekIndex, 8);
  p.weekChange({ detail: { value: 99 } }); p.shiftWeek(tap({ step: 99 }));
  assert.equal(p.data.weekIndex, 8);
  p.selectPlan(tap({ plan: 'unknown' })); assert.equal(p.queryPlan, 'alternative');
  e.setIdentity(B, 2);
  assert.equal(p.queryPlan, null); assert.equal(p.planning, false); assert.equal(p.selectedMeetings.length, 0);
  e.setWebsite(false); assert.equal(p.data.readOnly, false); assert.equal(p.data.weekIndex, 0);
  e.setWebsite(true); assert.equal(p.data.readOnly, true); assert.equal(p.queryPlan, null);
  p.onHide(); assert.equal(p.data.plans.length, 0); assert.equal(p.data.academicYear, ''); assert.equal(p.selectedMeetings.length, 0);
});
