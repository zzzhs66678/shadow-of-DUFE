# 东财之影部署检查表

最后更新：2026-08-09

当前结论：**尚不具备生产部署条件。本轮未部署。** 只有全部“生产前门禁”通过，且没有不可接受的高危项，才允许进入人工生产发布审批。

## 1. 环境与凭据

- [ ] 明确 staging 域名、数据库、文件存储和回调地址，与生产完全隔离。
- [ ] `POSTGRES_PASSWORD`、`AUTH_TOKEN_PEPPER`、`AUTH_ADMIN_MFA_KEYS`、`AUTH_ADMIN_RECOVERY_PEPPER`、邮件凭据、微信 AppSecret、上传存储密钥和小影主密钥只存在于受限环境文件或密钥管理服务。
- [ ] `.env.example` 列全变量但不含真实值；服务器环境文件权限为 600。
- [ ] 微信 AppID/AppSecret 与审核状态真实可用；若缺失，正式 UI 只提供已验证的降级登录。
- [ ] 对象存储/头像存储凭据真实可用；若未开通，使用经过验证的本地受限存储适配器并记录容量边界。
- [ ] 管理员初始化通过一次性命令完成，不在仓库保存固定密码或 Token。

## 2. 数据库与迁移

- [ ] 从空 PostgreSQL 17 实例依次执行全部迁移成功。
- [ ] 对同一实例重复执行迁移无变化，摘要校验有效。
- [ ] 生产迁移前创建加密备份，并在临时数据库完成完整恢复。
- [ ] 记录 expand/backfill/validate/cutover/contract 每一步与预计锁时间。
- [ ] 大索引和回填不在单个长事务中阻塞生产业务。
- [ ] teacher/material/community 导入先 dry-run，保存批次报告和回滚标识。
- [ ] 数据库 owner、migrator、runtime、backup 角色按最小权限分离。
- [ ] 在 PostgreSQL 17 验证 `0010_community_foundation.sql` 空库/升级库迁移、两级回复触发器、软删除引用、通知/互动去重和开放举报部分唯一索引。
- [ ] 在 PostgreSQL 17 验证 `0011_community_read_paths.sql` 重复执行和查询计划；软删除根评论仍使用墓碑索引分页并保留回复线程。
- [ ] 验证 auth runtime 无法 UPDATE/DELETE/TRUNCATE `community_content_edits` 与 `community_moderation_actions`，但仍可按设计追加记录。
- [ ] 验证 auth runtime 无法硬删除或截断 `community_topics`/`community_comments`；软删除后通知、回复引用和降级页仍可读取。
- [ ] 用做过编辑、举报、审核与被制裁的测试账号验证注销不会被外键/不可变触发器阻断，且去标识化审计证据仍保留。
- [ ] 应用回滚只回滚运行镜像，不运行旧版本迁移器；每次发布和回滚后查询 ACL，防止旧的广泛授权恢复审计表变更权限。

## 3. 应用与容器

- [ ] 主站、auth-api、小影分别 `npm ci`、测试、生产依赖审计和构建成功。
- [ ] auth-api 与小影镜像在目标架构验证原生依赖可加载。
- [ ] 容器使用非 root、只读文件系统、受限 tmpfs、CPU/内存/PID 与日志轮转。
- [ ] Caddy 只依赖主站核心服务启动；小影故障不会阻止主站和账号入口。
- [ ] PostgreSQL、auth-api、小影不映射公网端口。
- [ ] 静态资料和上传目录只授予所需读写权限，路径遍历测试通过。
- [ ] `/api/materials` 数量与发布清单一致，随机抽样列表、详情、预览、下载、404/410 与 403 状态；旧 `/resources/files/*` 有效链接保持兼容。
- [ ] `/api/community/topics` 列表、详情和评论游标读取通过；匿名/登录个性化、双向屏蔽、删除主题 410、删除评论墓碑及无效游标均符合契约。

## 4. 自动化门禁

- [ ] ESLint、TypeScript/构建、SSR 回归通过。
- [ ] 主站、auth-api、小影单元与 API 集成测试通过。
- [ ] 数据库迁移、约束、导入幂等和权限测试通过。
- [ ] 关键路径浏览器 E2E 通过：注册→资料→跨设备→教师→评价→回复→通知→举报→管理员处理。
- [ ] 普通用户访问 `/admin` 与所有管理 API 均被拒绝。
- [ ] 320/360/375/390/414/768px 与横屏浏览器检查通过。
- [ ] axe 无 critical/serious；键盘、焦点、屏幕阅读器提示与 reduced motion 通过。
- [ ] Lighthouse/真实性能预算达到计划目标，长列表和弱网可用。
- [ ] 主站、auth-api、小影生产依赖 high/critical 0；CodeQL/秘密扫描通过。

## 5. 安全与隐私

- [ ] `SECURITY_REVIEW.md` 全部 P0/P1 关闭并附测试证据。
- [ ] Secure/HttpOnly/SameSite Cookie、CSRF/Origin、CORS 白名单和请求体限制验证。
- [ ] CSP 不依赖广泛 `unsafe-inline`；HSTS、COOP/CORP、点击劫持、MIME 与权限策略正确。
- [ ] 登录、重置、发布、点赞、回复、举报、上传和第三方调用限流通过。
- [ ] 头像/附件的魔数、MIME、尺寸、体积、EXIF 和隔离流程通过。
- [ ] 日志、错误页、审计、备份、前端 bundle 和导出文件不含密钥/令牌/密码。
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
- 当前开发机未安装 `sh`、Docker/PostgreSQL；`0006_credential_auth.sql`、`0007_user_avatars.sql`、`0008_admin_security.sql`、`0009_email_verification.sql` 的空库、升级库、重复执行，以及 Linux musl 原生 Argon2id/Sharp 镜像验证必须在 staging 或具备 Docker 的 CI 完成。邮箱令牌、管理员 TOTP/恢复码并发消费、审计失败回滚、`AUTH_DB_USER` 对业务表/审计表/迁移账本的权限矩阵和 `run-migrations.sh` 实际执行仍需真实 PostgreSQL 集成测试。
- 异地对象存储/备份凭据：尚未提供；本地适配器和恢复流程继续开发，生产异地副本受此阻塞。
