const BASE = 'https://dufesh.cn';
function allowed(path) { return /^\/api\/auth\/miniprogram\/(login|session|logout|snapshot|capabilities|wechat(?:\/bind)?)$/.test(path) ||
  path === '/api/catalog/current' || /^\/api\/catalog\/releases\/[a-f0-9]{64}\/full$/.test(path); }
function request(path, options = {}) {
  if (!allowed(path)) return Promise.reject(new Error('请求地址不可用。'));
  return new Promise((resolve, reject) => {
    const header = { 'Content-Type': 'application/json' };
    if (options.token) header.Authorization = 'Bearer ' + options.token;
    if (options.device) header['X-Dufesh-Mini-Device'] = options.device;
    wx.request({ url: BASE + path, method: options.method || 'GET', header, data: options.data,
      timeout: 15000, success(r) {
        if (r.statusCode === 200) { resolve(r.data); return; }
        const known = {invalid_binding_credentials:'密码不正确，请重新输入后确认绑定。',wechat_account_conflict:'微信与账号已有其他绑定，请使用原来的登录方式。',
          binding_challenge_expired:'绑定验证已过期，请重新验证微信。',wechat_login_failed:'微信验证已失效，请重新验证微信。',
          wechat_login_unavailable:'微信登录暂未开放，请使用网站账号登录。',account_changed:'账号已变化，请重新验证微信。',authentication_required:'登录已过期，请重新登录。'};
        const code = typeof r.data?.error==='string' && Object.prototype.hasOwnProperty.call(known,r.data.error) ? r.data.error : '';
        const message = code ? known[code] : r.statusCode === 401 ? (path.endsWith('/login') ? '账号或密码不正确，请重试。' : '登录已过期，请重新登录。') :
          r.statusCode === 429 ? '操作太频繁，请稍后重试。' : r.statusCode === 503 ? '服务暂时不可用，请稍后重试。' : '暂时无法完成，请稍后重试。';
        const error = new Error(message); error.status = r.statusCode;if(code)error.code=code; reject(error);
      }, fail() { reject(new Error('连接失败，请检查网络后重试。')); }
    });
  });
}
module.exports = { request };
