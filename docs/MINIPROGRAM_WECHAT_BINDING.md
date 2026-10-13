# 原生微信绑定候选

2026-10-13：代码候选默认关闭，未部署、未调用真实微信。生产最后核对为网站app/current `b36b1cf`、auth `0bf51c3`、32迁移；现有网站账号登录与原生只读接口正常。服务器未配置小程序AppSecret。新候选需要0033迁移、服务器私有凭据和受控真实微信验证后才开启，不能把合成测试写成真实登录完成。

## 账号与接口

- 微信身份仅经服务器固定HTTPS `api.weixin.qq.com/sns/jscode2session`核验，禁止重定向、响应限8KiB/5秒；AppSecret、临时代码、session_key及微信原始错误不进入客户端、URL日志或错误响应。返回的OpenID只保留为按AppID隔离的HMAC映射，数据库不保存其明文；不使用昵称、momo、手机号或客户端UnionID认定归属。
- 不自动新建网站账号。未绑定时先登录已有网站账号，重新取得微信临时代码并带当前原生Bearer交换，再明确确认绑定。绑定需要当前网站密码重新验证，目标UUID明示，数据库复核当前密码、账号状态及精确session，原子消费挑战并建立唯一映射。
- `GET /api/auth/miniprogram/capabilities`返回passwordLogin、wechatLogin、wechatBinding布尔能力。微信关闭、凭据缺或0033表未就绪时两个微信能力false；原生总开关关闭时整个namespace仍503。
- `POST /wechat {code}`：已有绑定且未携会话时签发原UUID用途隔离会话；当前有效Bearer已绑定同一账号时仅返回linked/user/expiry，不额外发token；其他归属409拒绝。未绑定返回needsBinding及短期challengeToken，匿名挑战不能用于绑定，登录后必须重新交换。
- `POST /wechat/bind {challengeToken,expectedOwner,password}`必须使用当前原生Bearer。挑战绑定当前UUID与精确session，最长5分钟、单次；禁止另一会话、退出、改密竞争、重放或替换既有归属。成功只返回同UUID的linked/user/expiry。暂不支持解除或更换绑定。
- `GET /session`在微信能力开放时返回当前账号wechatLinked。客户端只展示服务端状态；未配置时隐藏微信入口，网站密码登录保留。挑战、密码及wx.login代码不存盘，切号/退出/隐藏绑定表单使迟到回复失效。

## 限额与默认配置

交换前仅按可信网络限额；服务端核验OpenID后才按身份限额，不让匿名用户共用全站账号桶，也不以可变化的客户端code绕过身份额度。已登录请求按原UUID限额。每请求网络额度只计一次，其他既有密码流程保留原三桶。

`AUTH_MINIPROGRAM_WECHAT_ENABLED=false`。开启还要求原生/密码登录已启用、`AUTH_MINIPROGRAM_WECHAT_APP_ID`及`AUTH_MINIPROGRAM_WECHAT_APP_SECRET`完整，并完成0033。密钥只放服务器0600环境文件，不放源码、聊天、小程序包或浏览器。03xx迁移保留全部原账号、会话、私人快照与历史账本；生产实施前重新核对版本、备份恢复及运行角色权限。

本地auth174项、微信迁移及HTTP/真实Argon2隔离数据库16项、原生客户端微信流程7项已通过；全部原生候选59项通过，包含真实空快照处理。原生PG CI及真实微信、iOS/Android完整验收仍待完成。当前没有双向课表写入、微信网站扫码登录、社区与教师评价原生操作或小影。
