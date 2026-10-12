import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createAuthServer } from '../src/server.mjs';
import { createOpaqueToken, tokenDigest } from '../src/tokens.mjs';
import { miniSessionDigest } from '../src/miniprogram-routes.mjs';
import { parseTrustedProxies } from '../src/request-security.mjs';

const pepper = 'synthetic-native-api-pepper-for-tests-32-characters';
async function fixture(overrides = {}) {
  const user = { id: randomUUID(), username: 'fixture', displayName: 'momo', nameMode: 'momo',
    passwordHash: 'synthetic-hash', status: 'active' };
  const sessions = new Map(), failures = [], writes = [];
  let budget = true, race = false, revokeOnRead = false;
  const store = {
    async getCredentialPrincipal(id) { return id === 'fixture' ? {...user} : null; },
    async recordCredentialFailure(id) { failures.push(id); },
    async getOrCreateAnonymousDevice(hash) { writes.push(['device',hash]); return {id:randomUUID()}; },
    async createCredentialSession(input) {
      if (race) { const e=new Error('race'); e.code='AUTH_CREDENTIAL_LOGIN_REJECTED'; throw e; }
      writes.push(['session',input]);
      sessions.set(input.sessionTokenHash,{ id:randomUUID(),userId:input.userId,username:user.username,
        displayName:user.displayName,nameMode:'momo',expiresAt:input.sessionExpiresAt.toISOString() });
    },
    async getActiveSession(hash) { return sessions.get(hash) || null; },
    async revokeSession(hash) { sessions.delete(hash); },
    async getPersonalState(id) {
      if(revokeOnRead) sessions.clear();
      return {revision:3,state:{profile:null,plans:[{id:'default',name:'fixture',scheduleIds:[]}],ownerFixture:id}};
    }
  };
  const limiter={consume:async()=>budget};
  const config={tokenPepper:pepper,miniProgramEnabled:true,credentialsEnabled:true,registrationMode:'disabled',
    passwordResetMode:'disabled',emailVerificationMode:'disabled',allowedOrigins:new Set(['https://dufesh.cn']),
    sessionCookie:'__Host-dufesh_session',deviceCookie:'__Host-dufesh_device',sessionMaxAgeSeconds:2592000,
    trustedProxyRanges:parseTrustedProxies('127.0.0.1/32'),...overrides};
  const server=createAuthServer({store,config,passwordService:{hash:async()=> 'dummy',verify:async(h,p)=>h==='synthetic-hash'&&p==='fixture-password'},
    rateLimiters:{read:limiter,write:limiter,credential:limiter,authNetwork:limiter,authAccount:limiter}});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  async function request(path,options={}) {const r=await fetch(base+path,options);return {r,body:await r.json()};}
  const login=(body={identifier:'fixture',password:'fixture-password'},headers={})=>request('/api/auth/miniprogram/login',
    {method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  return {user,sessions,failures,writes,login,request,config,
    budget(value){budget=value;},race(){race=true;},revokeOnRead(){revokeOnRead=true;},
    close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
test('原生登录沿用网站UUID和momo，返回短期独立会话且不设置网站Cookie',async()=>{
  const f=await fixture();try{
    const {r,body}=await f.login();assert.equal(r.status,200);assert.equal(body.user.id,f.user.id);assert.equal(body.user.nameMode,'momo');
    assert.equal(r.headers.get('set-cookie'),null);assert.match(r.headers.get('cache-control'),/no-store/);
    assert.equal(body.session.accessToken.length,43);assert.ok(Date.parse(body.session.expiresAt)-Date.now()<=86400000);
    const hash=f.writes.find(w=>w[0]==='session')[1].sessionTokenHash;
    assert.equal(hash,miniSessionDigest(body.session.accessToken,pepper));assert.notEqual(hash,tokenDigest(body.session.accessToken,pepper));
    const session=await f.request('/api/auth/miniprogram/session',{headers:{Authorization:'Bearer '+body.session.accessToken}});
    assert.equal(session.body.user.id,f.user.id);assert.equal(session.body.session.accessToken,undefined);
  }finally{await f.close();}
});
test('原生bearer与网站Cookie双向不能替代，快照只能属于认证账号',async()=>{
  const f=await fixture();try{
    const {body}=await f.login();const token=body.session.accessToken;
    assert.equal((await f.request('/api/auth/sync',{headers:{Cookie:'__Host-dufesh_session='+token}})).r.status,401);
    assert.equal((await f.request('/api/auth/miniprogram/snapshot',{headers:{Cookie:'__Host-dufesh_session='+token}})).r.status,401);
    const webToken=createOpaqueToken();f.sessions.set(tokenDigest(webToken,pepper),{id:'web',userId:f.user.id});
    assert.equal((await f.request('/api/auth/miniprogram/snapshot',{headers:{Authorization:'Bearer '+webToken}})).r.status,401);
    const native=await f.request('/api/auth/miniprogram/snapshot',{headers:{Authorization:'Bearer '+token}});
    assert.equal(native.body.state.ownerFixture,f.user.id);assert.equal(native.body.revision,3);
    assert.equal((await f.request('/api/auth/miniprogram/snapshot?userId=other',{headers:{Authorization:'Bearer '+token}})).r.status,400);
  }finally{await f.close();}
});
test('退出和读取过程中撤销后不返回私人快照，原生接口不提供写课表',async()=>{
  const f=await fixture();try{
    const {body}=await f.login();const headers={Authorization:'Bearer '+body.session.accessToken};
    assert.equal((await f.request('/api/auth/miniprogram/snapshot',{method:'PUT',headers})).r.status,405);
    f.revokeOnRead();assert.equal((await f.request('/api/auth/miniprogram/snapshot',{headers})).r.status,401);
    const second=await f.login();const h={Authorization:'Bearer '+second.body.session.accessToken};
    assert.equal((await f.request('/api/auth/miniprogram/logout',{method:'POST',headers:h})).r.status,200);
    assert.equal((await f.request('/api/auth/miniprogram/session',{headers:h})).r.status,401);
  }finally{await f.close();}
});
test('禁用配置、浏览器Origin、HTTP、无效JSON与额外字段均拒绝',async()=>{
  const f=await fixture();try{
    for(const origin of ['https://dufesh.cn','https://other.invalid','null']) assert.equal((await f.login(undefined,{Origin:origin})).r.status,403);
    assert.equal((await f.login({identifier:'fixture',password:'fixture-password',userId:f.user.id})).r.status,401);
    assert.equal((await f.request('/api/auth/miniprogram/login',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).r.status,400);
    assert.equal((await f.request('/api/auth/miniprogram/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).r.status,400);
    assert.equal(f.writes.length,0);
  }finally{await f.close();}
  for(const config of [{miniProgramEnabled:false},{requireHttps:true}]){
    const disabled=await fixture(config);try{assert.equal((await disabled.login()).r.status,config.requireHttps?403:503);}finally{await disabled.close();}
  }
});
test('错误密码、锁定和改密竞争拒绝登录，共用认证限额',async()=>{
  const f=await fixture();try{
    assert.equal((await f.login({identifier:'fixture',password:'wrong'})).r.status,401);assert.equal(f.failures.length,1);
    f.user.lockedUntil=new Date(Date.now()+60000);assert.equal((await f.login()).r.status,401);assert.equal(f.failures.length,1);
    delete f.user.lockedUntil;f.race();assert.equal((await f.login()).r.status,401);assert.equal(f.sessions.size,0);
    f.budget(false);assert.equal((await f.login()).r.status,429);
  }finally{await f.close();}
});
