import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '11111111-1111-4111-8111-111111111111', KEY = 'dufesh.mini.account.v1';
function environment() {
  for (const lib of ['account', 'api', 'catalog', 'cloud-view', 'store', 'planner', 'course-entry']) delete require.cache[require.resolve('../dist/lib/' + lib + '.js')];
  const memory = new Map(), writes = [], modals = [], calls = [];
  globalThis.wx = { getStorageSync: k => memory.get(k) || '', setStorageSync: (k, v) => { memory.set(k, structuredClone(v)); writes.push(k); },
    removeStorageSync: k => memory.delete(k), showModal: o => modals.push(o), showToast: () => {},
    navigateTo: () => {}, switchTab: () => {}, disableAlertBeforeUnload: () => {}, enableAlertBeforeUnload: () => {} };
  const catalog = require('../dist/lib/catalog.js'), c = catalog.getCatalog(), api = require('../dist/lib/api.js');
  const user = { id: A, username: 'new-student', displayName: 'momo' };
  let capability = { wechatLogin: false, wechatBinding: false };
  api.request = async (p, o = {}) => {
    calls.push({ p, ...o });
    if (p.endsWith('/login')) return { authenticated: true, user, deviceToken: 'd'.repeat(43),
      session: { accessToken: 'A'.repeat(43), expiresAt: new Date(Date.now() + 3600000).toISOString() } };
    if (p.endsWith('/session')) return { authenticated: true, user, wechatLinked: true };
    if (p.endsWith('/snapshot')) return { revision: 0, state: null, updatedAt: null };
    if (p.endsWith('/capabilities')) return capability;
    if (p === '/api/catalog/current') return { courses: { fullUrl: '/api/catalog/releases/' + 'a'.repeat(64) + '/full' } };
    if (p.startsWith('/api/catalog/releases/')) return structuredClone(c);
    if (p.endsWith('/logout')) return {};
    throw new Error('Unexpected fixture endpoint');
  };
  const account = require('../dist/lib/account.js');
  return { memory, writes, modals, calls, c, api, account, setCapability: value => { capability = value; } };
}
function page(name) {
  let p; const dist = path.join(root, 'dist/pages', name, 'index.js');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/pages', name, 'index.js'), 'utf8'),
    { require: createRequire(dist), wx, Page: value => { p = value; }, setTimeout, clearTimeout });
  p.data = structuredClone(p.data); p.setData = patch => Object.assign(p.data, patch); p.onLoad?.({}); p.onShow(); return p;
}
test('新网站账号的revision0/null快照正常通过账号、首页、课表、安排和我的；不伪造方案或覆盖本机', async () => {
  const e = environment(), store = require('../dist/lib/store.js'), planner = require('../dist/lib/planner.js');
  store.addSections(e.c, [e.c.sections.find(s => s.term === 'fall').id]);
  planner.upsert({ id: 'local-only', kind: 'task', title: '本机作业', notes: '', date: '2026-10-13', courseId: '', completed: false });
  const localBefore = structuredClone([...e.memory]);
  await e.account.login('new-student', 'SyntheticPassword!'); const snapshot = await e.account.refresh(), writeCount = e.writes.length;
  assert.equal(snapshot.sourceSnapshot.state, null); assert.equal(snapshot.revision, 0); assert.equal(snapshot.plans.length, 0);
  const pages = ['account', 'home', 'timetable', 'planner', 'me'].map(page), [account, home, timetable, arrangements, me] = pages;
  await Promise.resolve();
  assert.equal(account.data.emptyWebsiteState, true); assert.equal(account.data.ready, true); assert.equal(account.data.plans, 0);
  assert.equal(home.data.readOnly, true); assert.equal(home.data.cloudReady, true); assert.equal(home.data.hasTimetable, false);
  assert.equal(home.data.agenda.length, 0); assert.equal(home.data.tasks.length, 0);
  assert.equal(timetable.data.readOnly, true); assert.equal(timetable.data.ready, true); assert.equal(timetable.data.plans.length, 0);
  assert.equal(timetable.data.selectedCount, 0); assert.equal(timetable.data.grid.flatMap(r => r.days).flatMap(d => d.meetings).length, 0);
  timetable.termChange({ detail: { value: 1 } }); assert.equal(timetable.data.term, 'spring'); assert.equal(timetable.data.plans.length, 0);
  assert.equal(arrangements.data.readOnly, true); assert.equal(arrangements.data.rows.length, 0);
  assert.equal(me.data.count, 0); assert.equal(me.data.tasks, 0); assert.equal(me.data.events, 0);
  assert.equal(e.modals.length, 0); assert.equal(e.writes.length, writeCount);
  assert.deepEqual([...e.memory].filter(([key]) => key !== KEY), localBefore);
  assert.ok(!e.calls.some(c => c.method === 'PUT' || c.p.endsWith('/sync')));
  pages.forEach(p => p.onUnload?.());
  await e.account.logout(); assert.deepEqual([...e.memory], localBefore);
});
test('微信能力关闭或重新核查期间立即隐藏旧入口，隐藏页面的迟到能力响应不重新开放入口', async () => {
  const e = environment(); await e.account.login('new-student', 'SyntheticPassword!'); await e.account.refresh();
  e.setCapability({ wechatLogin: true, wechatBinding: true });
  const p = page('account'); await Promise.resolve(); await Promise.resolve();
  assert.equal(p.data.wechatAvailable, true); assert.equal(p.data.wechatLinked, true); p.onHide();
  const normal = e.api.request; let resolveCapability;
  e.api.request = (path, options) => path.endsWith('/capabilities') ? new Promise(resolve => { resolveCapability = resolve; }) : normal(path, options);
  p.onShow(); assert.equal(p.data.wechatAvailable, false); assert.equal(p.data.wechatBindingAvailable, false);
  resolveCapability({ wechatLogin: false, wechatBinding: false }); await Promise.resolve(); await Promise.resolve();
  assert.equal(p.data.wechatAvailable, false); assert.equal(p.data.wechatLinked, true);
  p.onHide(); p.onShow(); p.onHide(); resolveCapability({ wechatLogin: true, wechatBinding: true });
  await Promise.resolve(); await Promise.resolve(); assert.equal(p.data.wechatAvailable, false); assert.equal(p.data.wechatBindingAvailable, false);
  p.onUnload();
});
