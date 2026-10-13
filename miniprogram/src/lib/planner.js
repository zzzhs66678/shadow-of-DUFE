const { dateNumber, weekdayOf, chinaDate } = require('./domain');
const KEY = 'dufesh.mini.planner.v1';
const MAX_ITEMS = 300;
function timeNumber(time) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) return NaN; return Number(time.slice(0, 2)) * 60 + Number(time.slice(3)); }
function validateItem(item) {
  if (!item || typeof item.id !== 'string' || !item.id || !['task', 'event'].includes(item.kind) ||
      typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100 ||
      typeof item.notes !== 'string' || item.notes.length > 1000 || !Number.isFinite(dateNumber(item.date)) ||
      typeof item.completed !== 'boolean' || typeof item.courseId !== 'string') return false;
  if (item.kind === 'task') return true;
  return typeof item.location === 'string' && item.location.length <= 100 &&
    Number.isFinite(timeNumber(item.startTime)) && Number.isFinite(timeNumber(item.endTime)) &&
    timeNumber(item.endTime) > timeNumber(item.startTime) && ['none', 'weekly'].includes(item.repeat) &&
    (item.repeat === 'none' || (Number.isFinite(dateNumber(item.repeatUntil)) && dateNumber(item.repeatUntil) >= dateNumber(item.date)));
}
function load() {
  let value; try { value = wx.getStorageSync(KEY); } catch { throw new Error('无法读取日程与作业，请稍后重试。'); }
  if (!value) return { version: 1, items: [] };
  if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > MAX_ITEMS ||
      !value.items.every(validateItem) || new Set(value.items.map(i => i.id)).size !== value.items.length) {
    throw new Error('日程与作业格式无法读取，已有内容未覆盖。可在设置页主动清除。');
  }
  return value;
}
function save(state) {
  if (state.items.length > MAX_ITEMS) throw new Error('本机最多保存300项，请先整理已完成的内容。');
  if (state.version !== 1 || !state.items.every(validateItem)) throw new Error('日程或作业信息不完整，未保存。');
  try { wx.setStorageSync(KEY, state); } catch { throw new Error('日程保存失败，请检查微信存储空间后重试。'); }
  return state;
}
function upsert(item) {
  if (!validateItem(item)) throw new Error('请填写标题、有效日期；日程结束时间须晚于开始时间，每周重复须指定结束日期。');
  const state = load(), existing = state.items.findIndex(i => i.id === item.id);
  const items = state.items.slice(); if (existing >= 0) items[existing] = item; else items.push(item);
  return save({ version: 1, items });
}
function remove(id) { const state = load(); return save({ version: 1, items: state.items.filter(i => i.id !== id) }); }
function toggle(id) { const state = load(), item = state.items.find(i => i.id === id); if (!item) throw new Error('作业已不存在，请刷新列表。');
  if (item.kind !== 'task') throw new Error('只可切换作业完成状态。'); return upsert({ ...item, completed: !item.completed }); }
function reset() { try { wx.removeStorageSync(KEY); } catch { throw new Error('清除日程与作业失败，请稍后重试。'); } }
function occurs(item, date) {
  const target = dateNumber(date); if (item.kind !== 'event' || !Number.isFinite(target)) return false;
  if (item.repeat === 'none') return item.date === date;
  return target >= dateNumber(item.date) && target <= dateNumber(item.repeatUntil) && weekdayOf(date) === weekdayOf(item.date);
}
function todaySummary(state, today = chinaDate()) {
  return { events: state.items.filter(i => occurs(i, today)).sort((a, b) => timeNumber(a.startTime) - timeNumber(b.startTime)),
    tasks: state.items.filter(i => i.kind === 'task' && !i.completed).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3)
      .map(i => ({ ...i, dueLabel: i.date < today ? '已逾期' : i.date === today ? '今天截止' : i.date + '截止' })) };
}
module.exports = { KEY, timeNumber, validateItem, load, save, upsert, remove, toggle, reset, occurs, todaySummary };
