const { getCatalog } = require('../../lib/catalog');
const domain = require('../../lib/domain');
const store = require('../../lib/store');
const planner = require('../../lib/planner');
const ui = require('../../lib/ui');
Page({
  data: { terms: ['上学期', '下学期'], termIndex: 0, weeks: Array.from({ length: 18 }, (_, i) => '第' + (i + 1) + '周'), weekIndex: 0, startDate: '', auto: false },
  onShow() { ui.safely(() => { this.state = store.load(getCatalog()); this.setData({ termIndex: this.state.term === 'fall' ? 0 : 1 }); this.renderTerm(); }); },
  renderTerm() { const term = this.data.termIndex === 0 ? 'fall' : 'spring', s = this.state.terms[term]; this.setData({ weekIndex: s.week - 1, startDate: s.startDate, auto: s.mode === 'auto' }); },
  termChange(e) { this.setData({ termIndex: Number(e.detail.value) }); if (this.state) this.renderTerm(); },
  weekChange(e) { this.setData({ weekIndex: Number(e.detail.value) }); },
  dateChange(e) { this.setData({ startDate: e.detail.value }); },
  autoChange(e) { this.setData({ auto: e.detail.value }); },
  save() { ui.safely(() => {
    if (this.data.auto && !Number.isFinite(domain.dateNumber(this.data.startDate))) throw new Error('请先选择有效的开学日期。');
    const c = getCatalog(), current = store.load(c), term = this.data.termIndex === 0 ? 'fall' : 'spring';
    store.save({ ...current, term, terms: { ...current.terms, [term]: { mode: this.data.auto ? 'auto' : 'manual', week: this.data.weekIndex + 1, startDate: this.data.startDate } } });
    wx.showToast({ title: '设置已保存', icon: 'success' }); this.onShow();
  }); },
  about() { wx.navigateTo({ url: '/pages/about/index' }); },
  resetPlanner() { wx.showModal({ title: '清除本机日程与作业？', content: '这会删除此设备中本小程序保存的全部日程和作业，无法撤销；网站中的内容会保留。', confirmText: '清除',
    success: r => { if (r.confirm) ui.safely(() => { planner.reset(); wx.showToast({ title: '已清除', icon: 'success' }); }); } }); },
  reset() { wx.showModal({ title: '清除本机课表及设置？', content: '这会删除本小程序在此设备保存的已选教学班与学期设置，无法撤销。不会删除网站中的课表。', confirmText: '清除',
    success: r => { if (r.confirm) ui.safely(() => { store.reset(); this.onShow(); wx.showToast({ title: '已清除', icon: 'success' }); }); } }); }
});
