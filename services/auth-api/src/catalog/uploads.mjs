import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { catalogFailure } from './snapshots.mjs';

export const CATALOG_FILE_LIMIT = 25 * 1024 * 1024;
const allowed = new Set(['pdf', 'pptx', 'docx', 'xlsx', 'zip']);
const blockedEntry = /(?:^|\/)(?:vbaproject\.bin|[^/]+\.(?:exe|dll|com|scr|msi|bat|cmd|ps1|sh|js|vbs|jar|app|xlsm|docm|pptm))$/iu;
const fail = code => { throw catalogFailure(code); };

export function catalogUploadName(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let name;
  try { name = decodeURIComponent(value).normalize('NFC'); } catch { return null; }
  if (/[\u0000-\u001f\u007f]/u.test(name)) return null;
  name = name.trim();
  if (!name || name.length > 160 || /[\\/\u0000-\u001f\u007f]/u.test(name)) return null;
  const extension = extname(name).slice(1).toLowerCase();
  return allowed.has(extension) ? { name, extension } : null;
}

export function catalogFilePath(root, area, file, suffix = '') {
  if (!root || !isAbsolute(root) || !['staged', 'published'].includes(area) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(file.id) || !allowed.has(file.extension) || !['', '.tmp'].includes(suffix)) fail('CATALOG_INVALID_FILE_REFERENCE');
  const base = resolve(root, area), path = resolve(base, `${file.id}.${file.extension}${suffix}`);
  if (!path.startsWith(`${base}${sep}`)) fail('CATALOG_INVALID_FILE_REFERENCE');
  return path;
}

async function validateZip(handle, size, extension) {
  const length = Math.min(size, 65_557), tail = Buffer.alloc(length);
  await handle.read(tail, 0, length, size - length);
  let eocd = -1;
  for (let index = length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === length) { eocd = index; break; }
  }
  if (eocd < 0) fail('CATALOG_INVALID_FILE');
  const entries = tail.readUInt16LE(eocd + 10), centralSize = tail.readUInt32LE(eocd + 12), offset = tail.readUInt32LE(eocd + 16);
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0 || tail.readUInt16LE(eocd + 8) !== entries ||
      entries < 1 || entries > 2000 || centralSize > 2 * 1024 * 1024 || offset === 0xffffffff || centralSize === 0xffffffff ||
      offset + centralSize !== size - length + eocd) fail('CATALOG_INVALID_FILE');
  const central = Buffer.alloc(centralSize);
  if ((await handle.read(central, 0, centralSize, offset)).bytesRead !== centralSize) fail('CATALOG_INVALID_FILE');
  const names = new Set();
  let position = 0, expanded = 0;
  for (let index = 0; index < entries; index++) {
    if (position + 46 > centralSize || central.readUInt32LE(position) !== 0x02014b50) fail('CATALOG_INVALID_FILE');
    const flags = central.readUInt16LE(position + 8), method = central.readUInt16LE(position + 10);
    const compressed = central.readUInt32LE(position + 20), uncompressed = central.readUInt32LE(position + 24);
    const nameLength = central.readUInt16LE(position + 28), extra = central.readUInt16LE(position + 30), comment = central.readUInt16LE(position + 32);
    const localOffset = central.readUInt32LE(position + 42), next = position + 46 + nameLength + extra + comment;
    if (next > centralSize || nameLength < 1 || nameLength > 512 || (flags & 1) || ![0, 8].includes(method) ||
        compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset >= offset ||
        uncompressed > 100 * Math.max(compressed, 1024)) fail('CATALOG_INVALID_FILE');
    const name = central.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    if (name.startsWith('/') || name.includes('\\') || name.includes('\u0000') || name.split('/').includes('..') ||
        /^[A-Za-z]:/u.test(name) || blockedEntry.test(name) || /macroEnabled/iu.test(name) || names.has(name)) fail('CATALOG_INVALID_FILE');
    names.add(name); expanded += uncompressed;
    if (expanded > 100 * 1024 * 1024) fail('CATALOG_INVALID_FILE');
    const local = Buffer.alloc(30);
    if ((await handle.read(local, 0, 30, localOffset)).bytesRead !== 30 || local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(26) !== nameLength || local.readUInt16LE(8) !== method || (local.readUInt16LE(6) & 1) ||
        localOffset + 30 + nameLength + local.readUInt16LE(28) + compressed > offset) fail('CATALOG_INVALID_FILE');
    const localName = Buffer.alloc(nameLength);
    await handle.read(localName, 0, nameLength, localOffset + 30);
    if (!localName.equals(central.subarray(position + 46, position + 46 + nameLength))) fail('CATALOG_INVALID_FILE');
    position = next;
  }
  if (position !== centralSize) fail('CATALOG_INVALID_FILE');
  if (extension !== 'zip') {
    const folder = { pptx: 'ppt/', docx: 'word/', xlsx: 'xl/' }[extension];
    if (!names.has('[Content_Types].xml') || ![...names].some(name => name.startsWith(folder))) fail('CATALOG_INVALID_FILE');
  }
}

export async function validateCatalogFile(path, size, extension) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(8);
    if ((await handle.read(header, 0, 8, 0)).bytesRead < 8) fail('CATALOG_INVALID_FILE');
    if (extension === 'pdf') {
      if (header.subarray(0, 5).toString('ascii') !== '%PDF-' || !/^\d\.\d/u.test(header.subarray(5).toString('ascii'))) fail('CATALOG_INVALID_FILE');
    } else {
      if (header.readUInt32LE(0) !== 0x04034b50) fail('CATALOG_INVALID_FILE');
      await validateZip(handle, size, extension);
    }
  } finally { await handle.close(); }
}

export async function receiveCatalogFile(request, root, fileName, { timeoutMs = 30_000 } = {}) {
  const metadata = catalogUploadName(fileName);
  if (!metadata) fail('CATALOG_INVALID_FILE_NAME');
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined && (!/^\d+$/u.test(String(contentLength)) || Number(contentLength) > CATALOG_FILE_LIMIT)) {
    request.resume(); fail('CATALOG_REQUEST_TOO_LARGE');
  }
  const file = { ...metadata, id: randomUUID() };
  const path = catalogFilePath(root, 'staged', file);
  await mkdir(resolve(root, 'staged'), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0, timer;
  try {
    // A single bounded upload runs under the database import lease. Stream to
    // disk without retaining the complete file in the 128 MiB auth process.
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(catalogFailure('CATALOG_REQUEST_TIMEOUT')), timeoutMs); timer.unref(); });
    const write = (async () => {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > CATALOG_FILE_LIMIT) fail('CATALOG_REQUEST_TOO_LARGE');
        hash.update(chunk);
        await handle.write(chunk);
      }
    })();
    await Promise.race([write, timeout]);
    clearTimeout(timer);
    await handle.close();
    if (bytes === 0) fail('CATALOG_INVALID_FILE');
    await validateCatalogFile(path, bytes, file.extension);
    return { ...file, sizeBytes: bytes, sha256: hash.digest('hex') };
  } catch (error) {
    clearTimeout(timer);
    try { await handle.close(); } catch { /* already closed */ }
    try { await unlink(path); } catch { /* incomplete file already removed */ }
    request.resume();
    throw error;
  }
}

export async function promoteCatalogFiles(root, files, promoted) {
  await mkdir(resolve(root, 'published'), { recursive: true, mode: 0o755 });
  for (const file of files) {
    const temporary = catalogFilePath(root, 'published', file, '.tmp'), destination = catalogFilePath(root, 'published', file);
    try {
      await copyFile(catalogFilePath(root, 'staged', file), temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o444);
      await rename(temporary, destination);
      promoted.push(file);
    } catch (error) {
      try { await unlink(temporary); } catch { /* no partial promotion remains */ }
      throw error;
    }
  }
}

export async function removeCatalogFiles(root, files, area = 'staged') {
  if (!files.length) return;
  for (const file of files) {
    try { await unlink(catalogFilePath(root, area, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
