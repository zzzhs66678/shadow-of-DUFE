// Browser layout approximation of the real WXML + WXSS. This does not emulate WeChat APIs or its renderer.
// Needs the website repository's existing @playwright/test; not shipped inside the mini-program.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url), { getCatalog } = require('../dist/lib/catalog.js');
const catalogue = getCatalog(), store = require('../dist/lib/store.js');
const output = path.resolve(process.argv[2] || path.join(root, 'dist-layout-check'));
await fs.mkdir(output, { recursive: true });
const memory = new Map();
globalThis.wx = { getStorageSync: key => memory.get(key) || '', setStorageSync: (key, value) => memory.set(key, value), removeStorageSync:key=>memory.delete(key),
  showModal() {}, showToast() {},navigateTo(){},switchTab(){},request(options){options.success({statusCode:404,data:{}});} };
const state = store.defaults(catalogue.catalogId);
const planner = require('../dist/lib/planner.js');
const { chinaDate } = require('../dist/lib/domain.js');
planner.upsert({ id: 'layout-task', kind: 'task', title: '会计练习题：核对分录与计算过程', date: chinaDate(), courseId: '', completed: false, notes: '从课堂要求开始，做完后标记完成。' });
const candidates = catalogue.sections.filter(s => s.term === 'fall' && s.meetings.some(m => m.weekday === 1 && m.weeks.includes(1)) && catalogue.courseById.has(s.courseId));
state.sectionIds = candidates.slice(0, 4).map(s => s.id); store.save(state);
function load(name, options = {}) {
  const filename = path.join(root, 'dist/pages', name, 'index.js');
  let page;
  return fs.readFile(filename, 'utf8').then(code => {
    vm.runInNewContext(code, { require: createRequire(filename), Page: p => { page = p; }, wx, setTimeout, clearTimeout }, { filename });
    page.data = structuredClone(page.data); page.setData = patch => Object.assign(page.data, patch);
    page.onLoad?.(options); page.onShow?.(); return page;
  });
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const css = await fs.readFile(path.join(root, 'dist/app.wxss'), 'utf8');
const app = JSON.parse(await fs.readFile(path.join(root, 'dist/app.json'), 'utf8'));
const navigation = (await Promise.all(app.tabBar.list.map(async tab => '<div class="preview-tab"><img src="data:image/png;base64,' + (await fs.readFile(path.join(root, 'dist', tab.iconPath))).toString('base64') + '"><span>' + tab.text + '</span></div>'))).join('');
const screenshots = [];
try {
  for (const width of [320, 390]) {
    const web = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 1 });
    for (const name of ['home', 'home-empty', 'courses', 'timetable', 'rooms', 'detail', 'classes', 'settings', 'about', 'planner', 'room-detail', 'me']) {
      const savedSchedule = memory.get(store.KEY), savedPlanner = memory.get(planner.KEY);
      if (name === 'home-empty') { memory.delete(store.KEY); memory.delete(planner.KEY); }
      const instance = await load(name === 'home-empty' ? 'home' : name, { id: candidates[0].courseId, term: 'fall', building: candidates[0].meetings[0].building, room: candidates[0].meetings[0].room, week: '1' });
      if (name === 'home-empty') { memory.set(store.KEY, savedSchedule); memory.set(planner.KEY, savedPlanner); }
      if (name === 'timetable') { instance.setData({ weekday: 1 }); instance.refresh(); }
      if (name === 'courses') { instance.setData({ query: '会计' }); instance.search(); }
      if (name === 'classes') instance.choose({ currentTarget: { dataset: { name: candidates[0].classNames.split('、')[0] } } });
      if (name === 'planner') { instance.begin({ currentTarget: { dataset: { kind: 'event' } } }); instance.repeatChange({ detail: { value: true } }); }
      const template = await fs.readFile(path.join(root, 'dist/pages', name === 'home-empty' ? 'home' : name, 'index.wxml'), 'utf8');
      const pageStyles = await fs.readFile(path.join(root,'dist/pages',name === 'home-empty' ? 'home' : name,'index.wxss'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
      await web.setContent('<html lang="zh-CN"><head><meta charset="UTF-8"><style>' +
        (css+'\n'+pageStyles).replace(/^page(?=\s*\{)/m, 'body').replace(/(-?\d+(?:\.\d+)?)rpx/g, (_, value) => Number(value) * width / 750 + 'px') +
        'body{margin:0}button,input,textarea{font-family:inherit}*{box-sizing:border-box}button{display:inline-block;border:none} .preview-nav{padding:14px 18px;border-bottom:1px solid var(--dufe-line);font-size:14px;text-align:center;color:var(--dufe-muted)} .preview-tabs{display:flex;position:fixed;bottom:0;left:0;right:0;background:var(--dufe-paper-raised);border-top:1px solid var(--dufe-line);justify-content:space-around;padding:10px 0}.preview-tab{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:10px;color:var(--dufe-muted);min-width:48px}.preview-tab img{width:20px;height:20px}.page{padding-bottom:90px}</style></head><body><div class="preview-nav">冬菜之影 · 浏览器布局检查</div><main id="root"></main><nav class="preview-tabs">' + navigation + '</nav></body></html>');
      await web.evaluate(({ template, data }) => {
        const parsed = new DOMParser().parseFromString(template.replace(/<(textarea|switch)([^>]*?)\/>/g, '<$1$2></$1>'), 'text/html');
        const evaluate = (expression, scope) => Function('scope', 'with(scope){return (' + expression + ')}')(scope);
        const interpolate = (text, scope) => text.replace(/{{([\s\S]*?)}}/g, (_, expression) => {
          const value = evaluate(expression, scope); return value == null ? '' : String(value);
        });
        function siblings(nodes, scope, target) {
          let matched = false;
          for (const node of nodes) {
            if (node.nodeType === Node.TEXT_NODE) { target.appendChild(document.createTextNode(interpolate(node.textContent, scope))); continue; }
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.hasAttribute('wx:if')) { matched = Boolean(evaluate(node.getAttribute('wx:if').replace(/^{{|}}$/g, ''), scope)); if (!matched) continue; }
            else if (node.hasAttribute('wx:elif')) { if (matched) continue; matched = Boolean(evaluate(node.getAttribute('wx:elif').replace(/^{{|}}$/g, ''), scope)); if (!matched) continue; }
            else if (node.hasAttribute('wx:else')) { if (matched) continue; matched = true; }
            else matched = false;
            render(node, scope, target);
          }
        }
        function render(node, scope, target) {
          if (node.hasAttribute('wx:for')) {
            const list = evaluate(node.getAttribute('wx:for').replace(/^{{|}}$/g, ''), scope);
            list.forEach((item, index) => {
              const copy = node.cloneNode(true); copy.removeAttribute('wx:for');
              render(copy, { ...scope, [node.getAttribute('wx:for-item') || 'item']: item,
                [node.getAttribute('wx:for-index') || 'index']: index }, target);
            }); return;
          }
          if (node.tagName.toLowerCase() === 'block') { siblings([...node.childNodes], scope, target); return; }
          const name = node.tagName.toLowerCase(), tag = { view: 'div', text: 'span', picker: 'div', switch: 'input' }[name] || name;
          const element = document.createElement(tag);
          for (const attr of node.attributes) {
            if (attr.name.startsWith('wx:') || /^(bind|catch)/.test(attr.name)) continue;
            const value = interpolate(attr.value, scope);
            if (['disabled', 'checked'].includes(attr.name)) { if (value === 'true') element.setAttribute(attr.name, ''); }
            else element.setAttribute(attr.name, value);
          }
          if (name === 'switch') element.type = 'checkbox';
          siblings([...node.childNodes], scope, element); target.appendChild(element);
        }
        siblings([...parsed.body.childNodes], data, document.getElementById('root'));
      }, { template, data: instance.data });
      const size = await web.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth }));
      if (size.body > size.viewport + 1) throw new Error(name + ' 在' + width + 'px出现横向溢出：' + JSON.stringify(size));
      const filename = path.join(output, name + '-' + width + '.png');
      await web.screenshot({ path: filename, fullPage: false }); screenshots.push(filename);
      instance.onHide?.();instance.onUnload?.();
    }
    await web.close();
  }
  console.log('24项浏览器布局检查通过（320/390px，无横向溢出）；这不是微信模拟器截图。');
  console.log('截图：' + output);
} finally { await browser.close(); }
