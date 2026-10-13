const { getCatalog } = require('../../lib/catalog');
const domain = require('../../lib/domain');
const store = require('../../lib/store');
const ui = require('../../lib/ui');
Page({
  data: { query: '', rows: [], selected: '', sections: [], termLabel: '', more: false },
  onShow() { ui.safely(() => { const s = store.load(getCatalog()); this.term = s.term; this.setData({ termLabel: ui.termLabel(s.term) }); this.search(); }); },
  input(e) { this.setData({ query: e.detail.value, selected: '', sections: [] }); this.search(); },
  search() { ui.safely(() => {
    const c = getCatalog(), q = domain.normalize(this.data.query);
    const names = [...new Set(c.schedules.filter(m => m.term === this.term).flatMap(m => domain.splitClasses(m.classNames)))];
    this.results = names.filter(name => domain.normalize(name).includes(q)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    this.visible = 40; this.render();
  }); },
  render() { this.setData({ rows: this.results.slice(0, this.visible), more: this.visible < this.results.length }); },
  more() { this.visible += 40; this.render(); },
  choose(e) { ui.safely(() => {
    const name = e.currentTarget.dataset.name, c = getCatalog();
    const ids = domain.classSectionIds(c.schedules, this.term, name);
    this.setData({ selected: name, sections: ids.map(id => { const s = c.sectionById.get(id); return {
      id: s.id, title: s.title, teacher: s.teacher, meetings: s.meetings.map(domain.meetingView) }; }) });
  }); },
  importClass() { ui.safely(() => {
    const c = getCatalog(), name = this.data.selected;
    const ids = domain.classSectionIds(c.schedules, this.term, name);
    if (!name || !ids.length) throw new Error('请先选择一个具体班级。');
    const state = store.load(c), existing = c.schedules.filter(m => state.sectionIds.includes(m.sectionId));
    const proposed = c.schedules.filter(m => ids.includes(m.sectionId) && !state.sectionIds.includes(m.sectionId));
    const conflictFound = proposed.some((m, i) => existing.some(n => domain.conflict(m, n)) ||
      proposed.slice(i + 1).some(n => m.sectionId !== n.sectionId && domain.conflict(m, n)));
    wx.showModal({ title: '确认导入 ' + name + '？', content: '将合并' + ids.length + '个教学班的全部时段，已有课程保留。公共班级课表可能不含个人选修课，请逐门核对。' + (conflictFound ? '存在上课时间冲突，确认后会一并保留。' : ''),
      success: r => { if (r.confirm) ui.safely(() => { store.addSections(c, ids); wx.showToast({ title: '已导入课表', icon: 'success' }); }); } });
  }); }
});
