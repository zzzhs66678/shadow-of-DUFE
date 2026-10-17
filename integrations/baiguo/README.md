# 白果云管理员内嵌适配

主站管理员通过 MFA 后，在 `/admin#baiguo` 直接使用现有私人课表服务。
白果云继续使用独立口令、自己的 HttpOnly Cookie 和 CSRF 校验；主站不读取或转发这些凭据。
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

适配包包含 `dashboard.py` 与 `web/` 下五个静态文件。
正式安装前先备份这六个文件，仅替换同名代码、增加两个适配资产，并单独重启 `baiguo-dashboard`。
不得覆盖 `control/`、`dashboard-private/`、`dashboard-state/`、`.env` 或学校授权数据。
原监控进程无需重启。回滚时恢复备份的代码、移除新增适配资产并重启 dashboard。

只有 `/?embed=dufesh` 和 `/index.html?embed=dufesh` 文档允许 `https://dufesh.cn` 作为嵌入来源。
其他文档和 API 继续发送 `DENY`、`frame-ancestors 'none'`，不增加 CORS。
主站也只在 `/admin`、`/admin/` 的 CSP 中允许白果云 frame。
非主域的本地/staging 预览需用浏览器测试映射主域，不能放宽正式白名单。

内嵌页面用限定目标来源的 `postMessage` 通知就绪与高度。
主站同时核对发送来源、窗口和消息类型，收到通知前不把 iframe load 当成成功。
管理员验证到期或回到页面时重新校验身份，失效会移除内嵌页。
离开白果云管理分区会卸载页面，请先保存课表调整。
