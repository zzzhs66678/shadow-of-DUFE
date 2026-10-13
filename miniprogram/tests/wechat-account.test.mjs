import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),A='11111111-1111-4111-8111-111111111111',KEY='dufesh.mini.account.v1';
function environment(){
  for(const lib of ['account','api','catalog','cloud-view','store','planner'])delete require.cache[require.resolve('../dist/lib/'+lib+'.js')];
  const memory=new Map(),calls=[],c=require('../dist/lib/catalog.js').getCatalog(),api=require('../dist/lib/api.js'),original=api.request;
  let linked=false,mode='unlinked',wxCalls=0;
  globalThis.wx={getStorageSync:k=>memory.get(k)||'',setStorageSync:(k,v)=>memory.set(k,structuredClone(v)),removeStorageSync:k=>memory.delete(k),
    login:o=>{wxCalls++;o.success({code:'synthetic-wx-code'});},showToast:()=>{},navigateTo:()=>{},switchTab:()=>{}};
  const user={id:A,username:'existing-student',displayName:'momo'},expiresAt=new Date(Date.now()+3600000).toISOString();
  const session=()=>({authenticated:true,user,deviceToken:'d'.repeat(43),session:{accessToken:'A'.repeat(43),expiresAt}});
  const fail=(code,status)=>{throw Object.assign(new Error(code),{code,status});};
  api.request=async(p,o={})=>{calls.push({p,...o});
    if(p.endsWith('/capabilities'))return {wechatLogin:mode!=='off',wechatBinding:mode!=='off'};
    if(p.endsWith('/login'))return session();if(p.endsWith('/logout'))return {};
    if(p.endsWith('/session'))return {authenticated:true,user,wechatLinked:linked};
    if(p.endsWith('/snapshot'))return {revision:1,state:{preferredTerm:'fall',activePlanId:'p',plans:[{id:'p',name:'已保存课表',scheduleIds:[]}],activities:[],assignments:[],academicSnapshots:[]}};
    if(p==='/api/catalog/current')return {courses:{fullUrl:'/api/catalog/releases/'+'a'.repeat(64)+'/full'}};
    if(p.startsWith('/api/catalog/releases/'))return structuredClone(c);
    if(p.endsWith('/wechat')){
      if(mode==='expired-session')fail('authentication_required',401);if(mode==='expired-code')fail('wechat_login_failed',401);if(mode==='conflict')fail('wechat_account_conflict',409);
      if(mode==='linked')return o.token?{authenticated:true,linked:true,user,session:{expiresAt}}:session();
      return {authenticated:false,needsBinding:true,binding:{challengeToken:'c'.repeat(43),expiresAt:new Date(Date.now()+5*60000).toISOString(),requiresAuthenticatedExchange:!o.token}};
    }
    if(p.endsWith('/wechat/bind')){if(mode==='wrong-password')fail('invalid_binding_credentials',401);if(mode==='expired-challenge')fail('binding_challenge_expired',409);
      linked=true;return {authenticated:true,linked:true,user,session:{expiresAt}};}
    throw new Error('Unexpected test endpoint');
  };
  return {memory,calls,api,original,account:require('../dist/lib/account.js'),setMode:v=>{mode=v;},wxCalls:()=>wxCalls,session};
}
function page(){let p;const file=require.resolve('../dist/pages/account/index.js');vm.runInNewContext(fs.readFileSync(file,'utf8'),{wx,require:createRequire(file),Page:value=>{p=value;}});
  p.data=structuredClone(p.data);p.setData=patch=>Object.assign(p.data,patch);p.onShow();return p;}
test('未开放时不调用wx.login或生成占位会话',async()=>{
  const e=environment();e.setMode('off');assert.equal((await e.account.capabilities()).wechatLogin,false);
  await assert.rejects(e.account.beginWechat(),/暂未开放/);assert.equal(e.wxCalls(),0);assert.equal(e.account.current(),null);assert.equal(e.memory.size,0);
});
test('首次微信绑定先登录已有账号再取新挑战，确认后仍使用原UUID且密码和code不落盘',async()=>{
  const e=environment(),p=page();await p.wechat();assert.equal(p.data.linkRequired,true);assert.equal(e.account.current(),null);
  assert.ok(!JSON.stringify([...e.memory]).includes('c'.repeat(43)));
  p.setData({identifier:'existing-student',password:'SyntheticPassword!'});await p.login();assert.equal(p.data.bindingPrompt,true);assert.equal(e.wxCalls(),2);
  const requests=e.calls.filter(c=>c.p.endsWith('/wechat'));assert.equal(requests[0].token,undefined);assert.equal(requests[1].token,'A'.repeat(43));
  p.setData({password:'SyntheticPassword!'});await p.confirmBinding();assert.equal(p.data.wechatLinked,true);assert.equal(p.data.password,'');
  const bind=e.calls.find(c=>c.p.endsWith('/wechat/bind'));assert.equal(bind.data.expectedOwner,A);assert.equal(e.account.current().user.id,A);
  assert.ok(!JSON.stringify([...e.memory]).includes('synthetic-wx-code'));assert.ok(!JSON.stringify([...e.memory]).includes('SyntheticPassword!'));p.onUnload();
});
test('密码重验失败保留本站会话，挑战失效后不重复消费旧挑战',async()=>{
  const e=environment();await e.account.login('a','pw');await e.account.beginWechat();e.setMode('wrong-password');
  await assert.rejects(e.account.confirmWechatBinding('wrong'),e=>e.code==='invalid_binding_credentials');assert.equal(e.account.current().user.id,A);
  e.setMode('expired-challenge');await assert.rejects(e.account.confirmWechatBinding('pw'),e=>e.code==='binding_challenge_expired');
  const count=e.calls.length;await assert.rejects(e.account.confirmWechatBinding('pw'),/已过期/);assert.equal(e.calls.length,count);
});
test('会话撤销清除私人预览，单独微信code失效保留有效本站会话',async()=>{
  const e=environment();await e.account.login('a','pw');await e.account.refresh();e.setMode('expired-code');
  await assert.rejects(e.account.beginWechat(),e=>e.code==='wechat_login_failed');assert.equal(e.account.current().user.id,A);assert.ok(e.account.getCloud());
  e.setMode('expired-session');await assert.rejects(e.account.beginWechat(),e=>e.code==='authentication_required');
  assert.equal(e.account.current(),null);assert.equal(e.account.getCloud(),null);assert.equal(e.memory.has(KEY),false);
});
test('退出后迟到的微信登录不能恢复账号，临时新令牌会撤销',async()=>{
  const e=environment();e.setMode('linked');const normal=e.api.request;let release;
  e.api.request=(p,o)=>p.endsWith('/wechat')?new Promise(r=>{release=r;}):normal(p,o);
  const result=e.account.beginWechat();while(!release)await Promise.resolve();await e.account.logout();release(e.session());
  await assert.rejects(result,/操作已变化/);await Promise.resolve();assert.equal(e.account.current(),null);assert.ok(e.calls.some(c=>c.p.endsWith('/logout')&&c.token==='A'.repeat(43)));
});
test('已绑定他人微信不切号，隐藏页面后迟到验证不恢复绑定确认',async()=>{
  const e=environment();await e.account.login('a','pw');await e.account.refresh();e.setMode('conflict');
  await assert.rejects(e.account.beginWechat(),e=>e.code==='wechat_account_conflict');assert.equal(e.account.current().user.id,A);assert.ok(e.account.getCloud());
  e.setMode('unlinked');const normal=e.api.request;let release;e.api.request=(p,o)=>p.endsWith('/wechat')?new Promise(r=>{release=r;}):normal(p,o);
  const p=page(),pending=p.wechat();while(!release)await Promise.resolve();p.onHide();release({authenticated:false,needsBinding:true,binding:{challengeToken:'c'.repeat(43),expiresAt:new Date(Date.now()+5*60000).toISOString(),requiresAuthenticatedExchange:false}});
  await pending;assert.equal(p.data.bindingPrompt,false);assert.equal(p.data.password,'');assert.equal(e.account.current().user.id,A);p.onUnload();
});
test('已知绑定错误给固定提示，不透传微信原始响应',async()=>{
  const e=environment();e.api.request=e.original;wx.request=o=>o.success({statusCode:409,data:{error:'binding_challenge_expired',detail:'secret upstream text'}});
  await assert.rejects(e.api.request('/api/auth/miniprogram/wechat/bind'),e=>e.code==='binding_challenge_expired'&&/已过期/.test(e.message)&&!e.message.includes('secret'));
  wx.request=o=>o.success({statusCode:401,data:{error:'wechat_login_failed'}});
  await assert.rejects(e.api.request('/api/auth/miniprogram/wechat'),e=>e.code==='wechat_login_failed'&&!e.message.includes('登录已过期'));
});
