// Local isolated workload measurement, never a production-server benchmark.
// node --expose-gc --max-old-space-size=64 --max-semi-space-size=4 scripts/catalog-load-check.mjs
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { applyCatalogImport, exportCatalogRows } from '../src/catalog/import-contract.mjs';
import { createSnapshotCache, loadBundledCatalogBaseline, makeCatalogSnapshot } from '../src/catalog/snapshots.mjs';

if (getHeapStatistics().heap_size_limit > 128 * 1024 * 1024) {
  throw new Error('Use --max-old-space-size=64 --max-semi-space-size=4 to bound this isolated check.');
}
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const rounded = value => Number(value.toFixed(2));
const phases = [];
const cache = createSnapshotCache({ maximum: 3, maxBytes: 12 * 1024 * 1024 });
const delay = monitorEventLoopDelay({ resolution: 1 });
let sampledPeakRss = process.memoryUsage().rss;
const sample = setInterval(() => { sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss); }, 5);
sample.unref();
delay.enable();
await pause();

async function baseline(kind) {
  const start = performance.now();
  // The decompression buffer and parsed payload are not retained after this call.
  const snapshot = await makeCatalogSnapshot(kind, await loadBundledCatalogBaseline(kind), { baseline: true });
  cache.put(`${kind}:${snapshot.version}`, snapshot);
  phases.push({ phase: `${kind}_baseline_load_and_snapshot`, ms: rounded(performance.now() - start), fullBytes: snapshot.fullSize, coreBytes: snapshot.coreSize, gzipBytes: snapshot.fullGzip.length });
  return snapshot;
}

const current = await baseline('courses');
await baseline('materials');
globalThis.gc?.();
const beforeDraft = process.memoryUsage();
let authoritative = JSON.parse(current.fullText);
let row = exportCatalogRows('courses', authoritative)[0];
row.教材 += '（本地隔离负载验证）';
const startedImport = performance.now();
let imported = applyCatalogImport('courses', [row], authoritative);
phases.push({ phase: 'one_row_course_patch', ms: rounded(performance.now() - startedImport), summary: imported.summary });
if (imported.errors.length) throw new Error(JSON.stringify(imported.errors));
authoritative = null;
row = null;
const startedSnapshot = performance.now();
const release = await makeCatalogSnapshot('courses', imported.payload);
phases.push({ phase: 'changed_course_snapshot', ms: rounded(performance.now() - startedSnapshot), fullBytes: release.fullSize, coreBytes: release.coreSize, gzipBytes: release.fullGzip.length });
imported = null;
// A publication read promotes the new snapshot through the same bounded LRU.
cache.put(`courses:${release.version}`, release);
await pause();
delay.disable();
clearInterval(sample);
const beforeFinalGc = process.memoryUsage();
globalThis.gc?.();

console.log(JSON.stringify({
  scope: 'Isolated local Node workload; excludes PostgreSQL, authentication native libraries and HTTP concurrency; not a Linux/container/server measurement.',
  node: process.version, platform: process.platform, boundedHeapBytes: getHeapStatistics().heap_size_limit,
  explicitGcAvailable: typeof globalThis.gc === 'function', phases, cache: cache.stats(),
  beforeDraft, beforeFinalGc, afterFinalGc: process.memoryUsage(), sampledPeakRssBytes: sampledPeakRss,
  resourcePeakRssBytes: process.resourceUsage().maxRSS * 1024,
  eventLoopDelayMaxMs: rounded(delay.max / 1e6), eventLoopDelayP99Ms: rounded(delay.percentile(99) / 1e6),
}, null, 2));
