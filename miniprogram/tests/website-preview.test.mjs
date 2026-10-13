import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const preview = require('../dist/lib/website-preview.js');
const catalog = require('../dist/lib/catalog.js').getCatalog();
const A = { userId: '11111111-1111-4111-8111-111111111111', epoch: 1 };
const B = { userId: '22222222-2222-4222-8222-222222222222', epoch: 2 };
test('新账号未保存快照保留真实null，不伪造默认方案；已保存账号的null仍拒绝',()=>{
  const original={revision:0,state:null,updatedAt:null},result=preview.acceptSnapshot(preview.readTicket(A),A,original,catalog);
  assert.deepEqual(result.sourceSnapshot,original);assert.deepEqual(result.plans,[]);assert.equal(result.activePlanId,null);
  assert.throws(()=>preview.acceptSnapshot(preview.readTicket(A),A,{...original,revision:1},catalog),/格式/);
});
const multiple = catalog.sections.find(s => s.meetings.length > 1);
const first = multiple.meetings[0], last = multiple.meetings.at(-1);
function snapshot() {
  return { revision: 9, updatedAt: '2026-10-12T00:00:00Z', state: {
    profile: { entranceYear: 2023, college: '测试学院', majorId: 'fixture', className: '测试班' },
    skipped: false, plans: [{ id: 'plan-main', name: '我的课表', scheduleIds: [first.id] },
      { id: 'plan-other', name: '另一方案', scheduleIds: [last.id, 'not-in-current-catalog'] }],
    activePlanId: 'plan-main', activities: [{ id: 'fixture-event', title: '测试安排', weekday: 1, block: 1,
      date: '2026-10-12', startTime: '08:00', endTime: '09:00', repeat: 'none', location: '', notes: '', color: 'red' }],
    assignments: [{ id: 'fixture-task', courseId: first.courseId, title: '测试作业', dueDate: '2026-10-13', notes: '', completed: false }],
    academicSnapshots: [{ schemaVersion: 1, id: 'fixture-academic', academicYear: '2026-2027', term: 'fall',
      sections: [{ id: 'unarranged', courseName: '尚未排课', meetings: [] }], exams: [{ id: 'fixture-exam', date: '' }] }],
    trainingPlan: { fixture: 'read-only-preserve-all-fields' }, favoriteRooms: ['fixture-room'], recentRooms: [],
    preferredTerm: first.term, theme: 'system', futureField: { keep: true }
  } };
}
test('云端多个课表与原始快照完整保留，选一个时段不扩成整个教学班', () => {
  const original = snapshot(), before = structuredClone(original);
  const result = preview.acceptSnapshot(preview.readTicket(A), A, original, catalog);
  assert.deepEqual(result.sourceSnapshot, before); assert.deepEqual(original, before);
  assert.equal(result.plans.length, 2); assert.equal(result.activePlanId, 'plan-main'); assert.equal(result.revision, 9);
  assert.deepEqual(result.plans[0].meetings.map(m => m.id), [first.id]);
  assert.deepEqual(result.plans[0].partialSectionIds, [multiple.id]);
  assert.deepEqual(result.plans[1].missingMeetingIds, ['not-in-current-catalog']);
  assert.equal(result.academicSnapshotCount, 1); assert.equal(result.activityCount, 1); assert.equal(result.assignmentCount, 1);
  result.sourceSnapshot.state.plans[0].scheduleIds.push('changed-preview'); result.plans[0].meetings[0].weeks.push(99);
  assert.deepEqual(original, before); assert.equal(first.weeks.includes(99), false);
});
test('同名课程与1–9、9–18、1–18周按原meeting保留，未知标识不猜替代', () => {
  const records = [
    { ...first, id: 'm1', sectionId: 's1', courseId: 'c1', title: '同名课程', weeks: [1,2,3,4,5,6,7,8,9] },
    { ...first, id: 'm2', sectionId: 's2', courseId: 'c2', title: '同名课程', weeks: [9,10,11,12,13,14,15,16,17,18] },
    { ...first, id: 'm3', sectionId: 's3', courseId: 'c3', title: '同名课程', weeks: Array.from({length:18},(_,i)=>i+1) }
  ];
  const s = snapshot(); s.state.plans[0].scheduleIds = ['m1','m2','m3','old'];
  const p = preview.acceptSnapshot(preview.readTicket(A), A, s, { schedules: records }).plans[0];
  assert.equal(p.meetings.length, 3); assert.deepEqual(p.meetings.map(m=>m.weeks), records.map(m=>m.weeks));
  assert.deepEqual(p.missingMeetingIds, ['old']);
});
test('切号、退出及A→B→A后，不接收先前请求返回的私人数据', () => {
  const ticket = preview.readTicket(A);
  assert.throws(() => preview.acceptSnapshot(ticket, B, snapshot(), catalog), /账号已切换/);
  assert.throws(() => preview.acceptSnapshot(ticket, null, snapshot(), catalog), /先登录/);
  assert.throws(() => preview.acceptSnapshot(ticket, {...A, epoch:3}, snapshot(), catalog), /账号已切换/);
  assert.throws(() => preview.readTicket({userId:'momo',epoch:1}), /先登录/);
});
test('损坏快照、未知当前方案、重复方案和无效版本不按空课表处理', () => {
  for (const change of [s=>s.revision=-1, s=>s.state.activePlanId='missing',
    s=>s.state.plans.push(s.state.plans[0]), s=>s.state.assignments=null,
    s=>s.state.plans[0].scheduleIds=[null]]) {
    const s=snapshot(); change(s);
    assert.throws(() => preview.acceptSnapshot(preview.readTicket(A), A, s, catalog), /格式无法读取/);
  }
});
test('读取与预览不调用网络或本机存储，不覆盖已上传0.1.0内容', () => {
  globalThis.wx = new Proxy({}, { get() { throw new Error('must not access wx'); } });
  const s=snapshot(); const result=preview.acceptSnapshot(preview.readTicket(A), A, s, catalog);
  assert.equal(result.userId, A.userId); assert.deepEqual(result.sourceSnapshot.state.futureField,{keep:true});
  delete globalThis.wx;
});
