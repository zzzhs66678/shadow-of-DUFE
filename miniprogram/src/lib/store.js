const KEY = 'dufesh.mini.schedule.v1';
function defaults(catalogId) { return { version: 1, catalogId, term: 'fall', sectionIds: [],
  terms: { fall: { mode: 'manual', week: 1, startDate: '' }, spring: { mode: 'manual', week: 1, startDate: '' } } }; }
function valid(value) {
  return value && value.version === 1 && typeof value.catalogId === 'string' && ['fall', 'spring'].includes(value.term) &&
    Array.isArray(value.sectionIds) && value.sectionIds.every(id => typeof id === 'string') && value.terms &&
    ['fall', 'spring'].every(term => { const s = value.terms[term]; return s && ['manual', 'auto'].includes(s.mode) &&
      Number.isInteger(s.week) && s.week >= 1 && s.week <= 18 && typeof s.startDate === 'string'; });
}
function load(catalog) {
  let value;
  try { value = wx.getStorageSync(KEY); } catch { throw new Error('无法读取本机课表，请关闭小程序后重试。'); }
  if (!value) return defaults(catalog.catalogId);
  if (!valid(value)) throw new Error('本机课表格式无法读取。请先保留已有数据，再到设置页选择清除本机课表。');
  // Keep unknown IDs for later recovery; never silently erase a user's choices on data update.
  return value;
}
function save(value) {
  if (!valid(value)) throw new Error('课表设置不完整，未保存。');
  try { wx.setStorageSync(KEY, value); } catch { throw new Error('保存失败，请检查微信存储空间后重试。'); }
  return value;
}
function addSections(catalog, ids) {
  if (!ids.every(id => catalog.sectionById.has(id))) throw new Error('教学班已变化，请重新选择。');
  const state = load(catalog);
  return save({ ...state, catalogId: catalog.catalogId, sectionIds: [...new Set([...state.sectionIds, ...ids])] });
}
function removeSection(catalog, id) { const state = load(catalog); return save({ ...state, sectionIds: state.sectionIds.filter(v => v !== id) }); }
function reset() { try { wx.removeStorageSync(KEY); } catch { throw new Error('清除失败，请稍后重试。'); } }
module.exports = { KEY, defaults, valid, load, save, addSections, removeSection, reset };
