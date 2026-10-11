import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const CATALOG_LIMITS = Object.freeze({ courses: 3_250_000, core: 750_000, materials: 420_000, rows: 10_000, request: 4 * 1024 * 1024 });
export const CATALOG_RETENTION = Object.freeze({ releases: 200, compressedBytes: 100 * 1024 * 1024 });
export const isCatalogVersion = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const isCatalogKind = value => value === 'courses' || value === 'materials';
export const catalogFailure = (code, details) => Object.assign(new Error(code), { code, ...details });
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// JSON already validated by the import contract. Sorting object keys gives a
// reproducible identity; the order of visible records remains intentional.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function semanticCatalogId(payload) {
  const hash = createHash('sha256');
  const keys = Object.keys(payload).filter(key => key !== 'catalogId' && key !== 'generatedAt').sort();
  hash.update('{');
  keys.forEach((key, index) => {
    if (index) hash.update(',');
    hash.update(JSON.stringify(key)); hash.update(':');
    const value = payload[key];
    if (Array.isArray(value)) {
      hash.update('[');
      value.forEach((record, recordIndex) => {
        if (recordIndex) hash.update(',');
        // Only one small record is canonicalized at a time. No extra complete
        // schedule/course tree or canonical 3.2 MB string exists in memory.
        hash.update(JSON.stringify(canonical(record)));
      });
      hash.update(']');
    } else hash.update(JSON.stringify(canonical(value)));
  });
  hash.update('}');
  return hash.digest('hex');
}

export function buildCatalogCore(payload) {
  const courseTitles = payload.courses.map(course => [course.id, course.title]);
  const courseIndexes = new Map(courseTitles.map(([id], index) => [id, index]));
  const dictionary = values => {
    const items = [...new Set(values)];
    return { items, indexes: new Map(items.map((item, index) => [item, index])) };
  };
  const teachers = dictionary(payload.schedules.map(item => item.teacher));
  const timeTexts = dictionary(payload.schedules.map(item => item.timeText));
  const venues = dictionary(payload.schedules.map(item => item.building));
  const rooms = dictionary(payload.schedules.map(item => item.room));
  return { version: 1, catalogId: payload.catalogId, generatedAt: payload.generatedAt,
    source: payload.source, disclaimer: payload.disclaimer, periods: payload.periods, buildings: payload.buildings,
    colleges: payload.colleges, majors: payload.majors, quality: payload.quality, courseTitles,
    dictionaries: { teachers: teachers.items, timeTexts: timeTexts.items, venues: venues.items, rooms: rooms.items },
    schedules: payload.schedules.map(item => [item.id, item.term === 'fall' ? 0 : 1, courseIndexes.get(item.courseId),
      teachers.indexes.get(item.teacher), item.weekday, item.block, item.weeks, timeTexts.indexes.get(item.timeText),
      venues.indexes.get(item.building), rooms.indexes.get(item.room)]) };
}

export async function makeCatalogSnapshot(kind, payload, { baseline = false } = {}) {
  const version = semanticCatalogId(payload);
  if (!baseline) payload = { ...payload, generatedAt: new Date().toISOString(), ...(kind === 'courses' ? { catalogId: `course-v1:${version}` } : {}) };
  const fullText = JSON.stringify(payload);
  const coreText = kind === 'courses' ? JSON.stringify(buildCatalogCore(payload)) : null;
  const fullSize = Buffer.byteLength(fullText), coreSize = coreText === null ? null : Buffer.byteLength(coreText);
  if (fullSize > CATALOG_LIMITS[kind] || (coreSize !== null && coreSize > CATALOG_LIMITS.core)) throw catalogFailure('CATALOG_SIZE_LIMIT');
  const fullGzip = await compress(fullText, { level: 6 });
  const coreGzip = coreText === null ? null : await compress(coreText, { level: 6 });
  return { kind, version, fullText, coreText, fullGzip, coreGzip, fullSize, coreSize, catalogId: kind === 'courses' ? payload.catalogId : null };
}

export async function decodeCatalogSnapshot(row) {
  const fullGzip = Buffer.from(row.full_gzip), coreGzip = row.core_gzip === null ? null : Buffer.from(row.core_gzip);
  const fullText = (await decompress(fullGzip, { maxOutputLength: CATALOG_LIMITS[row.kind] })).toString('utf8');
  const coreText = coreGzip === null ? null : (await decompress(coreGzip, { maxOutputLength: CATALOG_LIMITS.core })).toString('utf8');
  if (Buffer.byteLength(fullText) !== row.full_size || (coreText !== null && Buffer.byteLength(coreText) !== row.core_size)) throw catalogFailure('CATALOG_CORRUPT_SNAPSHOT');
  return { kind: row.kind, version: row.version, fullText, coreText, fullGzip, coreGzip, fullSize: row.full_size,
    coreSize: row.core_size, catalogId: row.catalog_id };
}

export async function loadBundledCatalogBaseline(kind) {
  if (!isCatalogKind(kind)) throw catalogFailure('CATALOG_INVALID_BODY');
  const bytes = await readFile(new URL(`../../catalog-baseline/${kind}.json.gz`, import.meta.url));
  return JSON.parse((await decompress(bytes, { maxOutputLength: CATALOG_LIMITS[kind] })).toString('utf8'));
}

export function createSnapshotCache({ maximum = 3, maxBytes = 12 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0;
  const weight = item => item.fullText.length * 2 + (item.coreText?.length ?? 0) * 2 + item.fullGzip.length + (item.coreGzip?.length ?? 0);
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key); entries.set(key, entry);
      return entry.value;
    },
    put(key, value) {
      const old = entries.get(key);
      if (old) { bytes -= old.weight; entries.delete(key); }
      const size = weight(value);
      if (size > maxBytes) return value;
      entries.set(key, { value, weight: size }); bytes += size;
      while (entries.size > maximum || bytes > maxBytes) {
        const first = entries.keys().next().value;
        bytes -= entries.get(first).weight; entries.delete(first);
      }
      return value;
    },
    stats() { return { entries: entries.size, bytes }; },
  };
}
