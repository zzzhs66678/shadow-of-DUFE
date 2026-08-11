# 东财之影部署检查表

最后更新：2026-08-11

当前结论：**尚不具备生产部署条件。本轮未部署。** 只有全部“生产前门禁”通过，且没有不可接受的高危项，才允许进入人工生产发布审批。

## 1. 环境与凭据

- [ ] 明确 staging 域名、数据库、文件存储和回调地址，与生产完全隔离。
- [ ] `POSTGRES_PASSWORD`、`AUTH_TOKEN_PEPPER`、`AUTH_ADMIN_MFA_KEYS`、`AUTH_ADMIN_RECOVERY_PEPPER`、邮件凭据、微信 AppSecret、上传存储密钥和小影主密钥只存在于受限环境文件或密钥管理服务。
- [ ] 小影正式环境同时设置至少 12 位随机 `XIAOYING_DEFAULT_INVITE_CODE` 与 1—500 的 `XIAOYING_DEFAULT_INVITE_MAX_USES`；使用前复核本批计划人数，轮换时确认旧码立即失效。
- [ ] `.env.example` 列全变量但不含真实值；服务器环境文件权限为 600。
- [ ] 微信 AppID/AppSecret 与审核状态真实可用；若缺失，正式 UI 只提供已验证的降级登录。
- [ ] 对象存储/头像存储凭据真实可用；若未开通，使用经过验证的本地受限存储适配器并记录容量边界。
- [ ] 管理员初始化通过一次性命令完成，不在仓库保存固定密码或 Token。

## 2. 数据库与迁移

- [ ] 从空 PostgreSQL 17 实例依次执行全部迁移成功。
- [ ] 对同一实例重复执行迁移无变化，摘要校验有效。
- [ ] 生产迁移前创建加密备份，并在临时数据库完成完整恢复。
- [ ] 启用 `dufesh-db-restore-drill.timer`，从真实备份完成首次隔离恢复；日志记录备份文件、行数摘要和 RTO，临时 `dufesh_restore_drill_*` 数据库在成功与故障后均已清理，生产库全程未被 restore 目标引用。
- [ ] 记录 expand/backfill/validate/cutover/contract 每一步与预计锁时间。
- [ ] 大索引和回填不在单个长事务中阻塞生产业务。
- [ ] teacher/material/community 导入先 dry-run，保存批次报告和回滚标识。
- [ ] 数据库 owner、migrator、runtime、backup 角色按最小权限分离。
- [ ] 在 600 权限 `postgres.env` 配置不可登录 `MIGRATION_DB_ROLE` 与独立 `MIGRATION_DB_USER/MIGRATION_DB_PASSWORD`；确认 migrator 为 `NOINHERIT`、仅能 `SET ROLE` 到 schema owner，基础会话不能读业务表，schema owner 无登录/高权属性并持有全部 public 对象。
- [ ] 首次升级先用当前正式版本完成 owner 备份，再运行新迁移器接管 public 对象所有权；在 staging 验证空库、既有库、第二次幂等执行和失败事务回滚后才能进入生产窗口。
- [ ] 为 backup 生成独立长随机 `BACKUP_DB_USER/BACKUP_DB_PASSWORD` 写入 600 权限 `postgres.env`；用该角色完成 custom-format `pg_dump`，并验证可完整恢复，同时不能写表或执行 public 函数。
- [ ] 为 importer 生成独立长随机密码并配置 `IMPORT_DB_USER/IMPORT_DB_PASSWORD`；确认该角色 `NOINHERIT`，不能读取账号、凭据、会话、MFA、OAuth 或头像表。
- [ ] 在 PostgreSQL 17 验证 `0010_community_foundation.sql` 空库/升级库迁移、两级回复触发器、软删除引用、通知/互动去重和开放举报部分唯一索引。
- [ ] 在 PostgreSQL 17 验证 `0011_community_read_paths.sql` 重复执行和查询计划；软删除根评论仍使用墓碑索引分页并保留回复线程。
- [ ] 在 PostgreSQL 17 验证 `0012_community_report_evidence.sql` 空库/升级/重复迁移、旧举报回填和快照不可变触发器；编辑或删除目标后审核证据仍保持举报时内容。
- [ ] 在 PostgreSQL 17 验证 `0013_teacher_catalog_imports.sql` 空库/升级/重复迁移、同名教师隔离、来源键冲突、历史候选默认私有、同教学班多教材、重复/并发 apply、版本回滚和后续批次依赖拒绝。
- [ ] 在 PostgreSQL 17 验证 `0014_teacher_review_moderation.sql` 重复迁移、候选决定 append-only、approve/reject 并发、审计故障回滚和审核/批次回滚竞态。
- [ ] 原生 CI 用真实 importer 并发 apply 同一私有包，确认教师/教材各只有一个 applied batch 且另一路幂等复用；同一候选并发批准、批准与回滚竞态只产生完整单一终态。首次全绿前不勾选。
- [ ] 在 PostgreSQL 17 验证 `0015_teacher_user_reviews.sql` 空库/升级/重复迁移、每用户每教师活动评价唯一性、正文摘要与评分触发器、版本冲突、软删除重建，以及账号注销撤下评价且不被触发器阻断。
- [ ] 原生 CI 验证 auth runtime 对 `data_import_batches`、`data_import_rows`、`data_import_mutations`、`teacher_review_candidates` 和决定表无直接权限，只能执行审核白名单函数，并不能写教师来源身份或教学班教材事实；首次实际全绿前不勾选。
- [ ] 原生 CI 验证 importer 不能 UPDATE 候选、批准/拒绝、写公开评价或管理员审计，只能执行专用未批准候选回滚函数，且保持 `NOINHERIT`/无高权属性；首次实际全绿前不勾选。
- [ ] 原生 CI 验证 auth runtime 无法 UPDATE/DELETE/TRUNCATE `community_content_edits` 与 `community_moderation_actions`，但仍可按设计追加记录；首次实际全绿前不勾选。
- [ ] 原生 CI 验证 auth runtime 无法硬删除或截断 `community_topics`/`community_comments`；软删除后通知、回复引用和降级页仍可读取；首次实际全绿前不勾选。
- [ ] 原生 CI 用做过回复、被举报和被治理的测试账号验证注销不会被外键/不可变触发器阻断，且举报正文/作者标签快照和去标识化管理审计仍保留；首次实际全绿后，再补编辑与账号制裁组合场景。
- [ ] 应用回滚只回滚运行镜像，不运行旧版本迁移器；每次发布和回滚后查询 ACL，防止旧的广泛授权恢复审计表变更权限。

## 3. 应用与容器

- [ ] 主站、auth-api、小影分别 `npm ci`、测试、生产依赖审计和构建成功。
- [ ] 干净安装后 `npm ls image-size --all` 只显示 `2.0.3-dufesh.0 -> vendor/image-size-disabled` 且 vinext 去重；构建日志无本地图片探测错误，镜像中不存在上游 `image-size@2.0.2`。
- [ ] auth-api 与小影镜像在目标架构验证原生依赖可加载。
- [ ] GitHub `linux-production-images` 作业实际全绿：三套镜像均从生产 Dockerfile 构建，最终用户为 `node`，auth-api 的 Argon2id/Sharp/PG、小影运行依赖、主站失败关闭 `image-size` 与生产网关冒烟全部通过；本地静态契约不得替代该证据。
- [ ] 容器使用非 root、只读文件系统、受限 tmpfs、CPU/内存/PID 与日志轮转。
- [ ] Caddy 只依赖主站核心服务启动；小影故障不会阻止主站和账号入口。
- [ ] `curl -I` 验证 `http://112.126.75.74/<path>?<query>` 与 `https://www.dufesh.cn/<path>?<query>` 均只经一次 308 到 `https://dufesh.cn` 同路径/查询；IP 响应不含应用正文或 `Set-Cookie`。
- [ ] PostgreSQL、auth-api、小影不映射公网端口。
- [ ] 静态资料和上传目录只授予所需读写权限，路径遍历测试通过。
- [ ] `/api/materials` 数量与发布清单一致，随机抽样列表、详情、预览、下载、404/410 与 403 状态；旧 `/resources/files/*` 有效链接保持兼容。
- [ ] `/api/teachers` 索引、详情和评价分页在真实数据上通过；同名不同学院不合并且评价不串教师，私有候选/来源摘要/内部状态不出现在响应，未发布评价不可见，历史整理评价不参与五维均分。PG17 同名隔离场景已编码但首次 CI 全绿前不得勾选。
- [ ] 使用两个真实普通账号验证 `/api/teachers/:teacher_id/my-review` 创建、读取、编辑冲突、删除、重新创建和跨账号隔离；跨站、匿名、额外字段、缺失五维评分和超限正文均被拒绝，账号注销后公开评价立即撤下。
- [ ] `/api/community/topics` 列表、详情和评论游标读取通过；匿名/登录个性化、双向屏蔽、删除主题 410、删除评论墓碑及无效游标均符合契约。
- [ ] 社区主题/评论发布、编辑和软删除通过真实账号验收；跨站请求、匿名请求、非作者、受制裁用户、双向屏蔽、额外字段、超长正文、旧版本和第三层回复均被拒绝或安全展平。
- [ ] 主题/评论点赞、收藏、拉黑和举报在真实 PostgreSQL 上保持幂等；重复请求、并发请求、自我拉黑/举报、被屏蔽目标、已删除目标和专项限流均符合契约。
- [ ] 拉黑事务会移除双方遗留点赞、拉黑者收藏并隐藏对方旧通知；取消点赞不会返回不可见内容计数，重复开放举报不会改写首份证据。
- [ ] 两个真实账号完成“回复主题/评论、@提及、未读计数、单条/全部已读、隐藏”闭环；自己、失活账号和双向屏蔽目标不收到通知，通知 ID 不能跨账号读取或修改。
- [ ] 软删除主题/评论后通知正文被清空且跳转降级到 `/community`；发件账号注销后响应不暴露去标识化 actor UUID。
- [ ] 普通用户不能读取管理员举报队列或触发任何敏感查询；管理员举报队列、入案与治理动作必须同时通过角色、基础会话、短期 MFA 提升和可信 Origin，提升会话在事务开始后被撤销时整体回滚。
- [ ] 在真实 PostgreSQL 17 验证内容隐藏/恢复/软删除、用户警告/暂停/封禁/解封、举报结案、作者通知、社区治理记录与全局管理员审计同事务提交；重复动作、目标类型错误、管理员自我制裁和并发处理均安全拒绝。
- [ ] 在真实 PostgreSQL 17 注入全局管理员审计写入故障，确认主题/通知、举报/案件和社区治理动作全部回滚；静态检查或本地 SKIP 不作为通过证据。
- [ ] 验证隐藏→恢复/删除、暂停/封禁→解封的案件保持审核中，隐藏或制裁仍生效时警告/驳回会被服务端拒绝；前端只显示服务端 `allowedActions`，目标状态变化后会刷新而不是强行提交旧动作，写成功但刷新失败时不得提示重复处置。
- [ ] Linux staging 容器逐项请求 HTML 引用的 JS/CSS 哈希资源并确认 200、正确 MIME 与长期缓存；Windows 本机 vinext 生产静态缓存存在路径分隔符差异，不能把本机 `vinext start` 结果替代容器验收。

## 4. 自动化门禁

- [ ] ESLint、TypeScript/构建、SSR 回归通过。
- [ ] 主站、auth-api、小影单元与 API 集成测试通过。
- [ ] 数据库迁移、约束、导入幂等和权限测试通过。
- [ ] GitHub `postgres-17-integration` 作业从空库执行 `run-migrations.sh` 两遍，通过真实 owner/runtime/importer 与账号/业务测试，并现场 `pg_dump` 后以 `restore-drill.sh` native 模式恢复到隔离临时库，检查迁移/约束/关键表/RTO和零残留；本地 SKIP 或脚本静态检查不得作为替代证据。
- [ ] 用本次私有包在 staging 完成首次 apply、第二次幂等 no-op、错误依赖顺序拒绝和教材→教师回滚；私有包不得进入镜像、Git、静态目录或备份公开层。
- [ ] 关键路径浏览器 E2E 通过：注册→资料→跨设备→教师→评价→回复→通知→举报→管理员处理。
  - 已编码但未实跑的 PG17 浏览器切片仅覆盖页面注册、主题、回复、举报、通知、普通用户拒绝与管理员 TOTP 入台；不得因此勾选完整关键路径。
- [ ] 课表中的教师姓名先进入索引消歧；只有持有稳定 `teacher_id` 的数据才能直达详情，不能用同名首条记录代替。
- [ ] 普通用户访问 `/admin` 与所有管理 API 均被拒绝。
- [ ] 320/360/375/390/414/768px 与横屏浏览器检查通过。
- [ ] axe 无 critical/serious；键盘、焦点、屏幕阅读器提示与 reduced motion 通过。
- [ ] Lighthouse/真实性能预算达到计划目标，长列表和弱网可用。
- [ ] 主站、auth-api、小影生产依赖 high/critical 0；CodeQL/秘密扫描通过。

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
- [ ] 发布窗口、负责人、观察窗口和回滚触发条件明确。
- [ ] 先执行向后兼容迁移，再切换应用软链接/镜像；不执行未审批的破坏性 contract。
- [ ] 发布后检查首页、注册登录、同步、资料、社区、通知、管理员、健康接口、安全头和日志。
- [ ] 回滚使用上一不可变 release；数据库仅使用预先验证的前滚/兼容策略，不临时删除生产数据。
- [ ] 完成观察后在 `docs/RELEASES.md` 增加简短正式发布记录。

## 8. 当前外部条件

- 微信开放平台正式 AppID/AppSecret 与最终审核状态：未提供，本地不需要等待；生产微信入口受此阻塞。
- 独立 staging 环境与凭据：尚未确认，未擅自创建付费资源。
- 邮件发送服务凭据：尚未提供；密码注册可先本地验证，生产验证/重置邮件受此阻塞。
- 当前开发机未安装 `sh`、Docker/PostgreSQL 或 WSL；`0006_credential_auth.sql`—`0016_shared_rate_limits.sql` 的空库、升级库、重复执行，以及 Linux musl 原生 Argon2id/Sharp 镜像验证必须在 staging 或具备 Docker 的 CI 完成。仓库原生作业已经编码迁移双执行、ACL/共享限流、真实账号 HTTP/浏览器业务切片和现场备份恢复，但尚未推送运行；教师导入/审核的其余并发、migrator/backup 权限、完整浏览器关键路径、Linux 镜像与首次隔离恢复仍需真实执行。
- 主站已用仓库内失败关闭包隔离 vinext 的 `image-size@2.0.2`，干净本地 `npm ci` 后生产依赖审计为 0；仍须由 Linux PR CI 与 staging 镜像复核实际去重、构建和审计，未复核前不得放行生产发布。
- 本地 `npm run typecheck`、主仓 Node 91/91、个人存储/同步 9/9、auth-api 72/72、构建后渲染 4/4、CSS 审计和相关 ESLint 已通过；渲染 4 项已包含在主仓 91 项中，不重复计数。quality workflow 已加入 TypeScript 步骤；仍须由 Pull Request CI 在 Linux 上复核后才能勾选生产前质量门禁。
- 异地对象存储/备份凭据：尚未提供；本地适配器和恢复流程继续开发，生产异地副本受此阻塞。
