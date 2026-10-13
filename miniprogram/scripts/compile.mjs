// Optional syntax check using the compiler distributed with WeChat's miniprogram-simulate.
// Usage: node scripts/compile.mjs <extracted miniprogram-compiler package directory>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('请指定独立 miniprogram-compiler 包目录；完整项目仍须微信开发者工具验收。');
const compiler = path.resolve(process.argv[2]);
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const app = JSON.parse(fs.readFileSync(path.join(root, 'dist/app.json'), 'utf8'));
for (const [binary, args] of [
  ['wcc', ['-d', '-cc', '0', ...app.pages.map(page => page + '.wxml'), '-gn', '$gwx']],
  ['wcsc', ['-db', '-pc', '0', 'app.wxss', ...app.pages.map(page=>page+'.wxss').filter(page=>fs.existsSync(path.join(root,'dist',page)))]]
]) {
  const executable = path.join(compiler, 'bin', platform, binary + (platform === 'windows' ? '.exe' : ''));
  const result = spawnSync(executable, args, { cwd: path.join(root, 'dist'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(binary + ': ' + (result.error?.message || result.stderr));
  console.log(binary + ' 编译通过（' + result.stdout.length + '个输出字符）。');
}
console.log('这里只确认WXML/WXSS编译；非完整开发者工具模拟器或真机验收。');
