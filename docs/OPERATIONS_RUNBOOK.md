# 东财之影发布与回滚手册

本手册只描述经过审批后的操作顺序，不授权当前任务部署生产。真实执行前必须完成 `docs/DEPLOYMENT_CHECKLIST.md`，并由操作者记录时间、提交 SHA、镜像摘要和结果。

## 1. 发布前提

- Pull Request 已审查，GitHub quality workflow 全绿；PostgreSQL 17、完整浏览器路径、Linux 镜像、CodeQL 和 Gitleaks 均有真实 runner 证据。
- staging 使用独立数据库和凭据完成同版本迁移、导入、管理员路径、备份恢复、性能和回滚演练。
- 本次迁移均已确认向后兼容；不得在同一窗口执行未经审批的删除列、删表或不可逆数据改写。
- 四份服务器环境文件已填入互异随机值、权限为 `600`，且未进入 release 目录、Git、终端日志或聊天记录。
- 当前 release 目录、上一 release 目录、生产备份、负责人、观察窗口和回滚阈值均已记录。

## 2. 绑定不可变版本

发布目录名和三个自建镜像标签都使用同一个完整 Git SHA。示例中的变量只在当前受控终端会话使用：

```bash
DUFESH_RELEASE_SHA="$(git rev-parse HEAD)"
DUFESH_RELEASE_DIR="/srv/apps/dufesh/releases/$DUFESH_RELEASE_SHA"
test "$(printf %s "$DUFESH_RELEASE_SHA" | wc -c)" -eq 40
test -d "$DUFESH_RELEASE_DIR"
```

在 release 目录构建时显式传入标签；禁止以 `latest` 作为正式发布记录：

```bash
cd "$DUFESH_RELEASE_DIR"
DUFESH_IMAGE_TAG="$DUFESH_RELEASE_SHA" docker compose build app auth-api xiaoying
DUFESH_IMAGE_TAG="$DUFESH_RELEASE_SHA" docker compose images
```

把 `docker image inspect` 得到的三个镜像 ID/RepoDigest 与提交 SHA 写入发布记录。后续所有 `docker compose` 发布和回滚命令都必须带对应 `DUFESH_IMAGE_TAG`。

## 3. 迁移与切换

先备份并完成隔离恢复，再执行只向前兼容的迁移：

```bash
cd "$DUFESH_RELEASE_DIR"
/srv/apps/dufesh/current/ops/postgres/backup.sh
/srv/apps/dufesh/current/ops/postgres/restore-drill.sh
DUFESH_IMAGE_TAG="$DUFESH_RELEASE_SHA" docker compose --profile tools run --rm migrate
```

迁移成功后创建临时链接并原子替换 `current`；目标必须位于固定 releases 目录：

```bash
test "$(dirname "$DUFESH_RELEASE_DIR")" = "/srv/apps/dufesh/releases"
ln -s "$DUFESH_RELEASE_DIR" /srv/apps/dufesh/current.next
mv -Tf /srv/apps/dufesh/current.next /srv/apps/dufesh/current
cd /srv/apps/dufesh/current
DUFESH_IMAGE_TAG="$DUFESH_RELEASE_SHA" docker compose up -d --no-build
```

若 `current.next` 已存在，先停止并人工核对其目标；不要在脚本里递归删除未知路径。

## 4. 发布后检查

在观察窗口内逐项记录：

- `docker compose ps` 的健康状态，以及主站、auth-api、小影、PostgreSQL 和 Caddy 的受限日志。
- 主域名首页、注册登录、资料编辑、云同步、资料搜索、教师详情与评价、社区回复/通知/举报、管理员处理和账号注销。
- `/api/auth/health`、静态 JS/CSS、资料预览/下载、CSP/安全头、`www` 与直接 IP 的单次 308。
- 5xx、登录异常、数据库连接、CPU、内存、磁盘和任务积压；不得在日志中打印 Cookie、授权码、密码、TOTP 或恢复码。

只有观察窗口通过后才更新 `docs/RELEASES.md`；失败时保留现场证据并进入回滚。

## 5. 管理员一次性初始化

先让目标管理员注册普通账号，再把 `AUTH_ADMIN_ENABLED=true`、有效 MFA keyring 和独立 recovery pepper 写入 600 权限 auth 环境文件。初始化命令必须在私密交互终端运行，不得重定向、录屏、复制到工单或进入集中日志：

```bash
cd /srv/apps/dufesh/current
DUFESH_IMAGE_TAG="$DUFESH_RELEASE_SHA" docker compose exec auth-api npm run admin:bootstrap -- <username-or-email>
```

命令只显示一次 TOTP secret、Authenticator URI 和十个恢复码，并撤销该账号全部旧会话。操作者应立即录入认证器、把恢复码放入受控离线保管位置、清理终端回滚缓冲，然后重新登录验证 MFA 与审计。已有 MFA 时只有经审批的应急轮换才加 `--rotate`；轮换后旧 TOTP、恢复码和所有旧会话都必须失效。

## 6. 应用回滚

回滚只切换到已记录的上一 release 和对应镜像标签，不运行旧迁移器、不恢复数据库覆盖当前库。先确认新版本迁移与旧应用兼容：

```bash
DUFESH_PREVIOUS_SHA="<previous-40-character-git-sha>"
DUFESH_PREVIOUS_DIR="/srv/apps/dufesh/releases/$DUFESH_PREVIOUS_SHA"
test "$(printf %s "$DUFESH_PREVIOUS_SHA" | wc -c)" -eq 40
test -d "$DUFESH_PREVIOUS_DIR"
test "$(dirname "$DUFESH_PREVIOUS_DIR")" = "/srv/apps/dufesh/releases"
ln -s "$DUFESH_PREVIOUS_DIR" /srv/apps/dufesh/current.next
mv -Tf /srv/apps/dufesh/current.next /srv/apps/dufesh/current
cd /srv/apps/dufesh/current
DUFESH_IMAGE_TAG="$DUFESH_PREVIOUS_SHA" docker compose up -d --no-build
```

回滚后重复健康、安全头和关键路径检查，并查询数据库角色/ACL 没有回到宽松权限。若迁移不向后兼容，停止发布并按事先审查的前滚修复处理；不得临时删除生产数据或覆盖式恢复。
