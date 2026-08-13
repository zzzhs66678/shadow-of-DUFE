# 东财之影部署检查表

最后更新：2026-08-11

当前结论：**尚不具备生产部署条件。本轮未部署。** 只有全部“生产前门禁”通过，且没有不可接受的高危项，才允许进入人工生产发布审批。

## 1. 环境与凭据

- [ ] 明确 staging 域名、数据库、文件存储和回调地址，与生产完全隔离。
- [ ] `POSTGRES_PASSWORD`、`AUTH_TOKEN_PEPPER`、`AUTH_ADMIN_MFA_KEYS`、`AUTH_ADMIN_RECOVERY_PEPPER`、邮件凭据、微信 AppSecret、上传存储密钥和小影主密钥只存在于受限环境文件或密钥管理服务。
- [ ] 小影正式环境同时设置至少 12 位随机 `XIAOYING_DEFAULT_INVITE_CODE` 与 1—500 的 `XIAOYING_DEFAULT_INVITE_MAX_USES`；使用前复核本批计划人数，轮换时确认旧码立即失效。
- [ ] `.env.example` 列全变量但不含真实值；服务器环境文件权限为 600。
  - 四份分域模板已由环境合同确认覆盖 auth/小影源码读取变量，秘密均为空且无可用占位值；仍须在发布主机核对生成后的四个文件确为 600。
- [ ] 微信 AppID/AppSecret 与审核状态真实可用；若缺失，正式 UI 只提供已验证的降级登录。
- [ ] SMTP 主机、端口、TLS 模式、账号、密码和纯邮箱发件地址来自受限环境；在 staging 实测密码重置与邮箱验证各一封，并确认响应、日志和退信不泄漏令牌或完整账号标识。
- [ ] 对象存储/头像存储凭据真实可用；若未开通，使用经过验证的本地受限存储适配器并记录容量边界。
- [ ] 管理员初始化通过一次性命令完成，不在仓库保存固定密码或 Token。
  - 运维手册已锁定私密交互终端、一次显示、旧会话撤销与 `--rotate` 应急边界；仍须在 staging 用真实账号验证 TOTP、恢复码、旧凭据失效和审计。

## 2. 数据库与迁移

- [x] 从空 PostgreSQL 17 实例依次执行全部迁移成功（PR #10 run `31466722843`）。
- [x] 对同一实例重复执行迁移无变化，摘要校验有效（同一 PG17 作业连续执行两遍）。
- [ ] 生产迁移前创建加密备份，并在临时数据库完成完整恢复。
- [ ] 启用 `dufesh-db-restore-drill.timer`，从真实备份完成首次隔离恢复；日志记录备份文件、行数摘要和 RTO，临时 `dufesh_restore_drill_*` 数据库在成功与故障后均已清理，生产库全程未被 restore 目标引用。
- [ ] 记录 expand/backfill/validate/cutover/contract 每一步与预计锁时间。
- [ ] 大索引和回填不在单个长事务中阻塞生产业务。
- [ ] teacher/material/community 导入先 dry-run，保存批次报告和回滚标识。
- [x] 数据库 owner、schema owner、migrator、runtime、importer、backup 角色按最小权限分离并通过 PG17 ACL 门禁。
- [ ] 在 600 权限 `postgres.env` 配置不可登录 `MIGRATION_DB_ROLE` 与独立 `MIGRATION_DB_USER/MIGRATION_DB_PASSWORD`；确认 migrator 为 `NOINHERIT`、仅能 `SET ROLE` 到 schema owner，基础会话不能读业务表，schema owner 无登录/高权属性并持有全部 public 对象。
- [ ] 首次升级先用当前正式版本完成 owner 备份，再运行新迁移器接管 public 对象所有权；在 staging 验证空库、既有库、第二次幂等执行和失败事务回滚后才能进入生产窗口。
- [ ] 为 backup 生成独立长随机 `BACKUP_DB_USER/BACKUP_DB_PASSWORD` 写入 600 权限 `postgres.env`；用该角色完成 custom-format `pg_dump`，并验证可完整恢复，同时不能写表或执行 public 函数。
- [ ] 为 importer 生成独立长随机密码并配置 `IMPORT_DB_USER/IMPORT_DB_PASSWORD`；确认该角色 `NOINHERIT`，不能读取账号、凭据、会话、MFA、OAuth 或头像表。
- [ ] 在 PostgreSQL 17 验证 `0010_community_foundation.sql` 空库/升级库迁移、两级回复触发器、软删除引用、通知/互动去重和开放举报部分唯一索引。
- [ ] 在 PostgreSQL 17 验证 `0011_community_read_paths.sql` 重复执行和查询计划；软删除根评论仍使用墓碑索引分页并保留回复线程。
- [ ] 在 PostgreSQL 17 验证 `0012_community_report_evidence.sql` 空库/升级/重复迁移、旧举报回填和快照不可变触发器；编辑或删除目标后审核证据仍保持举报时内容。
- [ ] 在 PostgreSQL 17 验证 `0013_teacher_catalog_imports.sql` 空库/升级/重复迁移、同名教师隔离、来源键冲突、历史候选默认私有、同教学班多教材、重复/并发 apply、版本回滚和后续批次依赖拒绝。
- [ ] 在 PostgreSQL 17 验证 `0014_teacher_review_moderation.sql` 重复迁移、候选决定 append-only、approve/reject 并发、审计故障回滚和审核/批次回滚竞态。
- [x] 原生 CI 用真实 importer 并发 apply 同一私有包，确认教师/教材各只有一个 applied batch 且另一路幂等复用；同一候选并发批准、批准与回滚竞态只产生完整单一终态。
- [ ] 在 PostgreSQL 17 验证 `0015_teacher_user_reviews.sql` 空库/升级/重复迁移、每用户每教师活动评价唯一性、正文摘要与评分触发器、版本冲突、软删除重建，以及账号注销撤下评价且不被触发器阻断。
- [x] 在 PostgreSQL 17 验证 `0019_course_schedule_teacher_overlay.sql` 空库/升级/重复迁移、runtime/importer/backup ACL、0/1/多教师覆盖、目录与 schedule 存在性失败关闭、不同来源幂等/并发/逆序回滚和教师批次依赖保护；恢复演练检查至少 19 个迁移及覆盖表。PR #10 quality run `31473068640` 已通过。
- [ ] 在 PostgreSQL 17 验证 `0020_teacher_review_governance.sql` 空库/升级/重复迁移、runtime ACL、两级回复/版本冲突/注销脱敏、回复通知、评价与回复举报、MFA 案件 hide→restore→delete 和同事务双审计；恢复演练必须检查至少 20 个迁移及新增回复/编辑证据表。
- [x] 原生 CI 验证 auth runtime 对 `data_import_batches`、`data_import_rows`、`data_import_mutations`、`teacher_review_candidates` 和决定表无直接权限，只能执行审核白名单函数，并不能写教师来源身份或教学班教材事实。
- [x] 原生 CI 验证 importer 不能 UPDATE 候选、批准/拒绝、写公开评价或管理员审计，只能执行专用未批准候选回滚函数，且保持 `NOINHERIT`/无高权属性。
- [x] 原生 CI 验证 auth runtime 无法 UPDATE/DELETE/TRUNCATE `community_content_edits` 与 `community_moderation_actions`，但仍可按设计追加记录。
- [x] 原生 CI 验证 auth runtime 无法硬删除或截断 `community_topics`/`community_comments`；软删除后通知、回复引用和降级页仍可读取。
- [x] 原生 CI 用做过回复、被举报和被治理的测试账号验证注销不会被外键/不可变触发器阻断，且举报正文/作者标签快照和去标识化管理审计仍保留。编辑与账号制裁的更多组合继续留给 staging。
- [ ] 应用回滚只回滚运行镜像，不运行旧版本迁移器；每次发布和回滚后查询 ACL，防止旧的广泛授权恢复审计表变更权限。

## 3. 应用与容器

- [x] 主站、auth-api、小影分别 `npm ci`、测试、生产依赖审计和构建成功。
- [x] 干净安装后 `npm ls image-size --all` 只显示 `2.0.3-dufesh.0 -> vendor/image-size-disabled` 且 vinext 去重；构建日志无本地图片探测错误，镜像中不存在上游 `image-size@2.0.2`。
- [x] auth-api 与小影镜像在 Linux/Alpine 目标架构验证原生依赖可加载。
- [x] GitHub `linux-production-images` 作业实际全绿：三套镜像均从生产 Dockerfile 构建，最终用户为 `node`，auth-api 的 Argon2id/Sharp/PG、小影运行依赖、主站失败关闭 `image-size` 与生产网关冒烟全部通过。
- [ ] 容器使用非 root、只读文件系统、受限 tmpfs、CPU/内存/PID 与日志轮转。
- [ ] Caddy 只依赖主站核心服务启动；小影故障不会阻止主站和账号入口。
- [ ] `curl -I` 验证 `http://112.126.75.74/<path>?<query>` 与 `https://www.dufesh.cn/<path>?<query>` 均只经一次 308 到 `https://dufesh.cn` 同路径/查询；IP 响应不含应用正文或 `Set-Cookie`。
- [ ] PostgreSQL、auth-api、小影不映射公网端口。
- [ ] 静态资料和上传目录只授予所需读写权限，路径遍历测试通过。
- [ ] `/api/materials` 数量与发布清单一致，随机抽样列表、详情、预览、下载、404/410 与 403 状态；旧 `/resources/files/*` 有效链接保持兼容。
- [ ] `/api/teachers` 索引、详情和评价分页在最终私有数据的 staging 导入上通过；同名不同学院不合并且评价不串教师，私有候选/来源摘要/内部状态不出现在响应，未发布评价不可见，历史整理评价不参与五维均分。PG17 CI 已通过两位同名教师的稳定 UUID 隔离与评价不串号；本项保留给最终私有数据抽查。
- [ ] 使用两个真实普通账号验证 `/api/teachers/:teacher_id/my-review` 创建、读取、编辑冲突、删除、重新创建和跨账号隔离；跨站、匿名、额外字段、缺失五维评分和超限正文均被拒绝，账号注销后公开评价立即撤下。
- [ ] `/api/community/topics` 列表、详情和评论游标读取通过；匿名/登录个性化、双向屏蔽、删除主题 410、删除评论墓碑及无效游标均符合契约。
- [ ] 社区主题/评论发布、编辑和软删除通过真实账号验收；跨站请求、匿名请求、非作者、受制裁用户、双向屏蔽、额外字段、超长正文、旧版本和第三层回复均被拒绝或安全展平。
- [ ] 主题/评论点赞、收藏、拉黑和举报在真实 PostgreSQL 上保持幂等；重复请求、并发请求、自我拉黑/举报、被屏蔽目标、已删除目标和专项限流均符合契约。
- [ ] 拉黑事务会移除双方遗留点赞、拉黑者收藏并隐藏对方旧通知；取消点赞不会返回不可见内容计数，重复开放举报不会改写首份证据。
- [ ] 两个真实账号完成“回复主题/评论、@提及、未读计数、单条/全部已读、隐藏”闭环；自己、失活账号和双向屏蔽目标不收到通知，通知 ID 不能跨账号读取或修改。
- [ ] 管理员账号趋势按上海自然日覆盖连续 30 天且零日补齐；角色/状态/注册日期筛选和游标续读在真实 PostgreSQL 17 通过，公开资料响应抽查不含邮箱、学号、认证细节、会话、同步数据或私有内容。
- [ ] 软删除主题/评论后通知正文被清空且跳转降级到 `/community`；发件账号注销后响应不暴露去标识化 actor UUID。
- [ ] 普通用户不能读取管理员举报队列或触发任何敏感查询；管理员举报队列、入案与治理动作必须同时通过角色、基础会话、短期 MFA 提升和可信 Origin，提升会话在事务开始后被撤销时整体回滚。
- [x] 在真实 PostgreSQL 17 验证内容隐藏/软删除、举报结案、作者通知、社区治理记录与全局管理员审计同事务提交；完整状态矩阵仍由现有 API 回归覆盖，staging 继续抽查恢复与账号制裁。
- [x] 在真实 PostgreSQL 17 注入全局管理员审计写入故障，确认通用 503 失败关闭，主题/通知、举报/案件和社区治理动作全部回滚。
- [ ] 验证隐藏→恢复/删除、暂停/封禁→解封的案件保持审核中，隐藏或制裁仍生效时警告/驳回会被服务端拒绝；前端只显示服务端 `allowedActions`，目标状态变化后会刷新而不是强行提交旧动作，写成功但刷新失败时不得提示重复处置。
- [ ] Linux staging 容器逐项请求 HTML 引用的 JS/CSS 哈希资源并确认 200、正确 MIME 与长期缓存；Windows 本机 vinext 生产静态缓存存在路径分隔符差异，不能把本机 `vinext start` 结果替代容器验收。

## 4. 自动化门禁

- [x] ESLint、TypeScript/构建、SSR 回归通过。
- [x] 主站、auth-api、小影单元与 API 集成测试通过。
- [x] 数据库迁移、约束、导入幂等和权限测试通过。
- [x] GitHub `postgres-17-integration` 作业从空库执行 `run-migrations.sh` 两遍，通过真实 owner/runtime/importer/backup 与账号/业务测试，并现场 `pg_dump` 后以 `restore-drill.sh` native 模式恢复到隔离临时库，检查迁移/约束/关键表/RTO 和零残留。
- [ ] 用本次私有包在 staging 完成首次 apply、第二次幂等 no-op、错误依赖顺序拒绝和教材→教师回滚；私有包不得进入镜像、Git、静态目录或备份公开层。
- [x] 关键路径浏览器 E2E 通过：注册→资料→跨设备→教师→评价→回复→通知→举报→管理员处理。
  - PR #10 run `31466722843` 的 `Authenticated browser critical path` 在真实 PostgreSQL runtime 上通过。
- [x] 课表中的教师姓名先进入索引消歧；只有持有稳定 `teacher_id` 的数据才能直达详情，不能用同名首条记录代替。
- [x] 普通用户访问 `/admin` 与所有管理 API 均被拒绝。
- [x] 320/360/375/390/414/768px 与横屏浏览器检查通过。
- [x] axe 无 critical/serious；键盘、焦点、屏幕阅读器提示与 reduced motion 通过。
- [ ] Lighthouse/真实性能预算达到计划目标，长列表和弱网可用。
- [x] 主站、auth-api、小影生产依赖 high/critical 0；CodeQL 与全历史 Gitleaks 秘密扫描通过。
  - PR #10 run `31466722843` 提供 GitHub runner 证据；Actions 使用完整提交 SHA 与最小权限。

## 5. 安全与隐私

- [ ] `SECURITY_REVIEW.md` 全部 P0/P1 关闭并附测试证据。
- [ ] Secure/HttpOnly/SameSite Cookie、CSRF/Origin、CORS 白名单和请求体限制验证。
- [ ] 主站每次文档响应生成新 CSP nonce，全部可执行内联脚本携带匹配值；小影脚本/样式哈希与实际 HTML 一致；浏览器控制台无 CSP 拒绝。仅主站动态样式属性允许定向 `style-src-attr 'unsafe-inline'`，`script-src` 与 `style-src` 不允许广泛内联；HSTS、COOP/CORP、点击劫持、MIME 与权限策略正确。
- [ ] 登录、重置、发布、点赞、回复、举报、上传和第三方调用限流通过；两个 auth-api 实例共享配额且重启不清零，小影邀请码/配对配额重启不清零，真实代理链不能用伪造 `X-Forwarded-For` 换桶，数据库不可用时不得回退为单机放行。
- [ ] 头像/附件的魔数、MIME、尺寸、体积、EXIF 和隔离流程通过。
- [ ] 日志、错误页、审计、备份、前端 bundle 和导出文件不含密钥/令牌/密码。
- [ ] TraceInt 授权首跳、全部重定向和 GraphQL 均为官方域名 HTTPS；HTTP 配置与明文跳转失败关闭，真实授权码和 Cookie 不出现在 URL 日志或错误响应。
- [ ] 隐私政策、用户协议、账号注销、历史评价来源与内容规范与实际行为一致。

## 6. Staging 验收

- [ ] 使用独立 staging 数据完成迁移与种子导入，不复制生产敏感数据。
- [ ] HTTPS、域名、邮件、回调、上传、资料预览、通知和健康检查真实工作。
- [ ] 至少两个普通账号和一个管理员完成端到端验收。
- [ ] 负载下会话、搜索、社区和同步无明显错误；数据库连接、CPU、内存、磁盘可观测。
- [ ] 告警能覆盖 5xx、登录异常、任务积压、磁盘、备份失败和数据库不可用。
- [ ] staging 部署地址、提交 SHA、镜像摘要与测试时间写入 `PROGRESS.md`。

## 7. 生产发布与回滚

- [ ] Pull Request 已审查，CI 全绿，发布提交不可变。
- [ ] 生成 release 目录与镜像，记录 Git SHA、迁移版本和镜像摘要。
  - Compose 已支持三个自建镜像统一使用 `DUFESH_IMAGE_TAG`；正式构建、启动和回滚必须传完整 Git SHA，不能记录 `latest`。
- [ ] 发布窗口、负责人、观察窗口和回滚触发条件明确。
- [ ] 先执行向后兼容迁移，再切换应用软链接/镜像；不执行未审批的破坏性 contract。
- [ ] 发布后检查首页、注册登录、同步、资料、社区、通知、管理员、健康接口、安全头和日志。
- [ ] 在 staging 用批准的测试文案发布一次系统公告，核对活动测试账号收件数、通知正文/降级路径、相同 mutation 重试不重复、冲突重试返回 409、全局审计和 `0017` 不可变权限；生产未确认文案与窗口前不得发送。
- [ ] 回滚使用上一不可变 release；数据库仅使用预先验证的前滚/兼容策略，不临时删除生产数据。
  - `docs/OPERATIONS_RUNBOOK.md` 已给出受限目标检查、原子软链接和对应镜像标签顺序；首次 Linux staging 演练前不得勾选。
- [ ] 完成观察后在 `docs/RELEASES.md` 增加简短正式发布记录。

## 8. 当前外部条件

- 微信开放平台正式 AppID/AppSecret 与最终审核状态：未提供，本地不需要等待；生产微信入口受此阻塞。
- 独立 staging 环境与凭据：尚未确认，未擅自创建付费资源。
- 邮件发送服务凭据：尚未提供；失败关闭 SMTP 适配器和本地投递契约已实现，生产验证/重置邮件的真实服务商投递仍受此阻塞。
- 当前开发机未安装 `sh`、Docker/PostgreSQL 或 WSL；PR #10 run `31470482243` 已完成空库 18 个迁移双执行、角色 ACL、教材不同来源并发/版本循环/教师回滚重导、完整真实账号浏览器路径、现场备份恢复和 Linux musl 原生模块验证。当前分支新增 `0019_course_schedule_teacher_overlay.sql` 并把恢复门槛提升为 19，必须取得新 runner 的目录覆盖、0/1/多教师、ACL、逆序回滚和隔离恢复证据；既有数据库升级副本、真实私有导入包、生产备份和外部服务仍须 staging 验收。
- 主站已用仓库内失败关闭包隔离 vinext 的 `image-size@2.0.2`；Linux PR CI 已复核实际去重、构建、生产审计与网关冒烟。正式镜像摘要和上一版本回滚仍须 staging 记录。
- 本地门禁与 PR #10 quality run `31466722843` 均通过；后续代码或发布文档变化必须重新保持 PR CI 全绿。该证据不替代真实 Web Vitals、代理链、监控、外部凭据和生产审批。
- 异地对象存储/备份凭据：尚未提供；本地适配器和恢复流程继续开发，生产异地副本受此阻塞。
