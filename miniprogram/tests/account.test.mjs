import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const key = 'dufesh.mini.account.v1', publicPath = '/api/catalog/releases/' + 'a'.repeat(64) + '/full';
function environment() {
  for (const name of ['account','api','catalog','cloud-view','store','planner']) delete require.cache[require.resolve('../dist/lib/'+name+'.js')];
  const memory = new Map(), writes = [], routes = [], calls = [];
  globalThis.wx = {getStorageSync:k=>memory.get(k)||'',setStorageSync:(k,v)=>{memory.set(k,structuredClone(v));writes.push(k);},
    removeStorageSync:k=>memory.delete(k),showToast:()=>{},showModal:o=>o.success({confirm:true}),
    disableAlertBeforeUnload:()=>{},enableAlertBeforeUnload:()=>{},navigateTo:o=>routes.push(o.url),switchTab:o=>routes.push(o.url)};
  const catalog = require('../dist/lib/catalog.js'), c = catalog.getCatalog(), api=require('../dist/lib/api.js');
  const originalRequest=api.request;
  let owner=A, snapshot={revision:4,state:{preferredTerm:'fall',activePlanId:'main',
    plans:[{id:'main',name:'已保存课表',scheduleIds:[c.schedules.find(m=>m.term==='fall').id]}],
    assignments:[{id:'task',title:'网站作业',dueDate:'2026-10-13',completed:false,notes:'',courseId:''}],
    activities:[{id:'event',title:'每周讨论',repeat:'weekly',weekday:1,date:'',block:3,location:'',notes:''}],academicSnapshots:[]}};
  const session=()=>({user:{id:owner,username:owner===A?'student-a':'student-b',displayName:'momo'},deviceToken:'d'.repeat(43),
    session:{accessToken:(owner===A?'A':'B').repeat(43),expiresAt:new Date(Date.now()+3600000).toISOString()}});
  api.request=async(p,o={})=>{calls.push({p,...o});if(p.endsWith('/login'))return session();
    if(p.endsWith('/session'))return {user:session().user};if(p.endsWith('/snapshot'))return structuredClone(snapshot);
    if(p==='/api/catalog/current')return {courses:{fullUrl:publicPath}};if(p===publicPath)return structuredClone(c);
    if(p.endsWith('/logout'))return {};throw new Error('unexpected path');};
  const account=require('../dist/lib/account.js'), cloudView=require('../dist/lib/cloud-view.js');
  return {memory,writes,routes,calls,c,api,originalRequest,account,cloudView,snapshot,setOwner:v=>{owner=v;}};
}
function page(name,options={}) {
  const file=path.join(root,'dist/pages',name,'index.js');let value;
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:createRequire(file),wx,Page:p=>{value=p;},setTimeout,clearTimeout});
  value.data=structuredClone(value.data);value.setData=p=>Object.assign(value.data,p);value.onLoad?.(options);value.onShow?.();return value;
}
const tap=dataset=>({currentTarget:{dataset}});
test('网站考试按北京时间筛选，待定日期保留，不把过期或未确认数据当新安排',()=>{
  const e=environment(),now=new Date('2026-10-13T02:00:00Z'),exams=[
    {id:'past',date:'2026-10-12',courseName:'过去考试'},
    {id:'ended',date:'2026-10-13',startTime:'08:00',endTime:'09:00',courseName:'已结束'},
    {id:'today',date:'2026-10-13',startTime:'10:00',endTime:'11:00',courseName:'今天考试',room:'101',seat:'18',examNumber:'TEST-001'},
    {id:'future',date:'2026-10-14',courseCode:'C02',startTime:'08:00'},
    {id:'unknown',date:'',courseName:'待定考试'}];
  const ctx={readOnly:true,academic:{exams}},before=structuredClone(exams),summary=e.cloudView.examSummary(ctx,now);
  assert.equal(summary.examCount,3);assert.deepEqual(summary.exams.map(e=>e.id),['today','future']);
  assert.equal(summary.exams[0].seat,'18');assert.equal(summary.exams[0].examNumber,'TEST-001');assert.deepEqual(exams,before);
  assert.equal(e.cloudView.examSummary({...ctx,academic:{exams,examStatus:'stale'}},now).examCount,0);
  assert.match(e.cloudView.examSummary({...ctx,academic:{exams,examStatus:'stale'}},now).examNotice,/上次数据/);
  assert.deepEqual(e.cloudView.examSummary({...ctx,readOnly:false},now).exams,[]);
});
test('考试首页和全部安排只读，退出即时清除考场、座位与考号',async()=>{
  const e=environment();e.snapshot.state.academicSnapshots=[{id:'official',term:'fall',academicYear:'2026-2027',importedAt:'2026-10-13T00:00:00Z',sections:[],
    exams:[{id:'e1',date:'2027-01-08',courseName:'考试课程',startTime:'09:00',endTime:'11:00',location:'之远楼 101',seat:'18',examNumber:'TEST-001'}]}];
  await e.account.login('a','pw');await e.account.refresh();const home=page('home'),planner=page('planner');
  assert.equal(home.data.exams.length,1);assert.equal(home.data.exams[0].locationLabel,'之远楼 101');
  assert.ok(planner.data.rows.some(r=>r.kind==='exam'&&r.notes.includes('TEST-001')));
  await e.account.logout();assert.equal(home.data.exams.length,0);assert.ok(!JSON.stringify(planner.data.rows).includes('TEST-001'));
  home.onUnload();planner.onUnload();
});
test('网站账号登录读取真实方案，页面只读，密码不落盘，本机课表不覆盖',async()=>{
  const e=environment(),store=require('../dist/lib/store.js');store.addSections(e.c,[e.c.sections[0].id]);
  const before=structuredClone([...e.memory]);
  await e.account.login('student-a','SyntheticPassword!');await e.account.refresh();
  assert.equal(e.account.current().user.id,A);assert.equal(e.account.current().token,undefined);
  assert.ok(!JSON.stringify([...e.memory]).includes('SyntheticPassword!'));
  assert.deepEqual([...e.memory].filter(([k])=>k!==key),before);
  assert.equal(e.calls.filter(c=>c.p.startsWith('/api/catalog/')).every(c=>!c.token),true);
  const p=page('timetable');assert.equal(p.data.readOnly,true);assert.equal(p.selectedMeetings.length,1);
  assert.equal(p.selectedMeetings[0].id,e.snapshot.state.plans[0].scheduleIds[0]);
  p.open(tap({id:p.selectedMeetings[0].id}));assert.match(e.routes.at(-1),/cloud-detail/);
  const planner=page('planner'),writes=e.writes.length;assert.equal(planner.data.rows.length,2);
  planner.begin(tap({kind:'task'}));planner.toggle(tap({id:'task'}));planner.remove(tap({id:'task'}));planner.save();
  assert.equal(e.writes.length,writes);assert.equal(planner.data.editing,false);
  await e.account.logout();assert.equal(e.account.getCloud(),null);assert.equal(p.data.readOnly,false);assert.equal(planner.data.readOnly,false);
  assert.deepEqual([...e.memory],before);p.onUnload();planner.onUnload();
});
test('退出或A切B后迟到的私人响应不恢复A，也不激活旧目录',async()=>{
  const e=environment();await e.account.login('a','pw');const normal=e.api.request;let release;
  e.api.request=(p,o)=>p.endsWith('/snapshot')?new Promise(r=>{release=r;}):normal(p,o);
  const reading=e.account.refresh();await Promise.resolve();await e.account.logout();
  e.setOwner(B);await e.account.login('b','pw');release(structuredClone(e.snapshot));
  await assert.rejects(reading,/账号已切换/);assert.equal(e.account.current().user.id,B);assert.equal(e.account.getCloud(),null);
  e.api.request=normal;await e.account.refresh();assert.equal(e.account.getCloud().userId,B);
});
test('登出中的迟到登录会撤销新令牌，失败切号不留旧本机会话',async()=>{
  const e=environment();await e.account.login('a','pw');const normal=e.api.request;let release;
  e.api.request=(p,o)=>p.endsWith('/login')?new Promise(r=>{release=r;}):normal(p,o);
  const login=e.account.login('b','pw');assert.equal(e.memory.has(key),false);await e.account.logout();
  release({user:{id:B},deviceToken:'d'.repeat(43),session:{accessToken:'B'.repeat(43),expiresAt:new Date(Date.now()+3600000).toISOString()}});
  await assert.rejects(login,/登录状态已变化/);await Promise.resolve();assert.equal(e.account.current(),null);
  assert.ok(e.calls.some(c=>c.p.endsWith('/logout')&&c.token==='B'.repeat(43)));
});
test('本机存储失败仍撤销服务器会话，读取身份不匹配拒绝私人内容',async()=>{
  const e=environment();await e.account.login('a','pw');wx.removeStorageSync=()=>{throw new Error('storage unavailable');};
  await assert.rejects(e.account.logout(),/清理/);assert.equal(e.account.current(),null);
  assert.ok(e.calls.some(c=>c.p.endsWith('/logout')&&c.token==='A'.repeat(43)));
  wx.removeStorageSync=k=>e.memory.delete(k);await e.account.login('a','pw');e.setOwner(B);
  await assert.rejects(e.account.refresh(),/账号已变化/);assert.equal(e.account.getCloud(),null);
});
test('过期与服务端401清除私有预览，不回落到其他账号内容',async()=>{
  const e=environment();await e.account.login('a','pw');await e.account.refresh();
  const originalNow=Date.now,expiredAt=originalNow()+7200000;
  try{Date.now=()=>expiredAt;assert.equal(e.account.getCloud(),null);assert.equal(e.account.current(),null);assert.equal(e.memory.has(key),false);}
  finally{Date.now=originalNow;}
  await e.account.login('a','pw');await e.account.refresh();
  e.api.request=async()=>{throw Object.assign(new Error('expired'),{status:401});};
  await assert.rejects(e.account.refresh(),/expired/);assert.equal(e.account.current(),null);assert.equal(e.memory.has(key),false);
});
test('教务课表权威空表与选课方案分开，30周/14节及多教师保持原值',async()=>{
  const e=environment();e.snapshot.state.academicSnapshots=[{id:'official',term:'fall',academicYear:'2026-2027',importedAt:'2026-10-12T00:00:00Z',sections:[]}];
  await e.account.login('a','pw');await e.account.refresh();let ctx=e.cloudView.read(e.c);
  assert.equal(ctx.meetings.length,0);assert.equal(ctx.hasAcademic,true);assert.equal(e.cloudView.read(e.c,{planning:true}).meetings.length,1);
  e.snapshot.state.academicSnapshots[0].sections=[{id:'s',courseName:'同名课程',courseCode:'C01',sectionCode:'02',teachers:['甲','乙'],
    meetings:[{id:'exact',weekday:7,block:4,weeks:[9,30],periods:[11,14],campus:'本部',building:'之远楼',room:'101'}]}];
  await e.account.refresh();ctx=e.cloudView.read(e.c);assert.equal(ctx.maximumWeek,30);assert.deepEqual(ctx.meetings[0].weeks,[9,30]);
  assert.equal(ctx.meetings[0].teacher,'甲 / 乙');assert.equal(ctx.meetings[0].courseId,'academic:C01:02');
  const p=page('timetable');p.weekChange({detail:{value:29}});assert.ok(p.data.grid[3].days.at(-1).meetings.some(m=>m.id==='exact'));
  p.open(tap({id:'exact'}));const detail=page('cloud-detail',{id:'exact',term:'fall'});assert.equal(detail.data.meeting.id,'exact');
  await e.account.logout();detail.onShow();assert.equal(detail.data.meeting,null);p.onUnload();
});
test('切到本机内容不会合并网站快照，公开目录拒绝重复/损坏身份',async()=>{
  const e=environment();await e.account.login('a','pw');await e.account.refresh();e.account.useLocal();
  assert.equal(e.cloudView.read(e.c).readOnly,false);e.account.useWebsite();assert.equal(e.cloudView.read(e.c).readOnly,true);
  const catalog=require('../dist/lib/catalog.js'),bad=structuredClone(e.c);bad.schedules.push(bad.schedules[0]);
  assert.throws(()=>catalog.prepareRemote(bad),/格式/);bad.schedules.pop();bad.schedules[0].weeks=[31];assert.throws(()=>catalog.prepareRemote(bad),/格式/);
});
test('请求只能访问固定HTTPS本站路径，公网目录无凭据，错误不会透传服务器正文',async()=>{
  const e=environment();e.api.request=e.originalRequest;const requests=[];
  wx.request=o=>{requests.push(o);o.success({statusCode:200,data:{ok:true}});};
  await e.api.request('/api/auth/miniprogram/session',{token:'A'.repeat(43)});await e.api.request('/api/catalog/current');
  assert.equal(requests[0].header.Authorization,'Bearer '+'A'.repeat(43));assert.equal(requests[1].header.Authorization,undefined);
  assert.equal(requests[0].url,'https://dufesh.cn/api/auth/miniprogram/session');
  await assert.rejects(e.api.request('https://example.com'),/请求/);assert.equal(requests.length,2);
  wx.request=o=>o.success({statusCode:401,data:{error:'sensitive raw text'}});
  await assert.rejects(e.api.request('/api/auth/miniprogram/session'),e=>e.status===401&&!e.message.includes('sensitive'));
});
