import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = JSON.parse(await fs.readFile(path.join(root, 'dist/app.json'), 'utf8'));
for (const page of app.pages) {
  for (const ext of ['js', 'wxml', 'json']) await fs.access(path.join(root, 'dist', page + '.' + ext));
  const source = await fs.readFile(path.join(root, 'dist', page + '.js'), 'utf8');
  new vm.Script(source, { filename: page });
  const template = await fs.readFile(path.join(root, 'dist', page + '.wxml'), 'utf8');
  // Catch misspelled event handlers; this is a source check, not the WeChat compiler.
  const handlers = [...template.matchAll(/(?:bind|catch)(?:tap|input|change|confirm)="([A-Za-z]+)"/g)].map(m => m[1]);
  for (const handler of handlers) if (!new RegExp('\\b' + handler + '\\s*\\(').test(source)) throw new Error(page + ' 缺少处理方法 ' + handler);
  JSON.parse(await fs.readFile(path.join(root, 'dist', page + '.json'), 'utf8'));
}
for (const tab of app.tabBar.list) {
  if (!app.pages.includes(tab.pagePath)) throw new Error('无效标签页');
  for (const icon of [tab.iconPath, tab.selectedIconPath].filter(Boolean)) await fs.access(path.join(root, 'dist', icon));
}
const config = JSON.parse(await fs.readFile(path.join(root, 'project.config.json'), 'utf8'));
if (config.miniprogramRoot !== 'dist/') throw new Error('无效导入目录');
console.log(app.pages.length + '个页面路由、JS语法、事件方法与项目配置检查通过；微信编译/真机验收仍须开发者工具。');
