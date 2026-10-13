// A one-time in-memory search handoff between tab pages; no account or course writes.
let pending = null;
function setQuery(value) { pending = typeof value === 'string' ? value.trim().slice(0,100) : ''; }
function takeQuery() { const query = pending; pending = null; return query; }
module.exports = { setQuery, takeQuery };
