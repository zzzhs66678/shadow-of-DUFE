const account = require('./lib/account');
App({ onLaunch() { try { account.restore(); } catch { /* the local learning tools remain available */ } },
  onShow() { if (account.current()) account.refresh().catch(() => {}); } });
