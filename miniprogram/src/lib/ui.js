function error(err) { wx.showModal({ title: '暂时无法完成', content: err.message || '请稍后重试。', showCancel: false }); }
function safely(fn) { try { return fn(); } catch (err) { error(err); return null; } }
function detail(id, term, meetingId) { wx.navigateTo({ url: '/pages/detail/index?id=' + encodeURIComponent(id) + '&term=' + term + (meetingId ? '&meeting=' + encodeURIComponent(meetingId) : '') }); }
function termLabel(term) { return term === 'fall' ? '上学期' : '下学期'; }
function queryValue(value) { if (typeof value !== 'string') return ''; try { return decodeURIComponent(value); } catch { return ''; } }
module.exports = { error, safely, detail, termLabel, queryValue };
