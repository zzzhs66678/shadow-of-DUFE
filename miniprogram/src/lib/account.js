const api = require('./api');
const preview = require('./website-preview');
const catalog = require('./catalog');
const KEY = 'dufesh.mini.account.v1';
let session = null, epoch = 0, cloud = null, source = 'local', reading = null, binding = null, wechatFlow = 0;
const listeners = new Set();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function expire() { if(session && Date.parse(session.expiresAt)<=Date.now()){clear();try{wx.removeStorageSync(KEY);}catch{/* memory is cleared even if storage is unavailable */}} }
function current() { expire();return session ? { user: { ...session.user }, expiresAt: session.expiresAt, source, wechatLinked:session.wechatLinked===true } : null; }
function context() { expire();return session ? { userId: session.user.id, epoch } : null; }
function notify() { for (const listener of listeners) { try { listener(); } catch { /* one hidden page cannot prevent clearing others */ } } }
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function clear() { epoch++;wechatFlow++;binding=null;session = null; cloud = null; source = 'local'; reading = null; notify(); }
function validSession(s) { return s && s.version === 1 && uuid(s.user?.id) && typeof s.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s.token) &&
  typeof s.device === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s.device) && Number.isFinite(Date.parse(s.expiresAt)) && Date.parse(s.expiresAt) > Date.now(); }
function restore() {
  const value = wx.getStorageSync(KEY);
  if (value && validSession(value)) { session = value; epoch++; source = 'website'; notify(); }
}
async function retire(token) { try { await api.request('/api/auth/miniprogram/logout', { method: 'POST', token, data: {} }); } catch { /* token is server-expiring; never restore local access */ } }
async function login(identifier, password) {
  const old = session; clear(); const turn = epoch;
  if (old) void retire(old.token);
  try { wx.removeStorageSync(KEY); } catch { throw new Error('无法清除旧登录状态，请先清理此小程序数据。'); }
  const result = await api.request('/api/auth/miniprogram/login', { method: 'POST', data: { identifier, password }, device: old?.device });
  const next = { version: 1, user: result.user, token: result.session?.accessToken, expiresAt: result.session?.expiresAt, device: result.deviceToken };
  if (epoch !== turn) { if (next.token) void retire(next.token); throw new Error('登录状态已变化，请重新登录。'); }
  if (!validSession(next)) throw new Error('登录信息无法读取，请稍后重试。');
  try { wx.setStorageSync(KEY, next); } catch { void retire(next.token); throw new Error('无法保存登录状态，请检查微信存储空间。'); }
  session = next; cloud = null; source = 'website'; notify(); return current();
}
async function refresh() {
  expire();
  if (!session) return null;
  if (reading) return reading;
  const ticket = preview.readTicket(context()), token = session.token;
  const promise = (async () => {
    try {
      const [identity, snapshot, publicCatalog] = await Promise.all([
        api.request('/api/auth/miniprogram/session', { token }), api.request('/api/auth/miniprogram/snapshot', { token }),
        (async () => { const manifest = await api.request('/api/catalog/current');
          const path = manifest.courses?.fullUrl;
          if (!/^\/api\/catalog\/releases\/[a-f0-9]{64}\/full$/.test(path || '')) throw new Error('课程目录暂时无法读取。');
          return catalog.prepareRemote(await api.request(path)); })()
      ]);
      if (identity.user?.id !== ticket.userId) throw new Error('账号已变化，请重新登录。');
      const value = preview.acceptSnapshot(ticket, context(), snapshot, publicCatalog);
      session.user = { ...identity.user };
      if(typeof identity.wechatLinked==='boolean')session.wechatLinked=identity.wechatLinked;
      catalog.activateRemote(publicCatalog); cloud = value; notify(); return value;
    } catch (error) {
      if (error.status === 401 && context()?.epoch === ticket.epoch) { clear(); try { wx.removeStorageSync(KEY); } catch { /* cleared in memory; no private preview is retained */ } }
      throw error;
    } finally { if (reading === promise) reading = null; }
  })();
  reading = promise; return promise;
}
async function logout() {
  const old = session; clear();
  let storageError = false;
  try { wx.removeStorageSync(KEY); } catch { storageError = true; }
  if (old) await api.request('/api/auth/miniprogram/logout', { method: 'POST', token: old.token, data: {} });
  if (storageError) throw new Error('服务器会话已退出；请在微信设置中清理此小程序数据。');
}
function getCloud() { expire();return session && cloud?.userId === session.user.id && cloud.epoch === epoch ? cloud : null; }
function useLocal() { source = 'local'; notify(); }
function useWebsite() { if (!session) throw new Error('请先登录网站账号。'); source = 'website'; notify(); }
function websiteSource() { expire();return Boolean(session && source === 'website'); }
async function capabilities() {
  try { const value=await api.request('/api/auth/miniprogram/capabilities');
    return {wechatLogin:value?.wechatLogin===true,wechatBinding:value?.wechatBinding===true};
  } catch { return {wechatLogin:false,wechatBinding:false}; }
}
function cancelBinding() { binding=null;wechatFlow++; }
function wxCode() {
  return new Promise((resolve,reject)=>{
    if(typeof wx.login!=='function'){reject(new Error('请在微信中打开小程序后重试。'));return;}
    wx.login({timeout:10000,success(result){if(typeof result.code==='string' && result.code)resolve(result.code);
      else reject(new Error('微信验证未完成，请重试。'));},fail(){reject(new Error('微信验证未完成，请重试。'));}});
  });
}
function sameWechatTurn(turn,flow,owner) {
  expire();if(epoch!==turn || wechatFlow!==flow || (session?.user.id || null)!==owner)throw new Error('账号或绑定操作已变化，请重新验证微信。');
}
async function beginWechat() {
  expire();cancelBinding();const turn=epoch,flow=wechatFlow,old=session,owner=old?.user.id || null;
  const available=await capabilities();sameWechatTurn(turn,flow,owner);
  if(!available.wechatLogin || (old && !available.wechatBinding))throw new Error('微信登录暂未开放，请使用网站账号登录。');
  const code=await wxCode();sameWechatTurn(turn,flow,owner);
  let result;
  try{result=await api.request('/api/auth/miniprogram/wechat',{method:'POST',token:old?.token,device:old?.device,data:{code}});}
  catch(error){if(error.code==='authentication_required' && epoch===turn && wechatFlow===flow){clear();try{wx.removeStorageSync(KEY);}catch{/* private preview is cleared in memory */}}throw error;}
  try{sameWechatTurn(turn,flow,owner);}catch(error){if(result.session?.accessToken)void retire(result.session.accessToken);throw error;}
  if(result.authenticated===true && result.session?.accessToken && !old){
    const next={version:1,user:result.user,token:result.session.accessToken,expiresAt:result.session.expiresAt,device:result.deviceToken,wechatLinked:true};
    if(!validSession(next)){void retire(next.token);throw new Error('微信登录信息无法读取，请稍后重试。');}
    try{wx.setStorageSync(KEY,next);}catch{void retire(next.token);throw new Error('无法保存登录状态，请检查微信存储空间。');}
    session=next;cloud=null;source='website';epoch++;wechatFlow++;notify();return {authenticated:true,linked:true};
  }
  if(result.authenticated===true && result.linked===true && old && result.user?.id===owner){
    session.wechatLinked=true;notify();return {authenticated:true,linked:true};
  }
  const pending=result.binding;
  if(result.needsBinding!==true || result.authenticated!==false || typeof pending?.challengeToken!=='string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(pending.challengeToken) || !Number.isFinite(Date.parse(pending.expiresAt)) ||
    Date.parse(pending.expiresAt)<=Date.now() || Date.parse(pending.expiresAt)>Date.now()+10*60000 ||
    pending.requiresAuthenticatedExchange!==!old)throw new Error('微信绑定信息无法读取，请重新验证。');
  binding={token:pending.challengeToken,expiresAt:pending.expiresAt,owner,epoch:turn,flow};
  return {needsBinding:true,requiresLogin:!old,expiresAt:binding.expiresAt};
}
async function confirmWechatBinding(password) {
  expire();const pending=binding,old=session;
  if(!pending || !old || pending.owner!==old.user.id || pending.epoch!==epoch || pending.flow!==wechatFlow || Date.parse(pending.expiresAt)<=Date.now()){
    cancelBinding();throw Object.assign(new Error('绑定验证已过期，请重新验证微信。'),{code:'binding_challenge_expired'});
  }
  if(typeof password!=='string' || !password)throw new Error('请输入网站密码确认绑定。');
  try{
    const result=await api.request('/api/auth/miniprogram/wechat/bind',{method:'POST',token:old.token,
      data:{challengeToken:pending.token,expectedOwner:pending.owner,password}});
    sameWechatTurn(pending.epoch,pending.flow,pending.owner);
    if(result.authenticated!==true || result.linked!==true || result.user?.id!==pending.owner)throw new Error('绑定结果无法确认，请重新读取账号状态。');
    binding=null;session.wechatLinked=true;notify();return current();
  }catch(error){
    if(error.code==='authentication_required' && epoch===pending.epoch){clear();try{wx.removeStorageSync(KEY);}catch{/* private preview is cleared in memory */}}
    else if(['binding_challenge_expired','account_changed','wechat_account_conflict'].includes(error.code) && wechatFlow===pending.flow)cancelBinding();
    throw error;
  }
}
module.exports = { current, context, subscribe, restore, login, refresh, logout, getCloud, useLocal, useWebsite, websiteSource,
  capabilities,beginWechat,confirmWechatBinding,cancelBinding };
