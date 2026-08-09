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
