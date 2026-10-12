import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createAuthStore } from '../services/auth-api/src/db.mjs';
import { createAuthServer } from '../services/auth-api/src/server.mjs';
import { createPasswordService } from '../services/auth-api/src/passwords.mjs';
import { validateSyncWrite } from '../services/auth-api/src/sync-contract.mjs';
import { createOpaqueToken, tokenDigest } from '../services/auth-api/src/tokens.mjs';
import { parseTrustedProxies } from '../services/auth-api/src/request-security.mjs';
async function databasePool() {
  if(process.env.POSTGRES_INTEGRATION==='true'){
    if(process.env.PGHOST!=='127.0.0.1'||!/^dufesh_[a-z_]*(?:ci|test)$/.test(process.env.POSTGRES_DB??'')||!process.env.AUTH_DB_USER||!process.env.AUTH_DB_PASSWORD) throw new Error('Requires isolated loopback test database');
    return new pg.Pool({host:'127.0.0.1',port:Number(process.env.PGPORT),database:process.env.POSTGRES_DB,
      user:process.env.AUTH_DB_USER,password:process.env.AUTH_DB_PASSWORD,max:4});
  }
  const db=new PGlite();await db.waitReady;
  for(const name of (await fs.readdir('ops/postgres/migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.exec(await fs.readFile('ops/postgres/migrations/'+name,'utf8'));
  let tail=Promise.resolve();
  async function lock(){const previous=tail;let release;tail=new Promise(r=>{release=r;});await previous;return release;}
  async function query(sql,params){const result=await db.query(sql,params);return {...result,rowCount:result.rows.length||result.affectedRows||0};}
  return {async connect(){const release=await lock();return {query,release};},async query(sql,params){const release=await lock();try{return await query(sql,params);}finally{release();}},end:()=>db.close()};
}
test('原生账号真实数据库与HTTP集成：既有账号、网站快照、凭据隔离及撤销', {timeout:120000}, async t=>{
  const pool=await databasePool(),store=createAuthStore(pool),passwordService=createPasswordService();
  const password='Synthetic-native-integration-67!',pepper='synthetic-native-integration-pepper-32characters';
  const userIds=[],limiter={consume:async()=>true};let server;
  try{
    const passwordHash=await passwordService.hash(password);
    async function seed(label){const id=randomUUID(),username='native_'+id.slice(0,12).replaceAll('-','');userIds.push(id);
      await pool.query("INSERT INTO app_users(id,username,normalized_username,email,normalized_email,registered_via) VALUES($1,$2,$2,$3,$3,'password')",[id,username,`native-${id}@example.com`]);
      await pool.query('INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)',[id,passwordHash]);
      await store.replacePersonalState(id,validateSyncWrite({mutationId:'mini-fixture-'+randomUUID(),baseRevision:0,clientUpdatedAt:new Date().toISOString(),state:{
        profile:null,skipped:false,plans:[{id:'default',name:label,scheduleIds:['meeting-'+label]},{id:'alternate',name:'另一个方案',scheduleIds:[]}],activePlanId:'default',
        activities:[],assignments:[],academicSnapshots:[],trainingPlan:null,favoriteRooms:[],recentRooms:[],preferredTerm:'fall',theme:'system'}}));
      return {id,username};}
    const a=await seed('A'),b=await seed('B');
    server=createAuthServer({store,passwordService,config:{miniProgramEnabled:true,credentialsEnabled:true,registrationMode:'disabled',passwordResetMode:'disabled',
      emailVerificationMode:'disabled',tokenPepper:pepper,sessionMaxAgeSeconds:2592000,sessionCookie:'__Host-dufesh_session',deviceCookie:'__Host-dufesh_device',
      allowedOrigins:new Set(['https://dufesh.cn']),trustedProxyRanges:parseTrustedProxies('127.0.0.1/32')},
      rateLimiters:{read:limiter,write:limiter,credential:limiter,authNetwork:limiter,authAccount:limiter}});
    server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
    async function request(path,options={}){const r=await fetch(base+path,options);return {status:r.status,body:await r.json()};}
    const login=user=>request('/api/auth/miniprogram/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:user.username,password})});
    const one=await login(a),two=await login(b);
    await t.test('登录原有账号，不创建另一套用户；完整读取现有多个方案',async()=>{
      assert.equal(one.status,200);assert.equal(two.status,200);assert.equal(one.body.user.id,a.id);assert.equal(two.body.user.id,b.id);
      const snapshot=await request('/api/auth/miniprogram/snapshot',{headers:{Authorization:'Bearer '+one.body.session.accessToken,Cookie:'__Host-dufesh_session='+two.body.session.accessToken}});
      assert.equal(snapshot.status,200);assert.deepEqual(snapshot.body,await store.getPersonalState(a.id));
      assert.equal(snapshot.body.state.plans.find(p=>p.id==='default').name,'A');assert.equal(snapshot.body.state.plans.length,2);
    });
    await t.test('数据库中的网页会话和原生会话不能互用',async()=>{
      const web=createOpaqueToken(),device=await store.getOrCreateAnonymousDevice(tokenDigest(createOpaqueToken(),pepper));
      await store.createCredentialSession({userId:a.id,anonymousDeviceId:device.id,expectedPasswordHash:passwordHash,sessionTokenHash:tokenDigest(web,pepper),sessionExpiresAt:new Date(Date.now()+60000)});
      assert.equal((await request('/api/auth/miniprogram/session',{headers:{Authorization:'Bearer '+web}})).status,401);
      assert.equal((await request('/api/auth/sync',{headers:{Cookie:'__Host-dufesh_session='+one.body.session.accessToken}})).status,401);
      assert.equal((await request('/api/auth/sync',{headers:{Cookie:'__Host-dufesh_session='+web}})).status,200);
    });
    await t.test('撤销原生A会话后A不可读，B与网站快照继续保留',async()=>{
      assert.equal((await request('/api/auth/miniprogram/logout',{method:'POST',headers:{Authorization:'Bearer '+one.body.session.accessToken}})).status,200);
      assert.equal((await request('/api/auth/miniprogram/snapshot',{headers:{Authorization:'Bearer '+one.body.session.accessToken}})).status,401);
      assert.equal((await request('/api/auth/miniprogram/snapshot',{headers:{Authorization:'Bearer '+two.body.session.accessToken}})).status,200);
      assert.equal((await store.getPersonalState(a.id)).revision,1);assert.equal((await store.getPersonalState(b.id)).revision,1);
    });
  }finally{
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    for(const id of userIds)await pool.query('DELETE FROM app_users WHERE id=$1',[id]);
    await pool.end();
  }
});
