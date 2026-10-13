// Public school entry URLs, no session values or school credentials.
const LINKS = {
  library: 'https://web.traceint.com/web/index.html#/pages/index/index',
  campusCard: 'https://sso.dufe.edu.cn/app.php/open_apps/person_card/index?sessionid=',
  ginkgo: 'https://ginkgostu.dufe.edu.cn/notice/system'
};
function copy(key) { const url = LINKS[key]; if (!url) return;
  wx.setClipboardData({ data: url, success: () => wx.showToast({ title: '入口链接已复制', icon: 'none' }),
    fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }); }
module.exports = { LINKS, copy };
