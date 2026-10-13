const {getCatalog}=require('../../lib/catalog');
const cloudView=require('../../lib/cloud-view');
const ui=require('../../lib/ui');
const domain=require('../../lib/domain');
const account=require('../../lib/account');
Page({data:{meeting:null},onLoad(options){this.id=ui.queryValue(options.id);this.ticket=account.context();
    this.options={term:options.term==='spring'?'spring':'fall',planId:ui.queryValue(options.plan)||undefined,planning:options.planning==='1'};},
  onHide(){this.unsubscribe?.();this.setData({meeting:null});},
  onShow(){this.unsubscribe?.();this.unsubscribe=account.subscribe(()=>this.refresh());this.refresh();},
  onUnload(){this.unsubscribe?.();},
  refresh(){this.setData({meeting:null});ui.safely(()=>{const current=account.context();if(!current||current.userId!==this.ticket?.userId||current.epoch!==this.ticket.epoch)return;
    const ctx=cloudView.read(getCatalog(),this.options);const meeting=ctx.readOnly?ctx.meetings.find(m=>m.id===this.id):null;
    this.setData({meeting:meeting?domain.meetingView(meeting):null});});}
});
