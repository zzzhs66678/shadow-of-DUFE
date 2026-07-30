# 小影校园服务（X1）

这是“东财之影”的邀请码校园服务，包含我去图书馆、白果云同步和可选模型能力。
本地与正式内测都使用独立 SQLite；正式服务以私有容器挂载到主站子路径，不与普通用户会话混用。

## 已实现

- 邀请码解锁、HttpOnly 会话、用户隔离和操作审计。
- 每位 VIP 独立保存模型 API 密钥；密钥和第三方授权均使用 AES-256-GCM 加密。
- 我去图书馆二维码授权、局域网/远程授权、场馆与完整座位布局、常用座位。
- 今天预约、明天预约、取消预约、定时预约。
- 单座位提醒、最多十二个场馆的空位发现。
- 预约守护：按真实过期时间取消并尝试重新预约同一座位；明确提示风险并限制周期。
- 站内提醒、浏览器通知、Cookie 失效状态。
- 白果云课程、作业和通知的结构化同步。
- 不含任何凭据的 JSON 备份与恢复。
- 桌面顶部导航、手机底部导航的同一套响应式界面。
- 站长可维护带版本和回滚的 TraceInt 协议配置。

用户已明确不需要 iBeacon 到馆检测或签到，因此这两项不进入东财之影。系统也不伪造位置、蓝牙或现场状态，不提供无上限高频请求。

## 启动

仅本机使用：

```powershell
npm run xiaoying:x1
```

同一 Wi-Fi 下让手机扫码授权：

```powershell
npm run xiaoying:x1:lan
```

默认地址为 `http://127.0.0.1:43120/`，默认本地邀请码为 `fjbadguy`。本地数据库和自动生成的主密钥保存在 `xiaoying-executor/.local-data/`，该目录不会进入 Git。

正式环境必须通过 `XIAOYING_MASTER_KEY` 提供独立的 32 字节 Base64 主密钥，并设置至少
12 位的 `XIAOYING_DEFAULT_INVITE_CODE`。数据库保存在独立持久卷，远程二维码授权必须配置
HTTPS 地址和子路径：

```powershell
$env:XIAOYING_PUBLIC_BASE_URL = "https://dufesh.cn/campus-lab"
$env:XIAOYING_BASE_PATH = "/campus-lab"
npm run xiaoying:x1
```

主站只有在构建时设置 `NEXT_PUBLIC_XIAOYING_URL` 后，才会在“我的 → 东财常用”底部显示
低对比度内测入口；今日学习台不会因此增加 VIP 授权、日志或技术状态。

## 协议兼容配置

普通用户不能编辑第三方接口地址。站长通过版本化 JSON 配置更新，服务启动时读取一次：

```powershell
npm run xiaoying:protocol -- show
npm run xiaoying:protocol -- apply C:\path\to\traceint-protocol.json
npm run xiaoying:protocol -- rollback traceint-2.2.6
```

应用文件示例：

```json
{
  "version": "traceint-2.2.6",
  "protocol": {
    "defaultProfile": { "appVersion": "2.2.6" },
    "tomorrowProfile": { "appVersion": "2.2.6" }
  }
}
```

配置只允许 TraceInt 官方域名和受信任路径，写入采用临时文件原子替换，最多保留二十个版本。修改后重启 X1 生效。可用 `XIAOYING_TRACEINT_PROTOCOL_PATH` 指向另一个配置文件。

## 验证

```powershell
npm run test:xiaoying
npm run build
```

功能迁移状态以 `docs/IGOLIBRARY_MIGRATION.md` 为准。

## 安全边界

- 外部写操作必须经过预览、明确确认、幂等保护和审计。
- Cookie、授权链接、模型密钥和控制令牌不得写入任务、普通日志或 AI 输入。
- 未连接真实账号时使用演示适配器；连接后才读取真实场馆和座位。
- 空位发现不会自动预约；预约守护失败后立即暂停，不循环制造请求。
- 协议覆盖只允许站长在服务器文件系统中维护，普通用户只看到版本号。
