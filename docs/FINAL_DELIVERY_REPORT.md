# 东财之影正式升级交付报告（发布候选）

最后更新：2026-08-11

状态口径：`已完成并验证`、`已实现待 staging`、`外部阻塞`、`尚未完成`。本报告不把静态合同、本地明确 SKIP、CI 环境或旧正式站状态冒充新版本生产证据。

## 1. 仓库原有架构和发现的问题

- 原架构为 React/TypeScript/vinext 主站、独立 Node auth-api、PostgreSQL 17、独立 Node/SQLite 小影、Caddy 与 Docker Compose；课程由 Excel 离线生成 JSON，匿名个人数据保存在浏览器。
- 初始 P0/P1 问题包括账号本地缓存串号、缺真实凭据登录与服务端管理员闭环、社区/教师事实缺稳定数据模型、进程内限流、第三方明文授权、备份不可恢复验证、可变生产镜像、公开占位秘密和依赖漏洞。
- UI 同时存在多代 CSS、蓝色工业化组件、整页转场、首屏 3.22MB 课程索引和不一致表单/弹层；资料搜索与选课耦合，教师姓名被误当身份候选。
- 用户原始工作簿被视为私有导入输入；同名教师、历史评价、占位 ISBN、教学班教材和异常字段不允许直接公开或猜测合并。

## 2. 最终产品与技术方案

- `已完成并验证`：保留“今日学习台”为首要任务面，采用纸、墨、朱砂与校园时间轨原创系统；校园照片集中在“我的”，社区和教师作为独立工作区。
- `已完成并验证`：凭据账号、个人云同步、资料 API、教师 UUID、用户评价、社区/通知/治理、管理员 MFA、共享限流、安全网关和小影隔离均有真实服务端实现，不以按钮隐藏或内存假数据充数。
- `已完成并验证`：PR #10 已通过 PostgreSQL 17 空库双迁移、角色 ACL、真实 HTTP/浏览器账号链、Linux 生产镜像、CodeQL、全历史秘密扫描和隔离恢复演练。
- `已实现待 staging`：既有数据库升级副本、正式镜像摘要与不可变回滚、真实 Web Vitals/代理/监控、生产备份和外部服务仍需隔离环境验证。
- `外部阻塞`：真实微信、SMTP 服务商投递、独立 staging 和异地备份仍需外部账号或凭据；邮件适配器代码本身已完成。

## 3. 每个工作流实际完成的功能

1. 账号与后台：用户名/邮箱/Argon2id 注册登录、资料、头像、验证令牌、设备、同步、注销、RBAC、TOTP、恢复码、用户管理、系统公告与 append-only 审计。
2. 资料：独立 `/materials` 列表/详情和公开只读 API，按课程、教师、标题、标签、类型、学期与年份检索，预览/下载不进入选班。
3. 教师与导入：稳定 `teacher_id`、来源键/别名/学院/教学班/教材、私有批次证据、dry-run、幂等 apply、依赖回滚、历史候选审核和五维用户评价。
4. 社区：主题、两级评论、点赞、收藏、拉黑、举报、通知、游标分页、软删除、证据快照、治理案件、内容/账号动作与双审计事务。
5. 视觉与文案：统一 Token、公共 Masthead、弹层/按钮/字段原语、原创动态、校园影集、创作者入口、无开发提示词文案与完整图片署名。
6. 质量与发布：全宽度/axe/性能预算、CSP、安全头、限流、依赖隔离、PG17/镜像/秘密扫描 CI、环境模板、运维与回滚手册。

## 4. 主要修改文件

- 产品与页面：`app/DufeHubV2.tsx`、`app/materials/`、`app/teachers/`、`app/community/`、`app/admin/`。
- 视觉原语：`app/globals.css`、`app/product-system.css`、`app/red-access-system.css`、`app/FormField.tsx`、`app/DialogBackdrop.tsx`、`app/PublicMasthead.tsx`。
- 服务端：`services/auth-api/src/`、`xiaoying-executor/bin/server.mjs`、`xiaoying-executor/src/`。
- 数据与迁移：`ops/postgres/migrations/0001_identity_foundation.sql` 至 `0017_community_announcements.sql`、`scripts/academic-import-*.mjs`。
- 验证与发布：`.github/workflows/quality.yml`、`tests/`、`playwright.config.ts`、`playwright.postgres.config.ts`、`docker-compose.yml`、`server.mjs`。
- 运维文档：`README.md`、`docs/SECURITY_REVIEW.md`、`docs/DEPLOYMENT_CHECKLIST.md`、`docs/OPERATIONS_RUNBOOK.md`。

## 5. 数据库迁移和数据模型

- 17 个顺序 SQL 迁移覆盖身份、匿名设备、OAuth 事务、个人云数据、幂等同步、凭据、头像、管理员、邮箱验证、社区、举报证据、教师/教材导入、审核、用户评价、共享限流与不可变系统公告。
- schema owner、migrator、runtime、importer、backup 分离；迁移摘要不可改写，审计/证据表限制更新删除，业务删除采用墓碑或去标识化。
- Course—Section—Meeting 三层课程事实保持不变；周次集合保留差异。教师姓名不是唯一键，教材绑定学期和教学班。
- `已完成并验证`：PR #10 run `31466722843` 从 PostgreSQL 17 空库执行迁移两次，跑通 schema owner/migrator/runtime/importer/backup ACL、共享限流、导入/审核并发、真实账号 HTTP、审计故障回滚，并由只读 backup 角色现场备份后完成隔离恢复和零残留检查。本机三项 PG 测试继续明确 SKIP，但不再是唯一证据。

## 6. 注册、同步和管理员后台说明

- `已完成并验证`：用户名或邮箱登录、Argon2id、统一错误、失败锁定、单次重置/验证令牌、Secure/HttpOnly Cookie、头像规范化和跨账号本地隔离。
- `已完成并验证`：生产 SMTP 适配器强制 TLS 1.2+ 和证书验证，禁用文件/URL/附件读取，生产不回传令牌；密码重置不等待 SMTP 网络，投递失败保持统一 202 防枚举。真实服务商到达率仍待凭据。
- `已完成并验证`：云端 revision、稳定客户端 ID、幂等 mutation、三方合并、冲突保留、设备撤销和账号注销均有 API/存储测试及 PG17 关键路径证据。
- `已完成并验证`：后台所有 API 先做服务端角色检查，高风险操作要求绑定基础会话的短期 TOTP/恢复码提升，并写不可变审计。
- `已完成并验证`：真实 PG17 浏览器用例覆盖三个注册账号、第二设备资料/头像、普通用户拒绝、管理员 bootstrap、实时 TOTP 和举报处置，已在 PR #10 通过。

## 7. 社区和通知系统说明

- 公开读与登录态个性化分离；写入要求可信 Origin、有效会话、字段白名单、纯文本边界、账号+IP 限流和参数化 SQL。
- 回复/提及通知与内容同事务，通知按收件人隔离；删除后正文脱敏并降级站内地址。举报保存不可变快照，重复开放举报不覆盖首份证据。
- 管理员治理按服务端 `allowedActions` 执行，隐藏/删除、制裁/解除和结案有状态矩阵；业务变更、通知、社区审计和全局审计原子提交。
- `已完成并验证`：作者徽章进入稳定 UUID 公开档案，主题与回复分别有界分页；只显示活动账号的公开身份和 `published + public` 内容，双向屏蔽、停用、注销与仅链接内容不会从档案旁路泄露。
- `已完成并验证`：社区列表同时提供时间序和真实热议序；热议只使用赞同、公开回复与 14 天新鲜度，快照游标固定单轮排名时点，不建立用户等级、画像或虚构榜单。
- `已完成并验证`：管理员可在短期 MFA 后预览并发布系统公告；不可变主记录、全部活动账号通知、实际投递数和受限全局审计原子提交，同一 UUID 重试不会重复投递。
- `已完成并验证`：真实 PG17 的核心并发、审计故障通用 503 与整事务回滚、作者注销保留证据和完整浏览器链均已通过；更多 staging 负载与代理链场景仍单列。

## 8. 视觉系统和文案改造说明

- `已完成并验证`：统一纸白、炭墨、朱砂，松针绿只表达状态；不再使用蓝色主视觉、随机圆角或通用 SaaS 卡片语言。
- 今日学习台只承载下一节课、作业、近期安排、空教室和常用入口；校园摄影、影子图书馆致意和创作者合影放在“我的”，不喧宾夺主。
- 每页只保留有意义的局部动态，支持 `prefers-reduced-motion`；公共字段、弹层、焦点和触控语义统一但页面构图保持差异。
- 全站用户文案已移除开发计划、提示词复述和未实现承诺；所有 Git 已跟踪公开图片均有来源、许可或原创/用户提供说明。

## 9. 已执行的测试及结果

- 最新本地总回归：主仓 Node 131 项中 128 通过、3 项 PostgreSQL 明确 SKIP；个人存储/同步 9/9；auth-api 82/82；小影 35/35。
- TypeScript、全仓 ESLint、CSS 级联审计、Compose/workflow YAML 与 `git diff --check` 通过。
- 既有生产浏览器门禁最近通过 58/58，覆盖桌面、320/360/375/390/414/768、横屏、axe、无横向溢出、按需课程索引与有界列表。
- PR #10 quality run `31466722843` 全绿：`verify`、`postgres-17-integration`、`linux-production-images`、`codeql` 与 `full-history-secret-scan` 全部通过；其中浏览器关键路径在真实 PG17 runtime 上实际执行，恢复演练由现场备份进入隔离临时库并确认零残留。

## 10. 安全审计发现和修复

- 已修复或编码控制：账号缓存隔离、Argon2id、会话摘要、CSRF/Origin、RBAC/TOTP、上传魔数/尺寸/EXIF、社区 IDOR/SQLi/Mass Assignment、共享持久限流、CSP nonce/hash、HTTPS 第三方授权、错误脱敏、租约/幂等、只读备份角色和失败关闭依赖替代。
- CI 第三方 Action 使用完整 SHA 和 Node 24 版本，checkout 不持久化凭据；Gitleaks 检出完整历史且不评论/上传制品。
- 生产环境模板秘密全部留空，微信 mock 默认关闭；服务读取变量必须由模板或 Compose 明确持有。
- SMTP 密码同样由环境合同锁定为空模板秘密；选择 SMTP 模式却缺主机、凭据、发件地址或注入适配器时服务失败关闭。
- `已实现待 staging`：SEC-002/003/005/006/011/013/015/016 的 CI 证据已补齐；SEC-009 仍缺生产真实备份和异地副本，SEC-010/017/018 仍含代理、服务器权限、镜像摘要或回滚证据，因此不能宣布全部 P0/P1 已满足生产放行条件。

## 11. 移动端和性能检查结果

- 浏览器门禁覆盖 320、360、375、390、414、768px 与 667/844 横屏；五个主视图无页面级横向溢出，关键触控目标至少 44px。
- axe 覆盖核心产品、法律页、注销和后台入口，无 critical/serious；焦点、键盘、Escape、焦点恢复和减少动态均有回归。
- 首页从 3,218,571 字节完整课程事实改为 633,576 字节可验证轻量投影；完整索引、资料清单和校园照片按需/空闲加载，课程选择器每批 40 门。
- `已实现待 staging`：LCP≤2.5s、INP≤200ms、CLS≤0.1 只作为 staging 预算，本地文件体积与 Playwright 不能冒充真实 Web Vitals。

## 12. 部署地址和健康状态

- 既有正式站：`https://dufesh.cn`。2026-08-11 只读探测首页 200、`/api/auth/health` 200；`/api/materials?limit=1` 为 404，符合新资料 API 尚未部署的事实。
- 私有旧预览地址记录为 `https://dufesh.zzzhs66678.chatgpt.site`，未把它作为本分支 staging 证据。
- **本发布分支未部署。** 没有执行生产迁移、镜像切换、管理员初始化或数据导入，也没有创建付费 staging 资源。

## 13. Git 分支、commit 和 Pull Request 信息

- 远程：`origin = https://github.com/zzzhs66678/shadow-of-DUFE.git`。
- 当前分支：`codex/release-upgrade`；完整交付范围以 Draft PR #10 为准。由于受限环境曾通过 GitHub Git Data API 非强制更新远端分支，远端提交对象 SHA 与本地提交对象 SHA 可能不同，但每次上传都先校验父树和最终树完全一致。
- 提交按里程碑拆分，最近包括 PG17/浏览器 CI、供应链密钥扫描、失败关闭环境模板与不可变镜像运维手册。
- 当前状态：**已推送并创建 Draft PR #10**：`https://github.com/zzzhs66678/shadow-of-DUFE/pull/10`。当前 CI 全绿；没有强推、改写历史或触碰用户未纳管文件。

## 14. 尚未完成或受外部凭据阻塞的事项

- `外部阻塞`：微信开放平台真实 AppID/AppSecret 与审核结果；当前只有 disabled/mock 适配边界，正式模板为 disabled。
- `外部阻塞`：生产 SMTP 适配器已实现并本地验证；真实账号、发件域、凭据、退信策略与 staging 到达率尚未提供或验证，因此正式重置与邮箱验证模式继续保持 disabled。
- `外部阻塞`：独立 staging 域名/数据库/服务器凭据和异地 OSS 备份凭据尚未提供。
- `已实现待 staging`：GitHub Linux 镜像、PG17 双迁移/ACL/并发、完整浏览器链、CodeQL、全历史 Gitleaks和现场备份恢复已经运行并通过；尚需既有库升级、正式镜像摘要和上一版本不可变回滚演练。
- `已实现待 staging`：真实教师/教材私有导入包仍须在 staging 走 dry-run、apply、审核和回滚；未审核历史评价不得公开。
- `已实现待 staging`：真实 Web Vitals、代理链、域名跳转、CSP 控制台、系统监控与管理员一次性初始化需 staging/生产主机验证。
- `尚未完成`：Draft PR 的人工审查、staging 验收、合并和生产发布审批；在获得明确发布授权前不执行生产部署。
