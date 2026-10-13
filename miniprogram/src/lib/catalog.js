const { decode } = require('./codec');
const { groupSections, splitClasses } = require('./domain');
let cached;
function indexCatalog(value) {
  value.sections = groupSections(value.schedules);
  value.sectionById = new Map(value.sections.map(s => [s.id, s]));
  value.courseById = new Map(value.courses.map(c => [c.id, c]));
  value.classNames = [...new Set(value.schedules.flatMap(m => splitClasses(m.classNames)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return value;
}
function prepareRemote(value) {
  if (!value || typeof value.catalogId !== 'string' || !Array.isArray(value.courses) || value.courses.length > 10000 ||
    !Array.isArray(value.schedules) || value.schedules.length > 40000 || !Array.isArray(value.periods) || value.periods.length !== 4 ||
    !value.periods.every((p,i)=>p.block===i+1 && typeof p.time==='string') || !Array.isArray(value.buildings) || !value.buildings.every(b=>typeof b==='string') ||
    !Array.isArray(value.semesters) || typeof value.disclaimer!=='string' || typeof value.source!=='string' || typeof value.generatedAt!=='string' ||
    new Set(value.courses.map(c=>c?.id)).size!==value.courses.length || new Set(value.schedules.map(m=>m?.id)).size!==value.schedules.length ||
    !value.courses.every(c => typeof c.id === 'string' && c.id && typeof c.title === 'string') ||
    !value.schedules.every(m => typeof m.id === 'string' && typeof m.sectionId === 'string' && typeof m.courseId === 'string' &&
      typeof m.title === 'string' && ['teacher','building','room','classNames'].every(k=>typeof m[k]==='string') &&
      Number.isInteger(m.block) && m.block>=1 && m.block<=4 && ['fall','spring'].includes(m.term) && Number.isInteger(m.weekday) && m.weekday >= 1 && m.weekday <= 7 &&
      Array.isArray(m.weeks) && m.weeks.length && m.weeks.every(n => Number.isInteger(n) && n >= 1 && n <= 30) &&
      Array.isArray(m.periods) && m.periods.length && m.periods.every(n => Number.isInteger(n) && n >= 1 && n <= 14))) {
    throw new Error('课程目录格式无法读取，请稍后重试。');
  }
  return indexCatalog(value);
}
function activateRemote(value) { cached = value; }
function getCatalog() {
  if (!cached) {
    cached = decode(require('../data/catalog'));
    indexCatalog(cached);
  }
  return cached;
}
module.exports = { getCatalog, prepareRemote, activateRemote };
