import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { catalogFilePath, catalogUploadName, receiveCatalogFile, validateCatalogFile } from '../src/catalog/uploads.mjs';

function zip(entries, { expanded = null } = {}) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50,0); header.writeUInt16LE(20,4);
    header.writeUInt32LE(data.length,18); header.writeUInt32LE(expanded ?? data.length,22); header.writeUInt16LE(filename.length,26);
    local.push(header,filename,data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50,0); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6);
    directory.writeUInt32LE(data.length,20); directory.writeUInt32LE(expanded ?? data.length,24); directory.writeUInt16LE(filename.length,28); directory.writeUInt32LE(offset,42);
    central.push(directory,filename); offset += header.length+filename.length+data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

test('catalog upload names and paths never use caller names for filesystem identity',()=>{
  assert.deepEqual(catalogUploadName(encodeURIComponent('中文资料.pdf')),{name:'中文资料.pdf',extension:'pdf'});
  for(const name of ['../secret.pdf','C:\\secret.pdf','macro.docm','app.exe','x.ppt','x.pdf\n','x\u0000.pdf'])assert.equal(catalogUploadName(encodeURIComponent(name)),null);
  const root=join(tmpdir(),'catalog-safe-root');
  assert.throws(()=>catalogFilePath(root,'staged',{id:'../escape',extension:'pdf'}),{code:'CATALOG_INVALID_FILE_REFERENCE'});
  assert.throws(()=>catalogFilePath(root,'../../other',{id:'00000000-0000-4000-8000-000000000001',extension:'pdf'}),{code:'CATALOG_INVALID_FILE_REFERENCE'});
});

test('bounded ZIP metadata accepts office packages and rejects macros, traversal and excessive expansion',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'catalog-zip-test-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const cases=[
    {name:'deck.pptx',extension:'pptx',bytes:zip([['[Content_Types].xml','<Types/>'],['ppt/presentation.xml','<presentation/>']]),valid:true},
    {name:'doc.docx',extension:'docx',bytes:zip([['[Content_Types].xml','<Types/>'],['word/document.xml','<document/>']]),valid:true},
    {name:'sheet.xlsx',extension:'xlsx',bytes:zip([['[Content_Types].xml','<Types/>'],['xl/workbook.xml','<workbook/>']]),valid:true},
    {name:'archive.zip',extension:'zip',bytes:zip([['safe.csv','a,b']]),valid:true},
    {name:'macro.pptx',extension:'pptx',bytes:zip([['[Content_Types].xml','<Types/>'],['ppt/vbaProject.bin','code']]),valid:false},
    {name:'path.zip',extension:'zip',bytes:zip([['../escape.pdf','bytes']]),valid:false},
    {name:'binary.zip',extension:'zip',bytes:zip([['tool.exe','MZ']]),valid:false},
    {name:'bomb.zip',extension:'zip',bytes:zip([['huge.txt','x']],{expanded:100*1024*1024+1}),valid:false},
    {name:'fake.docx',extension:'docx',bytes:zip([['safe.txt','plain']]),valid:false},
    {name:'fake.pdf',extension:'pdf',bytes:Buffer.from('<html>not a PDF</html>'),valid:false},
  ];
  for(const item of cases){const path=join(directory,item.name);await writeFile(path,item.bytes);
    if(item.valid)await validateCatalogFile(path,item.bytes.length,item.extension);
    else await assert.rejects(validateCatalogFile(path,item.bytes.length,item.extension),{code:'CATALOG_INVALID_FILE'});
  }
});

test('invalid streamed file is removed and declared oversize requests never allocate a file',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'catalog-stream-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const bad=new PassThrough(); bad.headers={}; bad.end(Buffer.from('<html>untrusted bytes</html>'));
  await assert.rejects(receiveCatalogFile(bad,directory,encodeURIComponent('bad.pdf')),{code:'CATALOG_INVALID_FILE'});
  assert.deepEqual(await readdir(join(directory,'staged')),[]);
  const huge=new PassThrough(); huge.headers={'content-length':String(25*1024*1024+1)};huge.end('x');
  await assert.rejects(receiveCatalogFile(huge,directory,encodeURIComponent('huge.pdf')),{code:'CATALOG_REQUEST_TOO_LARGE'});
  assert.deepEqual(await readdir(join(directory,'staged')),[]);
});
