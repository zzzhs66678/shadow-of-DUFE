/* The public catalogue is dictionary encoded, never reduced to one teacher per title. */
const COURSE_FIELDS = ['id', 'title', 'college', 'category', 'property', 'credits', 'textbook', 'publisher', 'author'];
const STRING_FIELDS = ['id', 'sectionId', 'courseId', 'title', 'teacher', 'timeText', 'building', 'room', 'classNames'];

function encode(source) {
  const strings = [], indices = new Map(), sets = [], setIndices = new Map();
  function str(value) {
    const text = String(value || '');
    if (!indices.has(text)) { indices.set(text, strings.length); strings.push(text); }
    return indices.get(text);
  }
  function set(value) {
    const key = JSON.stringify(value);
    if (!setIndices.has(key)) { setIndices.set(key, sets.length); sets.push(value); }
    return setIndices.get(key);
  }
  const courses = source.courses.map(c => [...COURSE_FIELDS.map(k => str(c[k])), c.terms]);
  const meetings = source.schedules.map(m => {
    if (!m.id || !m.sectionId || !['fall', 'spring'].includes(m.term) ||
        !Array.isArray(m.weeks) || !m.weeks.length || !Array.isArray(m.periods) || !m.periods.length) {
      throw new Error('课程时段缺少标识、学期、有效周或实际节次：' + m.id);
    }
    return [...STRING_FIELDS.map(k => str(m[k])), m.term === 'fall' ? 0 : 1,
      m.weekday, m.block, set(m.weeks), set(m.periods)];
  });
  return { version: 1, catalogId: source.catalogId, generatedAt: source.generatedAt,
    source: source.source, disclaimer: source.disclaimer, semesters: source.semesters,
    periods: source.periods, buildings: source.buildings, strings, sets, courses, meetings };
}

function decode(packed) {
  if (packed.version !== 1) throw new Error('不支持的课程数据版本');
  const courses = packed.courses.map(row => {
    const c = {};
    COURSE_FIELDS.forEach((key, i) => { c[key] = packed.strings[row[i]]; });
    c.terms = row[COURSE_FIELDS.length];
    return c;
  });
  const schedules = packed.meetings.map(row => {
    const m = {};
    STRING_FIELDS.forEach((key, i) => { m[key] = packed.strings[row[i]]; });
    m.term = row[9] === 0 ? 'fall' : 'spring'; m.weekday = row[10]; m.block = row[11];
    m.weeks = packed.sets[row[12]]; m.periods = packed.sets[row[13]];
    return m;
  });
  return { catalogId: packed.catalogId, generatedAt: packed.generatedAt, source: packed.source,
    disclaimer: packed.disclaimer, semesters: packed.semesters, periods: packed.periods,
    buildings: packed.buildings, courses, schedules };
}
module.exports = { encode, decode, COURSE_FIELDS, STRING_FIELDS };
