# 白果云管理员内嵌适配

主站管理员通过 MFA 后，在 `/admin#baiguo` 直接使用现有私人课表服务。
管理员内嵌页免输入管理口令：主站服务端两次复核管理员/MFA后，以服务器保存的口令向白果云申请最多30秒、且不晚于MFA到期的一次性凭证；内嵌页仅接收该凭证并换取自己的HttpOnly Cookie，之后仍使用原CSRF校验。
口令仅由服务器0600配置 `shared/config/baiguo-admin.env` 的 `BAIGUO_MANAGEMENT_KEY` 提供，通过app的env_file注入；不得进入Git、前端、URL或浏览器持久存储。新增同源POST入口 `/admin/baiguo-session`，匿名、普通用户、未提升或验证到期均拒绝；来源/窗口校验与SQLite原子消费防止凭证重放。独立打开仍保留原口令登录。
此入口只改变管理界面，不改变课程事实或监控行为。

内嵌课表按教务导入样式收紧：时间轴为每小时28px，位置计算和网格线使用同一比例。
默认显示工作日；周末有课程、监控时段或停课标记时自动展示七天，空白周末可手动展开。
手机优先显示课程名，完整钟点可从课程按钮的可访问名称和调整详情读取。

`prepare_embed.py` 读取原白果云项目，在新的目录生成适配包，不改原目录。
脚本要求现有源码片段精确匹配；上游结构变化时会停止，不能盲目覆盖。

```powershell
$env:BAIGUO_SOURCE = 'C:/Users/zzz/Documents/ChatGPT/白果云签到'
$env:BAIGUO_BUNDLE = 'C:/Users/zzz/.codex/worktrees/admin-baiguo/云/output/baiguo-embed/bundle'
python integrations/baiguo/prepare_embed.py $env:BAIGUO_SOURCE $env:BAIGUO_BUNDLE
$env:PYTHONPATH = $env:BAIGUO_SOURCE
$env:PYTHONDONTWRITEBYTECODE = '1'
python integrations/baiguo/test_embed.py -q
```

适配包包含 `dashboard.py`、`diagnostics.py`、`runtime_status.py` 与 `web/` 下五个静态文件。
正式安装前先备份同名代码。账号与签到记录由监控现有 Recorder 输出到独立白名单镜像，
首次安装本功能需在课外、且没有重登任务运行时重启 monitor 和 dashboard，复用既有持久状态。
仅修改界面时无需重启 monitor。
不得覆盖 `control/`、`dashboard-private/`、`dashboard-state/`、`.env` 或学校授权数据。
回滚时恢复备份代码；若变更了 diagnostics，则也在安全时段重启 monitor，不恢复或覆盖业务数据。

账号与签到区显示发现登录失效、自动重登尝试、排队/最早重试时间、结果及学校验证状态。
“凭据更新成功”不等同于“学校登录验证通过”。签到的待确认、自动提交后确认与查询发现已签到分别保留。
记录使用北京时间精确到秒，时间为后台发现/确认时间；不推测学校实际登出时间或历史签到发生时间。
时间线最多100条，首次启用只从现有安全状态和签到记录保留已知时间；不读取或公开原始请求日志。
dashboard 仍只读取白名单镜像，不能访问学校凭据或私有诊断目录。

```powershell
python integrations/baiguo/test_runtime.py -q
```

只有 `/?embed=dufesh` 和 `/index.html?embed=dufesh` 文档允许 `https://dufesh.cn` 作为嵌入来源。
其他文档和 API 继续发送 `DENY`、`frame-ancestors 'none'`，不增加 CORS。
主站也只在 `/admin`、`/admin/` 的 CSP 中允许白果云 frame。
非主域的本地/staging 预览需用浏览器测试映射主域，不能放宽正式白名单。

内嵌页面用限定目标来源的 `postMessage` 通知就绪与高度。
主站同时核对发送来源、窗口和消息类型，收到通知前不把 iframe load 当成成功。
管理员验证到期或回到页面时重新校验身份，失效会移除内嵌页。
离开白果云管理分区会卸载页面，请先保存课表调整。
