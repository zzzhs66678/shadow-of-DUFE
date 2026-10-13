const { getCatalog } = require('../../lib/catalog');
const store = require('../../lib/store');
const { normalize } = require('../../lib/domain');
const { scoreCourseSearch } = require('../../lib/course-search');
const ui = require('../../lib/ui');
const entry = require('../../lib/course-entry');
Page({
  data: { query: '', rows: [], count: 0, term: 'fall', termIndex: 0, terms: ['上学期', '下学期'], more: false },
  onShow() { ui.safely(() => { const s = store.load(getCatalog()),query=entry.takeQuery(); this.setData({ term: s.term, termIndex: s.term === 'fall' ? 0 : 1,...query!==null?{query}:{} }); this.search(); }); },
  input(e) { this.setData({ query: e.detail.value }); clearTimeout(this.timer); this.timer = setTimeout(() => this.search(), 160); },
  onHide() { clearTimeout(this.timer); },
  onUnload() { clearTimeout(this.timer); },
  termChange(e) { const n = Number(e.detail.value); this.setData({ termIndex: n, term: n === 0 ? 'fall' : 'spring' }); this.search(); },
  search() { ui.safely(() => {
    const c = getCatalog(), input = this.data.query, query = normalize(input), term = this.data.term;
    const matching = c.sections.filter(s => s.term === term);
    const counts = new Map(), teachers = new Map(), matchedCourses = new Set();
    for (const s of matching) {
      counts.set(s.courseId, (counts.get(s.courseId) || 0) + 1);
      if (!teachers.has(s.courseId)) teachers.set(s.courseId, new Set());
      teachers.get(s.courseId).add(s.teacher);
      if (normalize([s.title, s.courseId, s.teacher, s.classNames].join(' ')).includes(query)) matchedCourses.add(s.courseId);
    }
    this.results = c.courses.filter(course => course.terms.includes(term))
      .map(course => ({ id: course.id, title: course.title, college: course.college, credits: course.credits,
        category: course.category, sectionCount: counts.get(course.id) || 0,
        score: Math.max(scoreCourseSearch({ ...course, teachers: [...(teachers.get(course.id) || [])] }, input), matchedCourses.has(course.id) ? 200 : -1) }))
      .filter(course => !query || course.score >= 0).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'));
    this.visible = 40; this.render();
  }); },
  render() { this.setData({ rows: this.results.slice(0, this.visible), count: this.results.length, more: this.visible < this.results.length }); },
  more() { if (this.results) { this.visible += 40; this.render(); } },
  onReachBottom() { if (this.data.more) this.more(); },
  open(e) { ui.detail(e.currentTarget.dataset.id, this.data.term); }
});
