const { getCatalog } = require('../../lib/catalog');
Page({ data: {}, onLoad() { const c = getCatalog(); this.setData({ generatedAt: c.generatedAt.slice(0, 10), source: c.source, disclaimer: c.disclaimer }); } });
