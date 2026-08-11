# 东财之影

面向东北财经大学学生的课程、个人课表、空教室与学习资料网站。

- 正式站：[dufesh.cn](https://dufesh.cn)
- 技术栈：React、TypeScript、vinext、PostgreSQL、Caddy、Docker
- 课程数据：由 Excel 离线生成完整 `public/data/course-data.json`，并同步生成首页轻量 `public/data/course-core.json`
- VIP 校园服务：独立的 `xiaoying-executor`，通过主站子路径隔离运行

## 开始维护

按顺序阅读：

1. `docs/CURRENT_STATE.md`：当前生效的产品与技术事实。
2. `docs/DECISIONS.md`：仍然有效的长期设计决定。
3. `docs/ROADMAP.md`：尚未完成的产品路线。
4. `docs/RELEASES.md`：用户可感知的正式版本。

`PROJECT_CONTEXT.md` 只用于追溯旧方案，日常任务不读取。

## 本地运行

要求 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

需要在主站显示小影内测入口时：

```powershell
$env:NEXT_PUBLIC_XIAOYING_URL = "/campus-lab/"
npm run build
```

小影本地服务：

```bash
cd xiaoying-executor
npm install
cd ..
npm run xiaoying:x1
```

本地邀请码为 `fjbadguy`。正式环境必须从服务器环境变量注入独立随机邀请码和主密钥。

## 验证

```bash
npx eslint app services tests scripts xiaoying-executor/bin xiaoying-executor/src
node --test tests/product-experience.test.mjs tests/infrastructure-contract.test.mjs
npm run test:xiaoying
npm run build
node --test tests/rendered-html.test.mjs
npm audit --omit=dev --audit-level=high
```

进入 `xiaoying-executor` 后再执行一次生产依赖审计。

## 发布

阿里云 ECS 使用不可变 release 目录和原子软链接切换。主站、账号 API、小影和 Caddy
分别运行在受限容器中；PostgreSQL 与小影不映射公网端口。每次正式发布都应：

1. 通过全部回归、构建和生产依赖审计。
2. 创建明确的 Git 提交和版本标签。
3. 从该提交生成发布包。
4. 切换 release 后检查 HTTPS、健康接口、安全响应头和容器日志。

不得提交密码、Cookie、SSH 私钥、AppSecret、邀请码、验证码、主密钥或本地数据库。

### 生产环境文件

仓库不提供可直接上线的默认密钥。先从以下四份无秘密模板创建服务器文件，并把每份权限设为 `600`：

- `ops/postgres/postgres.env.example` → `/srv/apps/dufesh/shared/config/postgres.env`
- `services/auth-api/auth.env.example` → `/srv/apps/dufesh/shared/config/auth.env`
- `xiaoying-executor/xiaoying.env.example` → `/srv/apps/dufesh/shared/config/xiaoying.env`
- `ops/postgres/backup.env.example` → `/srv/apps/dufesh/shared/config/backup.env`

模板中的密码、pepper、MFA 密钥、小影主密钥和邀请码故意留空；未替换时相应服务或迁移必须失败关闭。各数据库角色使用互不相同的随机密码。`AUTH_WECHAT_MODE` 在真实微信适配和凭据就绪前保持 `disabled`，不得把 mock 当作正式登录。

密钥可在管理员本机生成，不把命令输出写入 shell 历史或聊天记录：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

首次发布按 `docs/DEPLOYMENT_CHECKLIST.md` 逐项验证迁移、角色权限、管理员 TOTP、备份恢复、健康检查和回滚；不要仅因容器成功启动就放行。

具体的发布提交绑定、镜像标签、原子切换、管理员一次性初始化与回滚顺序见 `docs/OPERATIONS_RUNBOOK.md`。运维命令只在 CI、staging 和人工审批都通过后执行；本仓库不会自动触发生产部署。
