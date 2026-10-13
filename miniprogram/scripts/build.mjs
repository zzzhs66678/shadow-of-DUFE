import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readWebsiteFile, release } from './website-source.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { encode } = require('../src/lib/codec.js');
const source = JSON.parse(readWebsiteFile('public/data/course-data.json'));
const dist = path.join(root, 'dist');
// Only this generated directory is owned by this builder. No user/private files are read or removed.
if (path.dirname(dist) !== root || path.basename(dist) !== 'dist') throw new Error('构建目标越界');
await fs.mkdir(dist, { recursive: true });
await fs.cp(path.join(root, 'src'), dist, { recursive: true });
await fs.mkdir(path.join(dist, 'data'), { recursive: true });
await fs.writeFile(path.join(dist, 'data/catalog.js'), 'module.exports=' + JSON.stringify(encode(source)) + ';\n');
const calendarSource = readWebsiteFile('app/DufeHubV2.tsx').match(/function schoolWeek[\s\S]{0,500}/)?.[0] || '';
const semesterDates = [...calendarSource.matchAll(/"(\d{4}-\d{2}-\d{2})T00:00:00\+08:00"/g)].map(match => match[1]);
if (semesterDates.length !== 2) throw new Error('无法核对正式网站学期设置，不能猜测开学日期。');
await fs.writeFile(path.join(dist, 'data/release.js'), 'module.exports=' + JSON.stringify({...release,semesterStartDates:{fall:semesterDates[0],spring:semesterDates[1]}}) + ';\n');
const titles = { home: release.miniProgramName, courses: '课程', timetable: '我的课表', rooms: '空教室', detail: '课程详情', classes: '按班级导入', settings: '课表设置', about: '项目与隐私说明', planner: '日程与作业', 'room-detail': '教室一周排课', me: '我的', account:'账号与课表', 'cloud-detail':'网站课程详情' };
for (const [page, title] of Object.entries(titles)) {
  await fs.writeFile(path.join(dist, 'pages', page, 'index.json'), JSON.stringify({ navigationBarTitleText: title }) + '\n');
}
async function files(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(path.join(dir, e.name)) : path.join(dir, e.name)))).flat();
}
const all = await files(dist), size = (await Promise.all(all.map(f => fs.stat(f)))).reduce((sum, s) => sum + s.size, 0);
if (size > 2_000_000) throw new Error('主包超过项目保守预算2,000,000字节：' + size);
console.log(`构建完成：${source.courses.length}门课程，${source.schedules.length}个时段，主包 ${(size / 1024).toFixed(1)} KiB。`);
