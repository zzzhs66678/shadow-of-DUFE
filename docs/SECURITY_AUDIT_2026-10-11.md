# 东财之影安全审计与修复：生产版本基线

日期：2026-10-11。状态：开发分支代码与本地隔离测试完成；没有发布生产、修改 staging、启用新注册或执行生产迁移。

当前交付补充了连接时 DNS/IP 校验、跨域登录请求体重放阻断和兼容依赖补丁。真实 PostgreSQL 非 owner 角色测试及本地只读备份/恢复已完成；当前生产代理 peer 已观察为172.18.0.6。网站两域名显式开启证书校验的 TLS 1.3 检查通过。代码仍未上线，下面的剩余事项不得当成已经修复。

## 范围与发布基线

生产 app/auth 当前版本为 `9de3008cf8411dd0012e499b1590117d42eac2c7`，数据库已应用至 `0027_community_reply_timeline.sql`。本报告和修复位于分支 `codex/security-production-20261011`，工作目录 `C:/Users/zzz/.codex/worktrees/security-production-base/云`，从该生产提交创建。

原目录 `C:/Users/zzz/Documents/云` 的安全审计基于较旧提交，含用户未提交的其他工作。其 `0021/0022` 编号与生产已应用迁移冲突，**不能作为发布候选直接部署**。本分支使用新增 `0028_registration_security.sql`，保留实际生产的教务导入、课表、考试、培养方案、教师评价、资料与收藏、社区时间线、纠错和管理员功能；没有复制旧本地教务原型。

读取与核查包括 CURRENT_STATE、AGENTS 约定、依赖/锁文件、认证/API/数据库迁移、测试、环境示例、Compose/Caddy/PostgreSQL 配置及线上只读元数据。实际技术栈：React/vinext、Node 认证服务、PostgreSQL 17、Caddy、Docker Compose；小影有独立 Node/SQLite 服务。没有新增 Redis 或微服务。

## 数据流与 F12 的结论

- 网站密码：浏览器表单内存 → 同源 `/api/auth/*` → Caddy → 认证服务 → 成熟库 Argon2id → PostgreSQL。API 不返回哈希；没有把密码写入浏览器持久存储的代码。F12 能查看当前浏览器提交的请求体是正常调试能力，**这本身不是网络明文泄漏证据**。HTTPS 加密的是在网络上传输的字节，不能对持有端点的浏览器隐藏密码。
- 注册邮件：仅提交邮箱 → 服务器生成验证码、预留共享数据库预算 → 固定 SMTP 模板 → 记录投递成功 → 最终注册提交 challengeId、验证码和密码 → 同一数据库事务消费证明并创建账号与会话。前端倒计时或 verified 字段不构成授权。
- 教务凭据：用户明确发起导入 → 网站认证服务的短期内存流程 → 固定允许的学校 VPN/SSO/教务目标 → 解析后的业务快照按用户存库。网站密码哈希与学校登录凭据分别处理；未新增永久保存学校密码。学校协议必要的 RSA/AES 保留。学校 HTTP 回源风险见 R07。
- 私有档案/课表/考试/收藏：服务端会话确定用户 → 参数化查询及资源归属校验 → 私有响应 no-store。保留既有个人课表离线存储，不清空用户业务数据。小影任务与学校会话仍使用既有账号/任务隔离。

## 风险清单

以下行号以本开发分支为准。代码修复通过不代表线上已生效。

| 编号/级别/证据分类 | 触发条件、证据与影响 | 修复、文件位置与验证状态 |
| --- | --- | --- |
| R01 高，已确认 | 原 register 直接创建正式账号，无邮箱证明；可抢占他人邮箱并滥用注册。现有邮箱数据库唯一索引已经存在。 | `services/auth-api/src/server.mjs:592`、`:633`，`src/db.mjs:1530`，新增 `src/registration-security.mjs` 与 `ops/postgres/migrations/0028_registration_security.sql`：邮箱/用途/挑战/申请浏览器绑定、已投递状态、原子消费。数据库增加 verified_password 必须具备验证时间的约束；已有账号不覆盖。原生 PG 并发/回滚与浏览器测试通过；线上未发布。 |
| R02 高，已确认 | 原转发头无明确可信代理边界；认证账号限流混入 IP，改变来源可分散攻击。生产新增收藏/反馈/教务路由也读取来源头。 | 新 `src/request-security.mjs`，`src/config.mjs:205`，`src/rate-limit.mjs:114`，各路由及小影 helper，Caddy 覆盖来源/协议/主机头。共享数据库独立账号、IP、跨接口及全局邮件额度。学校账号摘要限流 `academic-routes.mjs:390`、`rate-limit.mjs:151`，校园共享 IP 使用较宽额度。伪造头、不同账号、共享状态测试通过；已观察生产实际peer172.18.0.6，但安全代码尚未发布。 |
| R03 高，已确认配置风险；真实历史泄漏未确认 | 线上 PG `log_parameter_max_length=-1`，慢查询可能记录绑定邮箱、会话摘要或密码哈希；错误 DETAIL 可包含邮箱。仅合成日志测试复现，不推断已有真实泄漏。 | `ops/postgres/postgresql.conf:29` 两项参数日志长度置 0，terse 错误及限制错误 SQL；服务错误用固定事件名。原生 PG 合成敏感参数复现/修复检查通过。生产有效设置仍旧值，历史日志/备份审查未执行。 |
| R04 中，已确认 | 原新密码长度/字符组合策略不符合本次长口令要求。原网站密码已经使用 Argon2id，未发现明文存储。 | `src/credentials.mjs:39`、`:110`：新注册/重置 15–128 Unicode 码点，无字符类别强制，不截断/改写哈希输入；旧短密码仍可登录。`src/passwords.mjs` 保留 19MiB/t2/p1，限制两个哈希操作并发；旧哈希不再次当原密码处理。边界/兼容测试通过；生产 Linux 128MiB 容器性能待验证。 |
| R05 中，已确认 | 登录校验旧哈希后创建会话可能与重置交错；找回密码按账号存在性执行不同的 SMTP/查询路径，存在探测面。 | `src/db.mjs:1672` 锁内比对预期哈希；`server.mjs` SMTP 找回先统一 202，再异步查询与固定错误事件，共用发送预算。旧校验拒绝、退出/重置与响应/故障测试通过；不承诺消除所有统计时序侧信道。 |
| R06 中，已确认线上配置风险 | 对当前 `http://dufesh.cn/api/auth/login` 发出空 POST（无凭据）仍返回308，应用旧版本没有新 TLS 提交边界。若用户实际通过 HTTP 发出密码，首次传输已泄漏，后续重定向或403无法补救。没有证据证明正常 HTTPS 浏览器会降级发送。 | `deploy/Caddyfile`、`deploy/staging/Caddyfile` 拒绝非 HTTPS/非规范主机 API 写请求；`server.mjs:264` 和小影仅接受真实 TLS 或明确可信代理的 HTTPS。新 HSTS 主域一天，不含 includeSubDomains/preload。两 Caddy 配置通过；线上目前仍一年+includeSubDomains，尚未加载修复。两域名证书/TLS1.3、主站CSP/nosniff/frame阻止与私有no-store已验证；CDN/跨机回源/防火墙完整验证未完成。 |
| R07 高，已确认允许 HTTP；实际线上请求链尚未抓取 | 生产 `AUTH_ACADEMIC_IMPORT_ENABLED=true`；`src/academic-access.mjs:13` 默认 `http://zhjw-dufe-edu-cn.vpn.dufe.edu.cn:8118`，目标白名单允许映射 WebVPN HTTP。必要的协议密码加密不能保护 HTTP Cookie/令牌。 | **未解决外部 TLS 问题**。固定目标和重定向白名单保留，没有关闭证书校验。需要学校支持的 HTTPS/安全授权端点，或明确风险决策；没有擅自禁用原有导入。仅模拟学校接口，未使用真实账号验证、未探测学校服务。 |
| R08 高，已确认 | 原自制 CookieJar 忽略 Domain/Path/Secure/有效期，将全部 Cookie 转发给不同允许目标；可能跨域泄漏会话或串流程。 | 新 `src/academic-cookie-jar.mjs` 使用 tough-cookie，`:21` 单独限制厂商 TWFID 会话域；`academic-access.mjs` 每流程独立 CookieJar，按每个请求 URL 选择 Cookie。跨域、路径、Secure、过期、恶意 Cookie 与完整学校模拟流程测试通过。真实学校兼容未验证。 |
| R09 中，已确认 | 原待验证教务流程仅在后续请求清理，空闲时可能无限期持有密码；数量未设上限。不同临时客户端可能累计攻击同一学校账号。 | `academic-access.mjs:2478` 起限制 100 个/最长 5 分钟，同主体新流程销毁旧流程，定时清理密码/Cookie/SSO/部分快照，关闭清理；共享学校账号限流见 R02。限额/替换/过期/关闭测试通过；内存回收并非可证明的字节擦除，生产资源压力待隔离验证。 |
| R10 高，依赖告警已确认；运行时可利用性未确认 | 主站生产 audit 原始输出仍6 high（同一braces依赖链多节点，不是六个独立漏洞）；原全量审计15项，续修后8 high全部属于该链。braces官方仍无补丁，直接换vinext大版本未经本次兼容验证。 | 兼容升级Next/ESLint配套16.3.8、fast-uri3.1.8、Undici7.30.0、ws8.21.0及锁文件，消除相应可修补告警。保留原有构建链例外/运行时裁剪，截止2026-11-04，不扩展豁免。现有production门禁通过，Linux镜像裁剪本轮未执行；auth/小影production audit各0。 |
| R11 低/疑似 | 目录扫描3匹配：两服务端manifest prerenderSecret和合成API值。完整Git历史355提交扫描2匹配：`af1f88b0074818409d9718fb6c80b98119aaf44e` 的 `tests/academic-access.test.mjs:67` 学校滑块challenge，及 `f9469b55ab00c7c2167a79d71fb89d4f735858a3` 的 `tests/xiaoying-executor.test.mjs:383` 合成API值。 | manifest由vinext随机生成，仅server；客户端复扫0。API值明确synthetic。学校历史challenge的真实性/有效性仍未知，没有使用它请求学校。未输出完整值/重写历史；若确认为真实授权信息须失效/轮换与调查，不只删除文件。 |
| R12 高，已确认代码边界缺失；线上利用未确认 | 旧 fetch只验证URL域名/端口，连接时未检查解析IP；上游响应或DNS被操控时可访问私网/元数据。307/308允许把学校登录请求体转发至另一允许域名；模拟接口复现旧重放边界失败，未对真实系统攻击。 | 新 `services/auth-api/src/academic-transport.mjs:19` 用连接层lookup固定已校验IP，拒绝私网/回环/link-local/CGNAT/特殊和混合DNS答案，字面IP同样检查；`:33` 使用成熟Undici专用Agent、证书校验及有界连接。`academic-access.mjs:339` 拒绝跨origin请求体重放，保留CAS302转GET；`:325` 取消重定向响应体释放连接。DNS再绑定/元数据/真实回环HTTP阻断及43项学校模拟兼容通过；学校实际端点的线上兼容仍需验证。 |

## 已满足并保留的要求

- 网站密码用成熟 Argon2id 和随机盐，既有参数符合 [OWASP 密码存储最低配置](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。15 字符新密码基线参考 [OWASP 认证](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)，不把注册邮箱验证称为登录 MFA。没有发现需进行明文密码迁移的证据。
- 现有 Cookie 会话、生产 Secure/HttpOnly/SameSite、来源/CSRF 校验、数据库会话撤销、管理员 MFA 与角色检查保留；不改成 JWT。响应字段显式列举，参数化 SQL。跨用户个人资料、课表同步、考试/导入归属及普通用户直调管理员接口的测试保留并执行。完整浏览器用两个以上合成账号及管理员覆盖原有路径。
- 评价/社区/昵称以 React 文本输出，既有受控文件/图片上传、资料下载授权、路径边界、服务端页面 CSP/nonce/脚本哈希、安全响应头保留。没有为了审计启用任意 HTML 或 SVG 同源执行。自动填充和粘贴能力保留。
- 前端 API 为同源路径，私有 API no-store；没有新增密码、学校凭据、SMTP 密钥或正式令牌的 localStorage/sessionStorage 保存。个人课表离线数据保留。Cookie 库遵循域、路径、Secure 和有效期，依据 [tough-cookie 官方文档](https://github.com/salesforce/tough-cookie)。
- 学校目标白名单、重定向检查、响应大小/超时及每用户流程隔离保留；没有任意 URL 代理。新增连接层IP检查与DNS再绑定模拟测试，避免“预解析检查后再次解析”竞态，依据 [Node DNS lookup](https://nodejs.org/api/dns.html) 与 [Undici Client连接选项](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md)。学校实际端点的在线解析和TLS兼容仍未验证。

## 注册实现与故障边界

`REGISTRATION_POLICY` 集中定义：CSPRNG 6 位数字、5 分钟、60 秒重发、单码最多 5 次失败、邮箱累计尝试窗口 1 小时、邮件每邮箱每小时 5/每日 10、全局每小时 100/每日 500、2 个发信租约、60 秒租约、最多 5000 挑战。SMTP 超时有界且重试 0，无无限等待队列；过期挑战不可激活。数字码使用独立 HMAC 密钥绑定 challengeId/规范邮箱/用途；同浏览器 HttpOnly 证明防止他人预注册抢绑定。

邮箱采用 validator 解析，既有 NFKC/trim/大小写比较策略用于登录/注册/重置/邮箱修改和额度，不删除点号或加号后缀；数据库唯一约束保持一致。重发旧码失效，不重置邮箱级尝试。新建账号、验证码消费、设备及会话在 PostgreSQL 同一事务内，唯一冲突/数据库错误回滚。SMTP 位于数据库事务外：只有发送成功并成功写入 delivered_at 的挑战可用；发信失败、进程崩溃、状态更新失败均失败关闭，即使邮件已收到也不能误激活。外部 SMTP 不能与数据库组成原子事务，此边界已明确。

共享数据库预算还用于已有找回/邮箱验证发信；未添加开放邮件接口。调用者不能指定发件人、内容、链接、附件或收件人数组。启动/定时过期清理与容量上限约束数据增长。生产缺 HMAC/SMTP 或 registration mode 未开启时失败关闭，没有万能码/返回码/自动跳过验证。测试邮箱服务仅在 NODE_ENV=test、回环、合成数据库/收件人约束下启动，不进入生产入口。

统一验证码发送文案、固定注册失败结果、找回统一 202 减少账号枚举。没有人工验证码布尔绕过。SMTP 失败记录固定事件，不输出地址、验证码、错误对象或凭据；报警接收渠道仍需运维配置，不能把 stderr 当成已验证的告警系统。

## 服务器配置预检的真实结果

仅生产 `/srv/apps/dufesh/shared/config/auth.env` 保存配置，0600。SMTP 固定 QQ 465/隐式 TLS、2016594477@qq.com 发件人/用户；密码已存在，未读出或复制到本地。用户确认聊天中出现的旧码已撤销并重新生成。

既有 HMAC 值长度至少32、与AUTH_TOKEN_PEPPER不同，保留原值；生成熵来源未验证。已新增 `AUTH_TRUSTED_PROXY_CIDRS=172.18.0.6/32`，备份 `/srv/apps/dufesh/shared/config/auth.env.backup-20261011T132343Z`。匿名健康请求后，只读观察auth TCP连接及TIME_WAIT元数据，确认实际代理peer为172.18.0.6；另有容器健康检查127.0.0.1。早期仅查ESTABLISHED没捕获，不再将当前peer列为未知。web重建后地址可能变，不能套用staging或扩大信任整网段。

服务器上 SMTP_SSL 使用系统证书/主机名校验，认证通过，TLS 1.3，**发送邮件 0 封**。此结果只证明可连接并登录，未验证真实投递/垃圾箱/收件时间。

运行中的 auth 容器没有加载 SMTP 密码和注册 HMAC；旧代码尚不支持新的注册门禁，不能因为保存配置就宣称已安全启用或关闭注册。没有调用重启、重建、发布或 reload；staging 未修改。

检查期间额外 Node 只读探针退出 137，随后观察到 auth RestartCount=1，已恢复 healthy；是否由该探针触发无法确认，OOMKilled=false，未查得足够事件证据。没有隐藏此事件，也不声称容器从未重启。之后停止额外 Node 探针，只用宿主 Python 和受限元数据检查，最终重启计数仍 1。

Docker 映射显示 auth 3100/PostgreSQL 5432 未发布宿主端口，仅网关 80/443 发布。未做公网端口扫描，也未核对阿里云安全组/宿主防火墙/CDN。同机 Docker 网络的内部 HTTP 不直接定性为公网明文泄漏；不可信跨机回源应 TLS。

终验生产 app/auth 镜像仍为9de3008基线，均healthy，重启计数分别0/1，没有新增重启。显式rejectUnauthorized=true、TLS最低1.2检查两域名均证书授权通过/TLS1.3。主域200、www及普通HTTP页面308到HTTPS；主站有nonce CSP、nosniff、DENY，匿名GET会话200且no-store/private。HTTP登录空POST308为已确认未上线问题；所有线上探针无密码、Cookie会话、验证码或学校凭据，没有登录或发信。

## 已执行检查与结果

均在本分支执行；邮箱及学校使用模拟服务，数据库为 localhost 专用合成库。日志留在工作树本地，不加入 Git。

| 命令/检查 | 最终真实结果 |
| --- | --- |
| `node --test services/auth-api/test/*.test.mjs`（或在服务目录 `node --test test/*.test.mjs`） | 128/128通过。 |
| `node --test --test-concurrency=2 tests/*.test.mjs tests/personal-storage.test.ts tests/personal-sync.test.ts` | 407通过，0失败，7条件跳过，共414；跳过不算通过。 |
| `node --test tests/academic-access.test.mjs services/auth-api/test/academic-transport.test.mjs` | 学校模拟43、连接保护3，共46/46通过；包含最终重定向响应体取消和字面IP检查。 |
| `POSTGRES_INTEGRATION=true node --test tests/postgres-runtime-integration.test.mjs tests/postgres-product-extensions.test.mjs` | 原生PostgreSQL17.10非owner运行/导入/只读备份/迁移角色、PUBLIC隔离及真实HTTP/业务升级等12/12通过，既有migration runner真实执行并验证重复运行。全部合成数据。 |
| `node --test tests/registration-security.test.mjs` | PGlite 14 通过/1 原生并发条件跳过；独立 PostgreSQL 17.10 同套测试 15/15 通过，含并发/replay/跨邮箱用途/限流/存储故障/日志。完整应用 28 条迁移，保留合成历史用户。 |
| `CI=1 npx playwright test --project=registration-security` | 桌面 1280/手机 390 两项通过，真实注册界面配模拟邮件。 |
| `CI=1 npx playwright test --config playwright.production-security.config.ts` | 原生 PostgreSQL 支撑的多账号/管理员 MFA/个人资料/资料/评价/社区关键链 1/1 通过。 |
| `npm run typecheck`、`npm run build` | 通过。 |
| 本分支 Windows Node 顺序执行 8 次 Argon2id hash+verify | 全部校验通过，中位41ms，最大52ms；不代表生产Linux容器性能。 |
| 对变更源码/测试的 ESLint | 0 错误，3 条现有导航警告；后续新增变更检查也通过。 |
| auth-api、小影 `npm audit --omit=dev --omit=optional` | 各 0 漏洞。 |
| 根 `npm run audit:production`、`npm audit --json` | 现有例外门禁通过；原始production仍6 high，全量由15降至8 high（全部braces链，moderate0）；不称为零漏洞。 |
| Caddy 2.10 二进制 `validate --config ... --adapter caddyfile` | production/staging 均有效；提示部分 header_up 冗余，仍显式覆盖输入。 |
| Gitleaks `dir . --redact` | 退出 1，3 匹配，见 R11；未忽略或当作全绿。 |
| Gitleaks `dir dist/client --redact` | 退出 0，未发现匹配；不是所有可能秘密的数学证明。 |
| Gitleaks `git . --log-opts='9de3008cf8411dd0012e499b1590117d42eac2c7..HEAD' --redact` | 本次代码提交508a115扫描通过，退出0、未发现匹配；不包含生产基线之前的完整历史。 |
| Gitleaks `git . --redact`（完整历史） | 355提交，退出1、2匹配，见R11；未隐藏。客户端最新构建复扫退出0。 |
| 工作流YAML用js-yaml解析、23个run块用Git Bash `bash -n`静态检查 | 通过；不等于GitHub Actions实际运行。 |
| 本地只读备份角色 `pg_dump --format custom`，全新隔离库 `pg_restore --no-owner --no-acl --exit-on-error` | 恢复通过；61张表行数和28条迁移version/checksum一致。恢复库ACL不由行数检查证明；另由上方非owner角色套件验证授权。未用生产数据。 |
| 线上无凭据HEAD/GET、显式证书TLS检查、HTTP空POST、TCP元数据 | 两域TLS1.3/证书通过；页面/私有缓存头通过；HTTP登录POST308风险确认；真实代理peer172.18.0.6已观察。 |
| `git diff --check` | 通过；Windows LF/CRLF 提示不是空白错误。 |
| 线上受限只读元数据 + SMTP 登录 | 配置/网络/版本/迁移/有效日志设置已核实，SMTP TLS/登录通过，邮件 0 封。 |

修复/重跑前真实失败：并行安装未完成造成 PGlite 模块缺失；首轮根测试在未构建 dist 和旧代理断言下失败；验证码浏览器测试需先打开登录面板；原生 PG 首选端口被 Windows 保留；完整浏览器 MFA 合成 key 格式错误及邮箱 label 歧义。修正安装顺序、测试合同/fixture、构建和空闲回环端口后取得上表结果。曾有临时组合启动/停止脚本被自动审批拒绝，未执行，改为 Playwright 管理自有测试服务完成验证；没有终止占用旧端口的无关用户进程。

续修失败与修正：新增跨域307/308测试先复现重放边界失败，DNS测试在保护模块尚未实现时失败，修复后46项通过。真实角色测试先发现旧断言误认为只读备份不能读取新表、把新已验证账号当成未验证账号；按原备份职责增加读取/写入拒绝断言，并单独创建合成旧账号验证流程，不改生产授权。MSYS子进程迁移路径改为正斜杠后升级通过；固定限流测试摘要造成重复运行已耗尽，改为每次运行随机合成摘要并保留同次并发/重启持久性断言。早期本地PG重启遗漏55439端口造成连接拒绝，指定原独立回环端口后恢复，未连接或修改生产库。最初YAML检查缺yaml模块，使用现有js-yaml后23个shell块通过。最终检查如上，失败未被当作通过。

**未运行/未验证**：本提交GitHub CI、CodeQL、Linux Docker镜像/裁剪、隔离staging/生产备份恢复/实际二进制回滚、生产Argon资源压力、真实邮件投递、微信内置浏览器/第三方回调、CDN/跨机回源/阿里云安全组/防火墙完整核查、真实学校TLS/授权、告警接收、历史生产日志/备份及历史学校challenge真实性。真实PostgreSQL角色ACL、本地合成备份恢复、公开HTTPS/证书/缓存与当前代理peer已验证，不再列为全未验证。已增加CI用例不等于CI已通过。

本地原生PG复跑：PGHOST=127.0.0.1、PGPORT=55439、POSTGRES_USER=dufesh_security_owner、合成库 `dufesh_production_security_test`；SECURITY_POSTGRES_TEST=true注册测试要求独立空库并自行应用0001–0028，已运行库须换符合名称限制的空库，不能覆盖。完整浏览器 `dufesh_production_ci` 先应用0001–0028，端口33137/33138/33139，配置只含合成凭据。续修真实角色库 `dufesh_continuation_acl_ci` 使用独立schema/migrator/runtime/import/backup角色、既有shell迁移入口及PostgreSQL17.10官方Windows客户端，备份恢复至全新 `dufesh_continuation_restore_ci`。角色测试实际用非owner请求，区别于前期owner浏览器fixture；不替代Linux镜像验证。临时客户端来源为 [PostgreSQL官方Windows二进制下载入口](https://www.postgresql.org/download/windows/)，未安装系统服务/WSL/Docker。专用PG已正常停止，测试端口释放；合成数据、dump与本地日志未提交，不包含生产数据。

## 不能在当前边界内完成的事项（统一清单）

| 事项 | 当前证据/原因 | 完成条件 |
| --- | --- | --- |
| 学校HTTP回源，高风险R07 | 固定默认和允许协议已确认；没有真实教务账号/学校支持的安全端点兼容证据，改协议可能破坏导入 | 学校提供HTTPS/官方授权方案，受控账号逐步验证完整VPN/SSO/导入；不把RSA/AES或HTTP重定向当TLS |
| 无上游补丁的braces链R10 | [官方公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)仍无补丁；raw生产6/full8，兼容补丁已全部修复可修项 | Linux运行镜像验证裁剪；2026-11-04前处理已有例外，未来兼容升级独立回归，不强制降级/换栈 |
| GitHub CI/CodeQL/Linux镜像 | 仓库PUBLIC，本分支含仍未上线漏洞细节；本轮不提前公开推送。本机无Docker/可用WSL，23个run块静态通过 | 明确公开发布时机或提供私有CI渠道后跑完整提交；本地真实PG12项不冒称LinuxCI已通过 |
| 生产修复生效与邮件投递 | 代码/0028/Caddy/PG日志尚未发布，运行容器仍旧；SMTP仅TLS认证通过、零邮件 | 按下方备份/迁移/协同发布/单封站长邮箱验收后启用注册。用户先前仅保存配置边界仍有效 |
| 历史学校challenge与历史敏感数据 | Git历史发现一处疑似值；未确认其真实性，未读取生产用户日志/备份 | 不提供完整值；有来源证据后确认失效/轮换与影响范围，必要时另行事故处置，禁止无依据撤销全部会话 |
| 上线环境验收 | 未核实安全组/防火墙/CDN/跨机回源、128MiB容器新依赖+Argon资源、真实微信回调和报警接收 | 运维与受控验证环境逐项确认；当前TLS证书/安全头/无公开auth/DB端口映射/真实peer结果保留 |

## 人工配置、上线顺序与兼容迁移

当前没有需要在聊天提供的秘密。SMTP 授权码已经在服务器保存。AUTH_REGISTRATION_HMAC_KEY 应来自 CSPRNG（至少 32 随机字节编码），与 AUTH_TOKEN_PEPPER/管理员 MFA/小影密钥独立，0600 或密钥管理注入；如无法确认现有值生成来源，应在未开启新注册时于服务器单独生成，不变更现有 token pepper。SMTP 使用邮箱客户端授权码、465 隐式 TLS、证书校验开启，示例只留空占位符。

后续步骤按顺序，**涉及发布/重建/启用或数据库操作需用户单独明确授权，目前没有执行**：

1. 审阅本分支完整差异，运行 GitHub CI/Linux 镜像/角色 ACL 和 secret scan，处理剩余依赖例外到期。保留生产现场 `library.dufesh.cn`、额外 Docker 网络及图书馆网关内容，不能用仓库 Caddy/Compose 整文件覆盖现场。
2. 在独立验证环境创建受限秘密，备份并演练恢复业务数据库/配置，记录当前镜像摘要与回滚配置。不得未经授权修改当前 staging。验证新镜像 128MiB 资源/Argon2 并发及代理 peer；保持新注册 disabled。
3. 由既有 migration 入口应用追加 `0028` 并授予 auth runtime 权限、维持 importer 不可读新安全表；不得修改已应用 0021–0027 校验和。新表是追加式，历史用户/密码/邮箱状态/绑定/会话不改；不要把所有老邮箱设已验证，也不强制全员登出。老用户可继续原登录；补验证仅在未来明确过渡政策或敏感邮箱操作时要求。
4. 按审阅方案共同发布 app/auth 与 Caddy 转发头/TLS 边界、PG 日志配置。重新创建 auth 才会载入新 env，单纯 restart 不保证 env_file 更新；观测真实 peer 并将 `/32` 同步到 auth 和需要的独立小影配置。服务端门禁和网关配置必须匹配，避免因不信任合法代理破坏登录。PG 有效日志设置需 SHOW 验证。
5. 经授权只给站长自己的受控邮箱发送一封验证码，检查发件人、TLS、正文、延迟/垃圾箱；验证错误/过期/重发/重放/预算故障闭锁，不测试真实用户地址。配置固定事件告警与全局额度监控。
6. 上述通过后再明确启用 `AUTH_REGISTRATION_MODE=smtp`。找回密码/改邮箱目前 mode=disabled，不能仅改配置就认为它们完成真实投递验收；启用应分别验证。没有 SMTP/HMAC 时禁止启用，不能回退旧无验证注册。
7. 验证 https://dufesh.cn 与 www 规范跳转、HTTP API 拒绝（不能拿已有密码作 HTTP 探针）、Secure/HttpOnly/SameSite、CSP/frame-ancestors/nosniff、HSTS 1 天兼容、私有 no-store/CDN/SW、退出/重置失效、A/B 越权拒绝与普通用户管理员拒绝。使用受控新账号完成桌面/手机及需要的微信/第三方登录回归。
8. 学校 HTTP 风险需单独解决/决策，核实允许域名、端口、重定向和实际解析 IP，不把邮箱注册上线视为学校链路已经安全。若最终确认真实凭据泄漏，另行制定学校密码更换/会话失效及事件调查，不能用当前代码修复宣告事故结束。

回滚：先关闭新注册与发信，保留追加安全表/历史记录；回滚 app/auth/gateway 到精确已记录版本及配置需整体核对，不恢复会开放无验证注册的旧入口。HMAC 轮换仅使待验证挑战失效，不撤销既有会话。数据库恢复属于高风险、可能丢失期间业务数据的独立操作，需单独授权并先验证备份；不删除用户或原始资料，不自动 down 掉生产栈。密钥疑似已泄漏须失效/轮换并审查历史访问，不仅删除文件。

以上修复降低已确认风险，不承诺绝对安全。本地通过的结果和未完成的线上验收分别记录。
