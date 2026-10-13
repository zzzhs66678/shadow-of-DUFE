import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const release = JSON.parse(fs.readFileSync(path.join(root, 'release-source.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(release.websiteCommit)) throw new Error('网站来源须为完整提交SHA');
export function readWebsiteFile(filename) {
  if (!['public/data/course-data.json', 'app/course-search.ts', 'app/globals.css', 'app/DufeHubV2.tsx'].includes(filename)) throw new Error('来源文件不在公开白名单');
  const result = spawnSync('git', ['show', release.websiteCommit + ':' + filename], { cwd: path.join(root, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('无法读取已发布网站提交，不能退回未提交目录数据。' + (result.error?.message || ''));
  return result.stdout;
}
