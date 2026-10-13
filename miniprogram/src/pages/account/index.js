const account = require('../../lib/account');
Page({
  data: { user:null,identifier:'',password:'',busy:false,error:'',ready:false,revision:null,plans:0,
    wechatAvailable:false,wechatBindingAvailable:false,wechatLinked:false,bindingPrompt:false,linkRequired:false },
  onShow() { this.visible=true;this.viewEpoch=(this.viewEpoch||0)+1;const turn=this.viewEpoch;
    this.setData({wechatAvailable:false,wechatBindingAvailable:false});
    this.unsubscribe?.(); this.unsubscribe=account.subscribe(() => this.refresh());this.refresh();
    void account.capabilities().then(value=>{if(this.visible && this.viewEpoch===turn)this.setData({wechatAvailable:value.wechatLogin,wechatBindingAvailable:value.wechatBinding});}); },
  onHide() { this.visible=false;account.cancelBinding();this.linkAfterLogin=false;this.setData({password:'',bindingPrompt:false,linkRequired:false});this.unsubscribe?.(); },
  onUnload() { this.onHide(); },
  refresh() { const state=account.current(),cloud=account.getCloud();this.setData({user:state?.user || null,
    wechatLinked:state?.wechatLinked===true,ready:Boolean(cloud),emptyWebsiteState:cloud?.sourceSnapshot.state===null,revision:cloud?.revision ?? null,plans:cloud?.plans.length || 0});
    const owner=state?.user.id || null;if(this.owner!==owner){this.owner=owner;this.setData({bindingPrompt:false,password:''});} },
  field(e) { const key=e.currentTarget.dataset.field;if(['identifier','password'].includes(key))this.setData({[key]:e.detail.value}); },
  async login() {
    if(this.data.busy)return;if(!this.data.identifier.trim() || !this.data.password){this.setData({error:'请输入账号和密码。'});return;}
    this.setData({busy:true,error:''});
    const linkRequested=this.linkAfterLogin;
    try{await account.login(this.data.identifier.trim(),this.data.password);this.setData({password:''});
      if(linkRequested && this.visible){const result=await account.beginWechat();this.linkAfterLogin=false;
        this.setData({bindingPrompt:result.needsBinding===true && !result.requiresLogin,linkRequired:false});}
      await account.refresh();}
    catch(e){this.setData({error:e.message});}finally{this.setData({busy:false,password:''});this.refresh();}
  },
  async reload() {if(this.data.busy)return;this.setData({busy:true,error:''});try{account.useWebsite();await account.refresh();}
    catch(e){this.setData({error:e.message});}finally{this.setData({busy:false});this.refresh();} },
  async logout() {if(this.data.busy)return;this.setData({busy:true,error:''});try{await account.logout();}
    catch(e){this.setData({error:e.message.includes('清理') ? e.message : '已清除本机登录状态；网络中断时，服务器会话将在到期后失效。'});}finally{this.setData({busy:false});this.refresh();} },
  timetable() {account.useWebsite();wx.switchTab({url:'/pages/timetable/index'});},
  async wechat() {if(this.data.busy)return;this.setData({busy:true,error:'',password:'',bindingPrompt:false});
    try{const result=await account.beginWechat();if(!this.visible)return;
      if(result.needsBinding){this.linkAfterLogin=result.requiresLogin;this.setData({linkRequired:result.requiresLogin,bindingPrompt:!result.requiresLogin});}
      else {this.linkAfterLogin=false;this.setData({linkRequired:false});await account.refresh();}}
    catch(e){if(this.visible)this.setData({error:e.message});}finally{this.setData({busy:false,password:''});this.refresh();} },
  async confirmBinding() {if(this.data.busy)return;if(!this.data.password){this.setData({error:'请输入网站密码确认绑定。'});return;}
    this.setData({busy:true,error:''});try{await account.confirmWechatBinding(this.data.password);this.setData({bindingPrompt:false,password:''});await account.refresh();}
    catch(e){if(this.visible)this.setData({error:e.message,...['binding_challenge_expired','account_changed','wechat_account_conflict'].includes(e.code)?{bindingPrompt:false}:{}});}finally{this.setData({busy:false,password:''});this.refresh();} },
  cancelBinding(){account.cancelBinding();this.linkAfterLogin=false;this.setData({bindingPrompt:false,linkRequired:false,password:'',error:''});},
  local() {account.useLocal();wx.switchTab({url:'/pages/timetable/index'});},
  register() {wx.setClipboardData({data:'https://dufesh.cn/?view=me'});},
  about() {wx.navigateTo({url:'/pages/about/index'});}
});
