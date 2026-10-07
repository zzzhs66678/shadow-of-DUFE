/** Read-only source inventory. Run: node scripts/export-ui-copy.mjs [--check|--self-test] */
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'artifacts/ui-copy');
const han = /\p{Script=Han}/u;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = value => createHash('sha256').update(value).digest('hex');
// Editorial flags only: no automated rewrites or claims about who wrote the text.
const reviewNotes = new Map([
  ['课程、教室与资料关系正在抵达。', '抽象措辞：加载状态直接说明正在加载什么；“关系正在抵达”可删。'],
  ['今天学什么，去哪儿学', '重复铺垫：若旁边已有今日、课表与空教室导航，可省略这句标语。'],
  ['校园空间', '重复铺垫：与紧邻的“空教室”标题重复，可删小标题。'],
  ['课程中心 ·', '重复铺垫：页面已有“课程”标题，可仅保留学期。'],
  ['下一节在 ${…1}${…2}，先找个顺路的位置。', '空泛收尾：保留下一节地点即可，后半句可删。'],
  ['新同学抵达记录', '同义词轮换：统计注册人数时直接使用注册用语，避免“抵达”的比喻。'],
]);
const scope = [
  '仅静态源码清单，不是线上页面抓取，不包含运行时数据；未连接服务器、数据库或用户浏览器存储。',
  '扫描 Git 已跟踪以及未忽略的新文件：app、services/auth-api/src、worker、server.mjs 中 JS/TS/JSX/TSX；补充 app CSS content 及 public 法律/帮助文本。读取当前工作树，包括未提交修改；只读新文件，不改写它们。',
  '排除数据集、public/data、用户数据、评价正文、数据库、测试/样例、node_modules、docs、构建产物、历史档案、环境配置；不解析导入的数据文件。社区/教师评价界面的固定标签仍纳入。',
  '小影独立应用 xiaoying-executor 不在本次主站清单内；图片内文字、远端返回内容不纳入。纯英文/数字/符号会提取直接 JSX 文本、title/aria-label/aria-description/placeholder/alt，以及简单 JSX 显示表达式；不把 className、事件名、链接等技术属性当文案。',
  '使用 TypeScript AST 提取所有含汉字的字符串、模板和 JSX 文本，并补充上述明确展示的非中文文本，不执行源码。纯英文共享常量、复杂函数返回值可能遗漏；注释和正则不提取；CSS content 单独扫描。',
  '模板插值替换为 ${…1} 等占位符，不读取实际值，也不展开表达式源码；表达式中的中文分支另列。JSX 文本为片段，完整句子可能由多个标签/表达式拼接，必须按来源核对。',
  'original 保留解析后的字面量内容；JSX 只规范化换行缩进，实体编码可能仍为源码形式。字符串拼接、翻译函数、运行时格式化不求值。',
  '按 original 精确去重并保存全部来源。相同原文可能语境不同，建议不代表所有位置应同时替换；同一位置的多次运行不重复。',
  '分类为静态启发式，不证明用户一定能看到。源码待确认、技术键/匹配、日志和未找到路由引用的文件单列；不做函数级可达性、权限/功能开关或线上版本判断。',
  'DufeHubV2 按 AST 中实际所属函数分组：今日、课程、课表、空教室、我的、日程编辑等。共享组件与顶层常量另列；不推测共享函数只属于某个页面。每处来源保留所属函数链。',
  'suggestion 初始为空，action 为未决定；删除须明确选择。审阅页只在内存保存编辑，请下载 JSON；刷新/关闭会丢失未下载内容。导入旧稿按稳定 ID 匹配原文，不匹配项不覆盖。',
  '运行命令：node scripts/export-ui-copy.mjs；集成其他界面改动后重新生成。--check 检查产物是否与当前源码一致，--self-test 运行内置提取测试。生成器只覆盖此目录内固定命名产物，不修改源码或下载的审阅稿。',
];

function allowed(p) {
  if (/(^|\/)(?:data|datasets?|fixtures?|tests?|examples?|history|node_modules|private|secrets?)(\/|$)/i.test(p)) return false;
  if (p.endsWith('.d.ts') || /(?:\.test|\.spec)\./.test(p)) return false;
  return /^(?:app\/|services\/auth-api\/src\/|worker\/|server\.mjs$)/.test(p)
    ? /\.(?:[cm]?[jt]sx?|css)$/.test(p)
    : /^public\/(?:[^/]*\/)*(?:privacy|terms|legal|help|faq|security)[^/]*\.(?:md|txt|html)$/i.test(p);
}

function group(p, functions = []) {
  if (p === 'app/DufeHubV2.tsx') {
    const pages = { HomePage: '今日', TodayPage: '今日', CatalogPage: '课程', SchedulePage: '课表', RoomsPage: '空教室', MePage: '我的', CalendarEditor: '日程编辑', AcademicImportDialog: '教务导入', TrainingPlanWindow: '培养方案', CourseDrawer: '课程详情抽屉', Onboarding: '首次设置', SearchCommand: '全站搜索', KnowledgeTribute: '我的·知识致敬', CreatorsCorner: '幕后介绍', CampusAlmanac: '校园日历', CampusTimeMark: '校园时间', ExamRail: '共享·考试提醒', AcademicScheduleCard: '课表·课程卡', DraggableScheduleCard: '课表·课程卡', ScheduleTrash: '课表·移除课程', HubApp: '主站壳层与账号交互' };
    const owner = functions.find(name => pages[name]);
    if (owner) return pages[owner];
    return functions.length ? '共享函数·' + functions[functions.length - 1] : '主站·顶层共享常量';
  }
  if (/app\/(?:privacy|terms|account\/delete)\/|LegalPage/.test(p)) return '法律与账号注销';
  if (p.startsWith('app/admin/')) return '管理后台';
  if (p.startsWith('app/community/')) return '社区与通知';
  if (p.startsWith('app/teachers/')) return '教师';
  if (p.startsWith('app/materials/')) return '学习资料';
  if (p.startsWith('services/') || p.startsWith('worker/') || p.startsWith('app/api/') || p === 'server.mjs') return '后端与邮件';
  if (p.startsWith('public/')) return '静态法律与帮助';
  return '主站与共享组件';
}

function category(node, sf, p) {
  const ancestors = [];
  for (let a = node.parent; a && ancestors.length < 7; a = a.parent) ancestors.push(a);
  if (ancestors.some(a => ts.isCallExpression(a) && /^console\./.test(a.expression.getText(sf)))) return '源码：日志';
  if (ts.isLiteralTypeNode(node.parent) || (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
    || ts.isElementAccessExpression(node.parent)
    || (ts.isBinaryExpression(node.parent) && /^(?:===?|!==?)$/.test(node.parent.operatorToken.getText(sf)))
    || ancestors.some(a => ts.isCallExpression(a) && /\.(?:includes|startsWith|endsWith|replace|match|indexOf)$/.test(a.expression.getText(sf)))) return '源码：技术键或匹配词';
  if (/mail-delivery/.test(p)) return '邮件固定模板';
  if (/privacy|terms|account\/delete|LegalPage/.test(p)) return '法律与帮助';
  if (ts.isJsxText(node)) return '界面：JSX 文本片段';
  if (ancestors.some(ts.isJsxAttribute)) return '界面：属性或无障碍标签';
  if (ancestors.some(ts.isJsxExpression)) return '界面：表达式分支';
  if (ancestors.some(a => (ts.isNewExpression(a) || ts.isCallExpression(a)) && /(?:Error|error|set\w*(?:Error|Message|Notice|Status)|alert|confirm|toast)/i.test(a.expression.getText(sf)))
    || ancestors.some(a => ts.isPropertyAssignment(a) && /^(?:message|error|detail|reason)$/.test(a.name.getText(sf)))) return '提示与错误候选';
  if (p.startsWith('services/') || p.startsWith('worker/') || p === 'server.mjs') return '源码：后端候选（未证明可见）';
  return '源码：共享文案候选（待核对引用）';
}

function extract(p, source) {
  const result = [];
  const sf = ts.createSourceFile(p, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const add = (original, offset, kind, categoryName, dynamic = false, functions = [], includeNonChinese = false) => {
    if (!original.trim() || (!han.test(original) && !includeNonChinese)) return;
    const pos = sf.getLineAndCharacterOfPosition(offset);
    if (!han.test(original)) categoryName = /[\p{L}\p{N}]/u.test(original.replace(/\$\{…\d+\}/g, '')) ? '界面：英文或数字' : '界面：纯符号';
    result.push({ original, path: p, line: pos.line + 1, column: pos.character + 1, offset, kind, category: categoryName, dynamic, enclosingFunctions: functions });
  };
  if (p.endsWith('.css')) {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n\r]/g, ' '));
    for (const m of clean.matchAll(/\bcontent\s*:\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')[^;}]*);/g)) {
      for (const literal of m[1].matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g)) add(literal[1] ?? literal[2], m.index + m[0].indexOf(m[1]) + literal.index, 'css-content', '界面：CSS 生成内容', false, [], true);
    }
    return result;
  }
  if (/\.(?:md|txt|html)$/.test(p)) {
    let offset = 0;
    for (const line of source.split('\n')) {
      add(line.trim(), offset, 'static-line', '静态法律与帮助（源码行）');
      offset += line.length + 1;
    }
    return result;
  }
  if (sf.parseDiagnostics.length) throw new Error(`AST parse failed: ${p}: ${sf.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`);
  function containingFunctions(node) {
    const names = [];
    for (let a = node.parent; a; a = a.parent) {
      if (ts.isFunctionDeclaration(a) || ts.isFunctionExpression(a) || ts.isArrowFunction(a) || ts.isMethodDeclaration(a)) {
        const name = a.name ?? ((ts.isVariableDeclaration(a.parent) || ts.isPropertyAssignment(a.parent)) ? a.parent.name : undefined);
        if (name) names.push(name.getText(sf));
      }
    }
    return names;
  }
  function clearlyDisplayed(node) {
    if (ts.isJsxText(node)) return true;
    if (ts.isBinaryExpression(node.parent) && /^(?:===?|!==?|<=?|>=?)$/.test(node.parent.operatorToken.getText(sf))) return false;
    if (ts.isConditionalExpression(node.parent) && node.parent.condition === node) return false;
    const ancestors = [];
    for (let a = node.parent; a && !ts.isJsxElement(a) && !ts.isJsxSelfClosingElement(a); a = a.parent) ancestors.push(a);
    const attribute = ancestors.find(ts.isJsxAttribute);
    if (attribute) return /^(?:title|aria-label|aria-description|placeholder|alt)$/.test(attribute.name.getText(sf));
    return ancestors.some(ts.isJsxExpression) && !ancestors.some(a => ts.isCallExpression(a) || ts.isNewExpression(a) || ts.isPropertyAssignment(a) || ts.isArrowFunction(a));
  }
  function visit(node) {
    const functions = containingFunctions(node);
    if (ts.isTemplateExpression(node)) {
      const original = node.head.text + node.templateSpans.map((span, i) => '${…' + (i + 1) + '}' + span.literal.text).join('');
      const staticText = node.head.text + node.templateSpans.map(span => span.literal.text).join('');
      add(original, node.getStart(sf), 'template', category(node, sf, p), true, functions, clearlyDisplayed(node) && !!staticText.trim());
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node.text, node.getStart(sf), ts.isStringLiteral(node) ? 'string' : 'template', category(node, sf, p), false, functions, clearlyDisplayed(node));
    } else if (ts.isJsxText(node)) {
      add(node.text.replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean).join(' '), node.getStart(sf), 'jsx-text', category(node, sf, p), false, functions, true);
    } else if (ts.isNumericLiteral(node) && ts.isJsxExpression(node.parent) && clearlyDisplayed(node)) {
      add(node.text, node.getStart(sf), 'jsx-number', '界面：英文或数字', false, functions, true);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

function selfTest() {
  const fixture = 'const x = `共${count}门${ok ? "成功" : "失败"}`; const el = <p title="提示">你好{who}同学</p>; // 注释秘密\nconsole.log("日志"); const r = /正则/;';
  const rows = extract('app/test-fixture.tsx', fixture);
  for (const expected of ['共${…1}门${…2}', '成功', '失败', '提示', '你好', '同学', '日志']) assert(rows.some(r => r.original === expected), expected);
  assert(!rows.some(r => /注释秘密|正则|count|who/.test(r.original)));
  assert.equal(rows.find(r => r.original === '日志').category, '源码：日志');
  assert.equal(rows.find(r => r.original === '提示').category, '界面：属性或无障碍标签');
  assert.equal(extract('app/a.ts', 'const a="中文";\nconst b="中文";')[1].line, 2);
  assert.equal(extract('app/a.css', '/* content:"秘密"; */ p::after { content:"中文"; }').length, 1);
  for (const p of ['public/data/reviews.json', 'docs/a.ts', 'services/auth-api/test/a.mjs', 'app/private/a.ts', 'app/a.test.ts']) assert(!allowed(p));
  assert(allowed('app/teachers/TeacherReviewDiscussion.tsx'));
  const english = extract('app/DufeHubV2.tsx', 'function RoomsPage(){return <button className="technical" title="Close" aria-label="Close dialog">OK <span>42</span>{mode === "internal" ? "Yes" : "No"} ×{123}</button>}');
  for (const value of ['Close', 'Close dialog', 'OK', '42', 'Yes', 'No', '×', '123']) assert(english.some(r => r.original === value), value);
  assert(!english.some(r => ['technical', 'internal'].includes(r.original)));
  assert(english.every(r => group(r.path, r.enclosingFunctions) === '空教室'));
  assert.equal(english.find(r => r.original === '×').category, '界面：纯符号');
  console.log('Extraction self-test passed');
}

// This function is serialized into the standalone HTML. Never interpolates source as markup.
function browserApp() {
  const data = JSON.parse(document.getElementById('inventory').textContent);
  const $ = id => document.getElementById(id);
  let page = 0;
  let dirty = false;
  const size = 40;
  const element = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  for (const line of data.scope) $('scope').append(element('li', line));
  for (const [id, values] of [['group', data.entries.flatMap(e => e.groups)], ['category', data.entries.flatMap(e => e.categories)]]) {
    for (const value of [...new Set(values)].sort()) { const option = element('option', value); option.value = value; $(id).append(option); }
  }
  function render() {
    const q = $('query').value.toLowerCase();
    const rows = data.entries.filter(e => (!q || [e.original, e.suggestion, ...e.locations.map(l => l.path)].join(' ').toLowerCase().includes(q))
      && (!$('group').value || e.groups.includes($('group').value)) && (!$('category').value || e.categories.includes($('category').value))
      && (!$('edited').checked || e.action !== 'undecided' || e.suggestion));
    const pages = Math.max(1, Math.ceil(rows.length / size));
    page = Math.min(page, pages - 1);
    $('count').textContent = rows.length + ' / ' + data.entries.length + ' 条 · 第 ' + (page + 1) + ' / ' + pages + ' 页';
    $('prev').disabled = page === 0; $('next').disabled = page >= pages - 1;
    $('rows').replaceChildren();
    for (const entry of rows.slice(page * size, (page + 1) * size)) {
      const card = element('article');
      const heading = $('group').value || entry.groups.slice(0, 3).join(' · ') + (entry.groups.length > 3 ? ' 等 ' + entry.groups.length + ' 个分组' : '');
      card.append(element('h2', heading), element('small', entry.categories.join(' / ')));
      if (entry.reviewNote) card.append(element('p', '可精简项（供你决定）：' + entry.reviewNote));
      const columns = element('div'); columns.className = 'columns';
      const original = element('div'); original.append(element('h3', '原文'), element('pre', entry.original));
      const edit = element('div');
      const label = element('label', '建议修改'); label.htmlFor = entry.id;
      const input = element('textarea'); input.id = entry.id; input.value = entry.suggestion; input.rows = 3;
      input.addEventListener('input', () => { entry.suggestion = input.value; dirty = true; $('save-state').textContent = '有未下载的修改'; });
      const actionLabel = element('label', '处理方式'); actionLabel.htmlFor = entry.id + '-action';
      const action = element('select'); action.id = actionLabel.htmlFor;
      for (const [value, text] of [['undecided', '未决定'], ['keep', '保留'], ['replace', '修改'], ['delete', '删除']]) { const o = element('option', text); o.value = value; action.append(o); }
      action.value = entry.action;
      action.onchange = () => { entry.action = action.value; dirty = true; $('save-state').textContent = '有未下载的修改'; };
      edit.append(label, input, actionLabel, action); columns.append(original, edit); card.append(columns);
      const details = element('details'); details.append(element('summary', '全部来源 · ' + entry.locations.length + ' 处' + (entry.dynamic ? ' · 含动态占位符' : '')));
      for (const l of entry.locations) details.append(element('p', l.path + ':' + l.line + ':' + l.column + ' · ' + l.group + ' · ' + (l.enclosingFunctions.join(' ← ') || '顶层') + ' · ' + l.category + ' · ' + l.reachability));
      card.append(details); $('rows').append(card);
    }
  }
  for (const id of ['query', 'group', 'category', 'edited']) $(id).addEventListener(id === 'query' ? 'input' : 'change', () => { page = 0; render(); });
  $('prev').onclick = () => { page--; render(); }; $('next').onclick = () => { page++; render(); };
  function download(name, body, type) {
    const url = URL.createObjectURL(new Blob([body], { type })); const a = element('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('download').onclick = () => { download('ui-copy-reviewed.json', JSON.stringify(data, null, 2), 'application/json'); dirty = false; $('save-state').textContent = '已请求下载，请确认文件已保存'; };
  $('text-download').onclick = () => download('ui-copy-reviewed.txt', data.scope.join('\n') + '\n\n' + data.entries.map(e => '[' + e.action + '] ' + e.original + '\n建议：' + e.suggestion + '\n' + e.locations.map(l => l.path + ':' + l.line).join('\n')).join('\n\n'), 'text/plain;charset=utf-8');
  $('import').onchange = async event => {
    try {
      const imported = JSON.parse(await event.target.files[0].text());
      if (imported.schemaVersion !== data.schemaVersion || !Array.isArray(imported.entries)) throw new Error('格式不兼容');
      const map = new Map(data.entries.map(e => [e.id, e])); let matched = 0;
      for (const row of imported.entries) {
        const target = map.get(row.id);
        if (target && target.original === row.original && typeof row.suggestion === 'string' && ['undecided', 'keep', 'replace', 'delete'].includes(row.action)) { target.suggestion = row.suggestion; target.action = row.action; matched++; }
      }
      dirty = true; $('save-state').textContent = '已导入 ' + matched + ' 条；未匹配 ' + (imported.entries.length - matched) + ' 条。请下载保存。'; render();
    } catch { $('save-state').textContent = '导入失败：请选择此清单导出的 JSON。'; }
    event.target.value = '';
  };
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  render();
}

function html(data) {
  const embedded = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>东财之影 · 文案校对清单</title>
<style>:root{color-scheme:light;--paper:#f4f6f8;--ink:#17212b;--muted:#475569;--line:#b8c4ce;--accent:#175c68}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,'Microsoft YaHei',sans-serif}main{max-width:1180px;margin:auto;padding:28px 20px}h1{font:700 30px/1.3 Georgia,'SimSun',serif;margin:0}h2{font-size:17px;margin:0}h3{font-size:14px;margin:0 0 8px;color:var(--muted)}p{overflow-wrap:anywhere}small{color:var(--muted)}header{border-left:6px solid var(--accent);padding-left:18px;margin-bottom:24px}button,select,input,textarea{font:inherit;color:inherit;max-width:100%}button,select,input{min-height:44px;padding:7px 10px;border:1px solid var(--line);background:white}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}label{display:block}textarea{display:block;width:100%;padding:10px;border:1px solid var(--line);resize:vertical;background:#fff}article{background:white;padding:20px;margin:16px 0;border:1px solid var(--line);border-left:4px solid var(--accent)}.columns{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:14px 0}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}nav,.filters{display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:18px 0}.filters>label{flex:1;min-width:180px}.filters input:not([type=checkbox]),.filters select{width:100%}summary{cursor:pointer;color:var(--accent);padding:8px 0}details p{font:13px/1.6 Consolas,monospace}#save-state{color:var(--accent)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}@media(max-width:700px){main{padding:18px 12px}.columns{grid-template-columns:1fr;gap:16px}article{padding:14px}h1{font-size:25px}}</style>
<main><header><h1>东财之影 · 文案校对清单</h1><p>原文只读。填写建议或标记删除后，下载审阅稿；不会修改网站。</p><small>${data.summary.entries} 条去重文案 · ${data.summary.locations} 处来源 · ${data.summary.filesScanned} 个文件</small></header>
<details><summary>提取范围与限制（请先读）</summary><ul id="scope"></ul><p>源码指纹：${data.sourceFingerprint}</p></details>
<nav aria-label="审阅稿"><button id="download">下载审阅 JSON</button><button id="text-download">下载完整 TXT</button><label>导入审阅 JSON<input id="import" type="file" accept=".json,application/json"></label></nav><p id="save-state" role="status">编辑仅存在当前页面，关闭前请下载。</p>
<section class="filters" aria-label="筛选"><label>搜索原文、建议或路径<input id="query" type="search"></label><label>分组<select id="group"><option value="">全部分组</option></select></label><label>类别<select id="category"><option value="">全部类别</option></select></label><label><input id="edited" type="checkbox"> 仅已填写 / 已决定</label></section>
<nav aria-label="分页"><button id="prev">上一页</button><span id="count" role="status"></span><button id="next">下一页</button></nav><section id="rows" aria-label="文案条目"></section><noscript>请启用 JavaScript，或阅读同目录的完整 TXT / JSON。</noscript></main>
<script id="inventory" type="application/json">${embedded}</script><script>(${browserApp.toString()})();</script></html>\n`;
}

async function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return; }
  const tracked = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
  const files = tracked.filter(allowed).sort(compare);
  const sources = new Map();
  for (const p of files) {
    const absolute = path.join(root, p);
    if ((await lstat(absolute)).isSymbolicLink()) throw new Error(`Refusing source symlink: ${p}`);
    sources.set(p, await readFile(absolute, 'utf8'));
  }
  // Conservative file-level reachability, not tree shaking or a runtime visibility claim.
  const reached = new Set();
  function reach(p) {
    if (reached.has(p) || !sources.has(p)) return;
    reached.add(p);
    for (const imp of ts.preProcessFile(sources.get(p), true, true).importedFiles) {
      if (!imp.fileName.startsWith('.')) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(p), imp.fileName));
      const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx'].map(ext => base + ext)];
      for (const target of candidates) if (sources.has(target)) reach(target);
    }
  }
  for (const p of files) if (/^app\/(?:.*\/)?(?:page|layout|route|not-found|error|loading|robots|sitemap)\.[jt]sx?$/.test(p) || ['services/auth-api/src/index.mjs', 'worker/index.ts', 'server.mjs'].includes(p)) reach(p);
  const entries = new Map();
  const manifest = [];
  for (const [p, source] of sources) {
    const rows = extract(p, source);
    manifest.push({ path: p, sha256: hash(source), occurrences: rows.length });
    for (const row of rows) {
      const { original, ...location } = row;
      location.group = group(p, location.enclosingFunctions);
      location.reachability = reached.has(p) ? '静态入口/相对引用可达（非运行时证明）' : '源码待确认：未找到入口引用';
      if (!reached.has(p) && p.startsWith('app/') && !p.endsWith('.css')) location.category = '源码：未找到入口引用 / ' + location.category;
      if (!entries.has(original)) entries.set(original, { id: hash(original), original, reviewNote: reviewNotes.get(original) ?? '', suggestion: '', action: 'undecided', groups: [], categories: [], dynamic: false, locations: [] });
      const entry = entries.get(original);
      entry.locations.push(location); entry.dynamic ||= row.dynamic;
    }
  }
  const list = [...entries.values()].sort((a, b) => compare(a.locations[0].path, b.locations[0].path) || a.locations[0].offset - b.locations[0].offset || compare(a.original, b.original));
  for (const entry of list) {
    entry.groups = [...new Set(entry.locations.map(l => l.group))].sort(compare);
    entry.categories = [...new Set(entry.locations.map(l => l.category))].sort(compare);
  }
  const data = { schemaVersion: 1, scope, sourceFingerprint: hash(JSON.stringify(manifest)), summary: { entries: list.length, locations: list.reduce((n, e) => n + e.locations.length, 0), filesScanned: files.length, filesWithCopy: manifest.filter(f => f.occurrences).length }, files: manifest, entries: list };
  const outputs = new Map([
    ['ui-copy.json', JSON.stringify(data, null, 2) + '\n'],
    ['index.html', html(data)],
    ['ui-copy.txt', '东财之影 · 静态文案完整清单\n\n' + scope.join('\n') + '\n\n' + list.map(e => `[${e.id}] ${e.groups.join(' / ')}\n类别：${e.categories.join(' / ')}\n原文：${e.original}\n建议：\n处理：未决定\n${e.locations.map(l => `${l.path}:${l.line}:${l.column} · ${l.group} · ${l.enclosingFunctions.join(' ← ') || '顶层'} · ${l.category} · ${l.reachability}`).join('\n')}`).join('\n\n') + '\n'],
  ]);
  if (process.argv.includes('--check')) {
    for (const [name, content] of outputs) {
      if (await readFile(path.join(out, name), 'utf8') !== content) throw new Error(`Stale artifact: ${name}; regenerate after integration`);
    }
    console.log('Artifacts match current source');
  } else {
    await mkdir(out, { recursive: true });
    for (const [name, content] of outputs) {
      const target = path.join(out, name);
      try { if ((await lstat(target)).isSymbolicLink()) throw new Error(`Refusing output symlink: ${name}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await writeFile(target, content, 'utf8');
    }
  }
  console.log(JSON.stringify(data.summary));
}
await main();
