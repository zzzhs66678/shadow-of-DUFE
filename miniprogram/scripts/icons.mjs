// Small authored vector icons, rasterized for the native tab bar. Uses the website's existing sharp.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/assets');
await fs.mkdir(folder, { recursive: true });
const shapes = {
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v5m8-5v5M4 10h16M8 14h1m6 0h1m-8 4h1m6 0h1"/>',
  building: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M8 9h1m6 0h1m-8 4h1m6 0h1"/>',
  home: '<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>',
  book: '<path d="M12 4v17M3 4h6a3 3 0 0 1 3 3 3 3 0 0 1 3-3h6v16h-6a3 3 0 0 0-3 1 3 3 0 0 0-3-1H3z"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>'
};
for (const [name, shape] of Object.entries(shapes)) for (const active of [false, true]) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"><g fill="none" stroke="' + (active ? '#a52325' : '#706a62') + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + shape + '</g></svg>';
  await sharp(Buffer.from(svg)).png().toFile(path.join(folder, name + (active ? '-active' : '') + '.png'));
}
console.log('已生成5组纸墨朱红导航图标。');
