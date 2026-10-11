import { readFile, mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

// Pack the existing public catalog for the independent API image. The test
// compares both sources, so a future static data update cannot silently diverge.
const destination = new URL("../services/auth-api/catalog-baseline/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const [kind, filename] of [["courses", "course-data.json"], ["materials", "resource-manifest.json"]]) {
  const source = await readFile(new URL(`../public/data/${filename}`, import.meta.url));
  await writeFile(new URL(`${kind}.json.gz`, destination), gzipSync(source, { level: 9 }));
}
