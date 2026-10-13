const { getCatalog } = require('../../lib/catalog');
const store = require('../../lib/store');
const planner = require('../../lib/planner');
const campus = require('../../lib/campus-links');
const ui = require('../../lib/ui');
const account=require('../../lib/account');
const cloudView=require('../../lib/cloud-view');
Page({
  data: { count: 0, tasks: 0, events: 0, termLabel: '' },
  onShow() {this.unsubscribe?.();this.unsubscribe=account.subscribe(()=>this.refresh());this.refresh();},
  onHide(){this.unsubscribe?.();if(this.data.readOnly)this.setData({user:null,count:0,tasks:0,events:0});},
  onUnload(){this.unsubscribe?.();},
  refresh(){ui.safely(()=>{const c=getCatalog(),ctx=cloudView.read(c);this.setData({user:account.current()?.user||null,readOnly:ctx.readOnly,
    count:ctx.readOnly?ctx.sectionCount:store.load(c).sectionIds.filter(id=>c.sectionById.has(id)).length,termLabel:ui.termLabel(ctx.term)});
    if(ctx.readOnly)this.setData({tasks:ctx.state?.assignments.filter(t=>!t.completed).length||0,events:ctx.state?.activities.length||0});
    else{const p=planner.load();this.setData({tasks:p.items.filter(i=>i.kind==='task'&&!i.completed).length,events:p.items.filter(i=>i.kind==='event').length});}});},
  account(){wx.navigateTo({url:'/pages/account/index'});},
  settings() { wx.navigateTo({ url: '/pages/settings/index' }); },
  planner() { wx.navigateTo({ url: '/pages/planner/index' }); },
  timetable() { wx.switchTab({ url: '/pages/timetable/index' }); },
  classes() { wx.navigateTo({ url: '/pages/classes/index' }); },
  about() { wx.navigateTo({ url: '/pages/about/index' }); },
  copy(e) { campus.copy(e.currentTarget.dataset.key); }
});
