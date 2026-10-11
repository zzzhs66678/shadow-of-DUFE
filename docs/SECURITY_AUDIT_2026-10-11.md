# 东财之影安全审计与修复：生产版本基线

日期：2026-10-11。状态：用户已授权按小网站规模上线可完成的防护；完整 GitHub CI 通过，生产 app/auth、追加迁移0028、Caddy与PostgreSQL日志防护已发布，邮箱验证码注册已正式开启。部署时间UTC2026-10-11T15:22:02Z（北京时间23:22），staging未修改。

当前交付包括邮箱验证码注册、共享数据库限流、可信代理、日志保护、学校 Cookie 隔离、临时凭据清理、连接时 DNS/IP 校验、跨 origin 登录请求体重放阻断和兼容依赖补丁。复用现有 PostgreSQL、SMTP 与 Caddy，未增加 Redis 或服务。学校 HTTP 回源、历史疑似凭据与剩余环境验收仍未解决，详见统一清单。

## 范围与发布基线

修复基线为生产 `9de3008cf8411dd0012e499b1590117d42eac2c7` 与数据库 0027；现已发布 app/auth `9a343d1ee081e204382cd5a30e59a4b95c4f1270`，数据库应用至 `0028_registration_security.sql`。本报告和修复位于分支 `codex/security-production-20261011`，工作目录 `C:/Users/zzz/.codex/worktrees/security-production-base/云`，从实际生产基线创建。

原目录 `C:/Users/zzz/Documents/云` 的安全审计基于较旧提交，含用户未提交的其他工作。其 `0021/0022` 编号与生产已应用迁移冲突，**不能作为发布候选直接部署**。本分支使用新增 `0028_registration_security.sql`，保留实际生产的教务导入、课表、考试、培养方案、教师评价、资料与收藏、社区时间线、纠错和管理员功能；没有复制旧本地教务原型。

读取与核查包括 CURRENT_STATE、AGENTS 约定、依赖/锁文件、认证/API/数据库迁移、测试、环境示例、Compose/Caddy/PostgreSQL 配置及线上只读元数据。实际技术栈：React/vinext、Node 认证服务、PostgreSQL 17、Caddy、Docker Compose；小影有独立 Node/SQLite 服务。没有新增 Redis 或微服务。

## 数据流与 F12 的结论

- 网站密码：浏览器表单内存 → 同源 `/api/auth/*` → Caddy → 认证服务 → 成熟库 Argon2id → PostgreSQL。API 不返回哈希；没有把密码写入浏览器持久存储的代码。F12 能查看当前浏览器提交的请求体是正常调试能力，**这本身不是网络明文泄漏证据**。HTTPS 加密的是在网络上传输的字节，不能对持有端点的浏览器隐藏密码。
- 注册邮件：仅提交邮箱 → 服务器生成验证码、预留共享数据库预算 → 固定 SMTP 模板 → 记录投递成功 → 最终注册提交 challengeId、验证码和密码 → 同一数据库事务消费证明并创建账号与会话。前端倒计时或 verified 字段不构成授权。
- 教务凭据：用户明确发起导入 → 网站认证服务的短期内存流程 → 固定允许的学校 VPN/SSO/教务目标 → 解析后的业务快照按用户存库。网站密码哈希与学校登录凭据分别处理；未新增永久保存学校密码。学校协议必要的 RSA/AES 保留。学校 HTTP 回源风险见 R07。
- 私有档案/课表/考试/收藏：服务端会话确定用户 → 参数化查询及资源归属校验 → 私有响应 no-store。保留既有个人课表离线存储，不清空用户业务数据。小影任务与学校会话仍使用既有账号/任务隔离。

## 风险清单

以下行号以发布候选代码为准；每项分别记录代码验证、生产生效及未完成的线上验证，保留已确认、疑似与外部配置的区别。

| 编号/级别/证据分类 | 触发条件、证据与影响 | 修复、文件位置与验证状态 |
| --- | --- | --- |
| R01 高，已确认并修复 | 原 register 直接创建正式账号，无邮箱证明；可抢占他人邮箱并滥用注册。现有邮箱数据库唯一索引已经存在。 | `services/auth-api/src/server.mjs:592`、`:633`，`src/db.mjs:1530`，新增 `src/registration-security.mjs` 与 `ops/postgres/migrations/0028_registration_security.sql`：邮箱/用途/挑战/申请浏览器绑定、已投递状态、原子消费。数据库增加 verified_password 必须具备验证时间的约束；已有账号不覆盖。原生PG并发/回滚、浏览器与CI通过；生产代码和迁移已生效，注册正式开启。线上缺邮箱400、伪造verified/role400、外部Origin403，手机桌面注册面板2/2通过。 |
| R02 高，已确认并修复主站边界 | 原转发头无明确可信代理边界；认证账号限流混入 IP，改变来源可分散攻击。生产新增收藏/反馈/教务路由也读取来源头。 | 新 `src/request-security.mjs`，`src/config.mjs:205`，`src/rate-limit.mjs:114` 及各路由，Caddy 覆盖来源/协议/主机头。共享数据库独立账号、IP、跨接口及全局邮件额度；学校账号摘要限流 `academic-routes.mjs:390`、`rate-limit.mjs:151`，校园共享 IP 使用较宽额度。伪造头、不同账号、共享状态测试和 CI 通过。主站/auth 已发布，实际 peer 与配置为172.18.0.6/32；小影 helper 已测试但本轮保留其旧镜像，未宣称小影内部改动生效。 |
| R03 高，已确认配置风险并修复；真实历史泄漏未确认 | 发布前 PG `log_parameter_max_length=-1`，慢查询可能记录绑定邮箱、会话摘要或密码哈希；错误 DETAIL 可包含邮箱。仅合成日志测试复现，不推断已有真实泄漏。 | `ops/postgres/postgresql.conf:29` 两项参数日志长度置 0，terse 错误及限制错误 SQL；服务错误用固定事件名。原生 PG 合成敏感参数检查通过；生产 reload 后 SHOW 确认 `log_parameter_max_length=0`、`log_parameter_max_length_on_error=0`、`log_error_verbosity=terse`、`log_min_error_statement=panic`。数据库容器未重建。历史日志/备份敏感内容审查未执行。 |
| R04 中，已确认并修复 | 原新密码长度/字符组合策略不符合本次长口令要求。原网站密码已经使用 Argon2id，未发现明文存储。 | `src/credentials.mjs:39`、`:110`：新注册/重置 15–128 Unicode 码点，无字符类别强制，不截断/改写哈希输入；旧短密码仍可登录。`src/passwords.mjs` 保留 19MiB/t2/p1，限制两个哈希操作并发；旧哈希不再次当原密码处理。边界/兼容与 CI 通过并已发布。在服务器独立128MiB候选容器中两个并发 Argon2 hash+verify 成功，耗时590ms、exit0；cgroup memory.peak 不可读，未获得峰值内存数，不等于持续负载验证。 |
| R05 中，已确认并修复代码 | 登录校验旧哈希后创建会话可能与重置交错；找回密码按账号存在性执行不同的 SMTP/查询路径，存在探测面。 | `src/db.mjs:1672` 锁内比对预期哈希；`server.mjs` SMTP 找回先统一 202，再异步查询与固定错误事件，共用发送预算。旧校验拒绝、退出/重置与响应/故障测试和 CI 通过，代码已发布。找回密码仍维持 disabled，不宣称该邮件流程已上线验收；不承诺消除所有统计时序侧信道。 |
| R06 中，已确认配置风险并修复 | 发布前 `http://dufesh.cn/api/auth/login` 空 POST（无凭据）返回308，旧应用没有新 TLS 提交边界。若用户实际通过 HTTP 发出密码，首次传输已泄漏，后续重定向或403无法补救。没有证据证明正常 HTTPS 浏览器会降级发送。 | `deploy/Caddyfile` 拒绝 HTTP/非规范主机 API 写请求；auth `server.mjs:264` 仅接受真实 TLS 或明确可信代理的 HTTPS。生产 Caddy 保留 staging/library 现场片段后已加载：HTTP API 空 POST 与 HTTPS www API POST 均403，主域health200，HSTS主域一天且不含 includeSubDomains/preload。两域证书/TLS1.3、主站CSP/nosniff/frame阻止与私有no-store已验证。staging 配置及小影内部代码本轮未发布；CDN/跨机回源/防火墙完整验证未完成。 |
| R07 高，已确认允许 HTTP；实际线上请求链尚未抓取 | 生产 `AUTH_ACADEMIC_IMPORT_ENABLED=true`；`src/academic-access.mjs:13` 默认 `http://zhjw-dufe-edu-cn.vpn.dufe.edu.cn:8118`，目标白名单允许映射 WebVPN HTTP。必要的协议密码加密不能保护 HTTP Cookie/令牌。 | **未解决外部 TLS 问题**。固定目标和重定向白名单保留，没有关闭证书校验。需要学校支持的 HTTPS/安全授权端点，或明确风险决策；没有擅自禁用原有导入。仅模拟学校接口，未使用真实账号验证、未探测学校服务。 |
| R08 高，已确认并修复代码 | 原自制 CookieJar 忽略 Domain/Path/Secure/有效期，将全部 Cookie 转发给不同允许目标；可能跨域泄漏会话或串流程。 | 新 `src/academic-cookie-jar.mjs` 使用 tough-cookie，`:21` 单独限制厂商 TWFID 会话域；`academic-access.mjs` 每流程独立 CookieJar，按每个请求 URL 选择 Cookie。跨域、路径、Secure、过期、恶意 Cookie 与完整学校模拟流程和 CI 通过，auth代码已发布。真实学校账号兼容未验证。 |
| R09 中，已确认并修复代码 | 原待验证教务流程仅在后续请求清理，空闲时可能无限期持有密码；数量未设上限。不同临时客户端可能累计攻击同一学校账号。 | `academic-access.mjs:2478` 起限制100个/最长5分钟，同主体新流程销毁旧流程，定时清理密码/Cookie/SSO/部分快照，关闭清理；共享学校账号限流见 R02。限额/替换/过期/关闭测试和 CI 通过，auth代码已发布；内存回收并非可证明的字节擦除，未使用真实学校账号做压力测试。 |
| R10 高，依赖告警已确认；运行时可利用性未确认 | 主站production依赖清单 raw audit仍6 high（同一braces依赖链多节点，不是六个独立漏洞）；原全量审计15项，续修后8 high全部属于该链。braces官方仍无补丁，直接换vinext大版本未经本次兼容验证。 | 兼容升级Next/ESLint配套16.3.8、fast-uri3.1.8、Undici7.30.0、ws8.21.0及锁文件，消除相应可修补告警。保留原有构建链例外/运行时裁剪，截止2026-11-04，不扩展豁免。CI已在Linux最终镜像验证裁剪、生产server加载与HTTP冒烟，并已发布该完整app/auth镜像；auth/候选小影production audit各0，小影镜像本轮未更换。 |
| R11 低/疑似 | 目录扫描3匹配：两服务端manifest prerenderSecret和合成API值。完整Git历史355提交扫描2匹配：`af1f88b0074818409d9718fb6c80b98119aaf44e` 的 `tests/academic-access.test.mjs:67` 学校滑块challenge，及 `f9469b55ab00c7c2167a79d71fb89d4f735858a3` 的 `tests/xiaoying-executor.test.mjs:383` 合成API值。 | manifest由vinext随机生成，仅server；客户端复扫0。API值明确synthetic。学校历史challenge的真实性/有效性仍未知，没有使用它请求学校。未输出完整值/重写历史；若确认为真实授权信息须失效/轮换与调查，不只删除文件。 |
| R12 高，已确认代码边界缺失并修复；线上利用未确认 | 旧 fetch只验证URL域名/端口，连接时未检查解析IP；上游响应或DNS被操控时可访问私网/元数据。307/308允许把学校登录请求体转发至另一允许域名；模拟接口复现旧重放边界失败，未对真实系统攻击。 | 新 `services/auth-api/src/academic-transport.mjs:19` 用连接层lookup固定已校验IP，拒绝私网/回环/link-local/CGNAT/特殊和混合DNS答案，字面IP同样检查；`:33` 使用成熟Undici专用Agent、证书校验及有界连接。`academic-access.mjs:339` 拒绝跨origin请求体重放，保留CAS302转GET；`:325` 取消重定向响应体释放连接。DNS再绑定/元数据/真实回环HTTP阻断及43项学校模拟和 CI 通过，代码已发布。服务器宿主解析两固定域名仅得到202.199.175.250与2001:da8:9007:1175::250；这是DNS兼容证据，不证明真实学校账号/TLS链路正常。 |

## 已满足并保留的要求

- 网站密码用成熟 Argon2id 和随机盐，既有参数符合 [OWASP 密码存储最低配置](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。15 字符新密码基线参考 [OWASP 认证](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)，不把注册邮箱验证称为登录 MFA。没有发现需进行明文密码迁移的证据。
- 现有 Cookie 会话、生产 Secure/HttpOnly/SameSite、来源/CSRF 校验、数据库会话撤销、管理员 MFA 与角色检查保留；不改成 JWT。响应字段显式列举，参数化 SQL。跨用户个人资料、课表同步、考试/导入归属及普通用户直调管理员接口的测试保留并执行。完整浏览器用两个以上合成账号及管理员覆盖原有路径。
- 评价/社区/昵称以 React 文本输出，既有受控文件/图片上传、资料下载授权、路径边界、服务端页面 CSP/nonce/脚本哈希、安全响应头保留。没有为了审计启用任意 HTML 或 SVG 同源执行。自动填充和粘贴能力保留。
- 前端 API 为同源路径，私有 API no-store；没有新增密码、学校凭据、SMTP 密钥或正式令牌的 localStorage/sessionStorage 保存。个人课表离线数据保留。Cookie 库遵循域、路径、Secure 和有效期，依据 [tough-cookie 官方文档](https://github.com/salesforce/tough-cookie)。
- 学校目标白名单、重定向检查、响应大小/超时及每用户流程隔离保留；没有任意 URL 代理。新增连接层IP检查与DNS再绑定模拟测试，避免“预解析检查后再次解析”竞态，依据 [Node DNS lookup](https://nodejs.org/api/dns.html) 与 [Undici Client连接选项](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md)。服务器宿主DNS解析已确认只得到学校公网IPv4/IPv6，真实账号导入和TLS兼容仍未验证。

## 注册实现与故障边界

`REGISTRATION_POLICY` 集中定义：CSPRNG 6 位数字、5 分钟、60 秒重发、单码最多 5 次失败、邮箱累计尝试窗口 1 小时、邮件每邮箱每小时 5/每日 10、全局每小时 100/每日 500、2 个发信租约、60 秒租约、最多 5000 挑战。SMTP 超时有界且重试 0，无无限等待队列；过期挑战不可激活。数字码使用独立 HMAC 密钥绑定 challengeId/规范邮箱/用途；同浏览器 HttpOnly 证明防止他人预注册抢绑定。

邮箱采用 validator 解析，既有 NFKC/trim/大小写比较策略用于登录/注册/重置/邮箱修改和额度，不删除点号或加号后缀；数据库唯一约束保持一致。重发旧码失效，不重置邮箱级尝试。新建账号、验证码消费、设备及会话在 PostgreSQL 同一事务内，唯一冲突/数据库错误回滚。SMTP 位于数据库事务外：只有发送成功并成功写入 delivered_at 的挑战可用；发信失败、进程崩溃、状态更新失败均失败关闭，即使邮件已收到也不能误激活。外部 SMTP 不能与数据库组成原子事务，此边界已明确。

共享数据库预算还用于已有找回/邮箱验证发信；未添加开放邮件接口。调用者不能指定发件人、内容、链接、附件或收件人数组。启动/定时过期清理与容量上限约束数据增长。生产缺 HMAC/SMTP 或 registration mode 未开启时失败关闭，没有万能码/返回码/自动跳过验证。测试邮箱服务仅在 NODE_ENV=test、回环、合成数据库/收件人约束下启动，不进入生产入口。

统一验证码发送文案、固定注册失败结果、找回统一 202 减少账号枚举。没有人工验证码布尔绕过。SMTP 失败记录固定事件，不输出地址、验证码、错误对象或凭据；报警接收渠道仍需运维配置，不能把 stderr 当成已验证的告警系统。

## 生产发布与配置的真实结果

用户最终授权“需要补充资料的先跳过，把能部署的防范先做了”，本轮按现有小站架构发布，不新增基础设施。仅生产 `/srv/apps/dufesh/shared/config/auth.env` 保存配置，0600。SMTP 固定 QQ 465/隐式 TLS、2016594477@qq.com 发件人/用户；真实授权码未读出或复制到本地。用户确认聊天中出现的旧码已撤销并重新生成。

既有 HMAC 值长度至少32、与AUTH_TOKEN_PEPPER不同，保留原值；生成熵来源未验证。已新增 `AUTH_TRUSTED_PROXY_CIDRS=172.18.0.6/32`，备份 `/srv/apps/dufesh/shared/config/auth.env.backup-20261011T132343Z`。匿名健康请求后，只读观察auth TCP连接及TIME_WAIT元数据，确认实际代理peer为172.18.0.6；另有容器健康检查127.0.0.1。早期仅查ESTABLISHED没捕获，不再将当前peer列为未知。web重建后地址可能变，不能套用staging或扩大信任整网段。

早期 SMTP_SSL 预检使用系统证书/主机名校验，认证通过、TLS1.3且零封发信。此次发布前用候选库与固定注册模板，仅向站长自己的2016594477@qq.com发送 **1封** 验证邮件，SMTP服务器接受；没有给真实用户批量发信。收件箱、垃圾箱、收件时间和用户可读正文仍未验证，SMTP接受不等同于最终投递。

完整 GitHub quality [run38150051738](https://github.com/zzzhs66678/shadow-of-DUFE/actions/runs/38150051738) 的5项任务全部success，包括verify、PostgreSQL17、Linux生产镜像、CodeQL和全历史secret-scan任务。发布代码 `9a343d1ee081e204382cd5a30e59a4b95c4f1270` 的完整app/auth镜像已校验SHA-256、镜像ID与non-root运行用户；服务器没有重新编译安装依赖。CI secret-scan通过与本地手动全历史扫描2匹配分别记录，不以CI结果抹除R11疑似值。

生产发布前备份 `/srv/apps/dufesh/shared/backups/security-20261011T151027Z/before-security.dump`，在自建临时库恢复通过：27迁移、58表、0无效约束；临时库已删除，没有覆盖生产库。0028通过既有runner应用，前27条已应用迁移的校验和匹配。迁移仅追加安全表/约束及授权，未删除用户、改写旧密码、批量验证旧邮箱或撤销所有会话。

发布后同目录 `after-security.dump` 已由只读备份角色生成，摘要及归档目录校验通过；再次在自建临时库隔离恢复，通过28迁移、61表、0无效约束及三张新安全表检查，临时库已删除。dump、配置和日志留在服务器0700目录，不下载用户数据、不提交备份。该恢复检查不代表已恢复角色ACL；新表runtime、importer隔离及backup只读另做线上权限检查。

app/auth已更新到候选提交，健康检查通过、各RestartCount=0且OOMKilled=false。新auth载入SMTP和独立注册HMAC，`AUTH_REGISTRATION_MODE=smtp`，最终检查后已解除临时Caddy注册关闸并记录release至current。可信peer保持172.18.0.6/32。生产小影、PostgreSQL、web容器未重建，其他服务镜像保留核对为true，staging未修改；Caddy只修改必要的生产段并保留现场staging/library配置。

PostgreSQL配置reload后四项SHOW为0、0、terse、panic，与R03一致。生产HTTP API空POST及HTTPS www API POST返回403，主域health200；HSTS主域一天。不能因HTTP拒绝而认为已发出的HTTP密码可以补救。

在服务器独立128MiB候选容器执行两个并发Argon2 hash+verify，成功590ms、exit0。cgroup memory.peak不可读，结果为null；未测得峰值内存，也没有对真实用户或生产账号进行压力测试。

前期旧容器检查期间额外Node只读探针退出137，随后观察到旧auth RestartCount=1并恢复healthy；是否由该探针触发无法确认，OOMKilled=false，未查得足够事件证据。随后停止额外Node探针。此次新auth容器计数为0，不能据此抹除旧容器曾重启的记录。

Docker 映射显示 auth 3100/PostgreSQL 5432 未发布宿主端口，仅网关 80/443 发布。未做公网端口扫描，也未核对阿里云安全组/宿主防火墙/CDN。同机 Docker 网络的内部 HTTP 不直接定性为公网明文泄漏；不可信跨机回源应 TLS。

发布前显式rejectUnauthorized=true、TLS最低1.2检查两域均证书授权通过/TLS1.3。主域200、www及普通HTTP页面规范跳转，主站有nonce CSP、nosniff、DENY，匿名GET会话200且no-store/private；此次发布后HTTP及www API写入拒绝已从308修复为403。网络探针不携带真实密码、用户Cookie、学校凭据或真实用户邮箱。

注册正式开放后的最小失败关闭检查：challenge缺邮箱返回400 `invalid_registration_email`；携带伪造 `emailVerified`/`role` 的合成注册返回400 `invalid_registration_verification`；foreignOrigin返回403；未登录devices/bookmarks返回401。生产只读Playwright以1280/390宽度检查注册面板2/2通过：验证码/发码按钮、15–128字符提示与new-password自动填充正常，无横向溢出，console/page/HTTP错误均0，API写请求0。该只读检查不等同于在生产创建真实新账号或验证邮件最终收件。

## 已执行检查与结果

本地和CI自动化测试使用模拟邮件/学校接口与专用合成数据库；生产验证另行明确列出，只有站长本人邮箱单封发信。日志不加入Git，不输出秘密或验证码。

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
| ECS独立候选Linux容器，128MiB限制，两个并发Argon2 hash+verify | 成功590ms、exit0；memory.peak不可读/null，未获得峰值内存数；不等于持续生产负载验证。 |
| 对变更源码/测试的 ESLint | 0 错误，3 条现有导航警告；后续新增变更检查也通过。 |
| auth-api、小影 `npm audit --omit=dev --omit=optional` | 各 0 漏洞。 |
| 根 `npm run audit:production`、`npm audit --json` | 现有例外门禁通过；原始production仍6 high，全量由15降至8 high（全部braces链，moderate0）；不称为零漏洞。 |
| Caddy 2.10 二进制 `validate --config ... --adapter caddyfile` | production/staging 均有效；提示部分 header_up 冗余，仍显式覆盖输入。 |
| Gitleaks `dir . --redact` | 退出 1，3 匹配，见 R11；未忽略或当作全绿。 |
| Gitleaks `dir dist/client --redact` | 退出 0，未发现匹配；不是所有可能秘密的数学证明。 |
| Gitleaks `git . --log-opts='9de3008cf8411dd0012e499b1590117d42eac2c7..HEAD' --redact` | 本次代码提交508a115扫描通过，退出0、未发现匹配；不包含生产基线之前的完整历史。 |
| Gitleaks `git . --redact`（完整历史） | 355提交，退出1、2匹配，见R11；未隐藏。客户端最新构建复扫退出0。 |
| 工作流YAML用js-yaml解析、23个run块用Git Bash `bash -n`静态检查 | 通过；静态检查与下方实际CI结果分别记录。 |
| GitHub quality [38150051738](https://github.com/zzzhs66678/shadow-of-DUFE/actions/runs/38150051738)，提交9a343d1ee081e204382cd5a30e59a4b95c4f1270 | 全部5项任务success，包括真实PG17/浏览器、Linux完整镜像裁剪及启动、CodeQL、secret-scan。与本地手动全历史Gitleaks2匹配分别记录。 |
| CI完整app/auth镜像的工件摘要、镜像ID与运行用户校验 | 通过；使用完整镜像发布，non-root，未在ECS现场重新编译。 |
| 本地只读备份角色 `pg_dump --format custom`，全新隔离库 `pg_restore --no-owner --no-acl --exit-on-error` | 恢复通过；61张表行数和28条迁移version/checksum一致。恢复库ACL不由行数检查证明；另由上方非owner角色套件验证授权。未用生产数据。 |
| 生产before-security.dump备份及自建临时库隔离恢复 | 通过：27迁移、58表、0无效约束，临时库已删除；未覆盖生产库，不将该检查当作恢复ACL证明。 |
| 生产after-security.dump备份及自建临时库隔离恢复 | 通过：28迁移、61表、0无效约束及新安全表存在；临时库已删除，未覆盖生产库。 |
| 生产既有migration runner应用0028 | 成功；前27迁移校验和匹配，历史用户/密码/邮箱状态与会话保留。 |
| PostgreSQL日志配置reload及SHOW | 通过：0/0/terse/panic，PostgreSQL容器未重建。 |
| 线上无凭据HEAD/GET、显式证书TLS检查、HTTP空POST、TCP元数据 | 两域TLS1.3/证书与页面/私有缓存头通过；发布后HTTP API及HTTPS www API POST403、主域health200、HSTS主域一天，真实代理peer172.18.0.6。 |
| 发布后生产app/auth健康与元数据 | healthy、RestartCount=0、OOMKilled=false；注册mode=smtp且已正式开放，其他服务镜像保留为true，staging未改。 |
| 注册与匿名权限的生产最小失败关闭探针 | 缺邮箱400 invalid_registration_email；伪造emailVerified/role的合成注册400 invalid_registration_verification；foreignOrigin403；未登录devices/bookmarks401。 |
| 生产只读Playwright注册面板1280/390 | 2/2通过：验证码/发码按钮、15–128提示与new-password正常，无溢出，console/page/HTTP错误0，API写请求0；未创建真实账号或检查最终邮件收件。 |
| `git diff --check` | 通过；Windows LF/CRLF 提示不是空白错误。 |
| 服务器SMTP TLS/认证及候选库固定注册模板发信 | TLS/认证通过；仅给站长本人邮箱单发1封，SMTP接受，未验证收件箱/垃圾箱或延迟。 |
| 学校两固定域名宿主DNS解析 | 只得到202.199.175.250与2001:da8:9007:1175::250；未使用真实账号、未证明HTTP回源安全。 |

修复/重跑前真实失败：并行安装未完成造成 PGlite 模块缺失；首轮根测试在未构建 dist 和旧代理断言下失败；验证码浏览器测试需先打开登录面板；原生 PG 首选端口被 Windows 保留；完整浏览器 MFA 合成 key 格式错误及邮箱 label 歧义。修正安装顺序、测试合同/fixture、构建和空闲回环端口后取得上表结果。曾有临时组合启动/停止脚本被自动审批拒绝，未执行，改为 Playwright 管理自有测试服务完成验证；没有终止占用旧端口的无关用户进程。

续修失败与修正：新增跨域307/308测试先复现重放边界失败，DNS测试在保护模块尚未实现时失败，修复后46项通过。真实角色测试先发现旧断言误认为只读备份不能读取新表、把新已验证账号当成未验证账号；按原备份职责增加读取/写入拒绝断言，并单独创建合成旧账号验证流程，不改生产授权。MSYS子进程迁移路径改为正斜杠后升级通过；固定限流测试摘要造成重复运行已耗尽，改为每次运行随机合成摘要并保留同次并发/重启持久性断言。早期本地PG重启遗漏55439端口造成连接拒绝，指定原独立回环端口后恢复，未连接或修改生产库。最初YAML检查缺yaml模块，使用现有js-yaml后23个shell块通过。最终检查如上，失败未被当作通过。

**未运行/未验证**：修改既有staging、实际旧镜像回滚再前滚、持续生产负载及峰值内存、真实邮件收件箱/垃圾箱和延迟、微信内置浏览器/第三方回调、CDN/跨机回源/阿里云安全组/防火墙完整核查、真实学校账号/TLS/授权、报警接收、历史生产日志/备份敏感内容及学校challenge真实性。GitHub CI、CodeQL、Linux镜像/裁剪、真实PG角色ACL、生产备份隔离恢复、服务器128MiB短测、SMTP接受、当前代理peer及公开HTTPS/安全头已取得上表证据，不再列为全未验证。

本地原生PG复跑：PGHOST=127.0.0.1、PGPORT=55439、POSTGRES_USER=dufesh_security_owner、合成库 `dufesh_production_security_test`；SECURITY_POSTGRES_TEST=true注册测试要求独立空库并自行应用0001–0028，已运行库须换符合名称限制的空库，不能覆盖。完整浏览器 `dufesh_production_ci` 先应用0001–0028，端口33137/33138/33139，配置只含合成凭据。续修真实角色库 `dufesh_continuation_acl_ci` 使用独立schema/migrator/runtime/import/backup角色、既有shell迁移入口及PostgreSQL17.10官方Windows客户端，备份恢复至全新 `dufesh_continuation_restore_ci`。角色测试实际用非owner请求，区别于前期owner浏览器fixture；不替代Linux镜像验证。临时客户端来源为 [PostgreSQL官方Windows二进制下载入口](https://www.postgresql.org/download/windows/)，未安装系统服务/WSL/Docker。专用PG已正常停止，测试端口释放；合成数据、dump与本地日志未提交，不包含生产数据。

## 尚未解决或需要后续验收的事项（统一清单）

| 事项 | 当前证据/原因 | 完成条件 |
| --- | --- | --- |
| 学校HTTP回源，高风险R07 | 固定默认和允许协议已确认；宿主DNS均得到学校公网地址，但没有真实账号/学校HTTPS兼容证据，改协议可能破坏原导入 | 学校提供HTTPS/官方授权方案，受控账号逐步验证完整VPN/SSO/导入；不把RSA/AES或HTTP重定向当TLS |
| 无上游补丁的braces链R10 | [官方公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)仍无补丁；依赖清单raw生产6/full8，Linux最终镜像裁剪及真实启动已通过 | 2026-11-04前处理已有有期限例外，未来兼容升级独立回归；不强制降级/换栈，也不因裁剪将清单告警称为零 |
| 历史学校challenge与历史敏感数据 | 手动完整Git历史扫描一处学校challenge真实性未知，另一个API值已确认合成；CI secret-scan任务success。历史生产日志/备份的敏感内容未审查 | 保留两种扫描结果；不展示完整值，有来源证据后确认失效/轮换与影响，必要时另行事故处置，禁止无依据撤销全部会话 |
| 真实邮箱接收 | 固定注册模板单封站长邮件已被SMTP接受；收件箱/垃圾箱/延迟未验证。生产代码/迁移及注册已正式开放，失败关闭与只读手机桌面检查通过 | 由站长自行核对该1封邮件；若需真实账号端到端验收，使用本人受控邮箱，不要求在聊天提供授权码或验证码，不向真实用户批量发信 |
| 上线环境与外部登录验收 | 安全组/防火墙/CDN/跨机回源、真实微信回调、报警接收与持续负载尚未完整核实。128MiB短测成功但峰值内存不可读 | 后续受控核查这些外部条件；保留TLS/安全头/未公开auth与DB端口/真实peer的现有证据，不新增不必要基础设施 |
| 小影额外改动与回滚演练 | 本轮保留小影现有镜像及staging；候选小影helper不代表已上线，实际旧镜像回滚再前滚未执行 | 需要时独立评估兼容并发布小影；回滚使用精确镜像/配置，先在Caddy关闭注册，不覆盖生产数据库 |

## 配置、实际发布顺序与兼容迁移

当前没有需要在聊天提供的秘密。SMTP授权码已由用户在服务器配置并确认旧码轮换；新auth已载入，配置0600。独立 `AUTH_REGISTRATION_HMAC_KEY` 已核实长度至少32且不同于 `AUTH_TOKEN_PEPPER`，本轮保留现有值；生成熵来源未追溯，不据此认定已经泄漏。该密钥应由CSPRNG生成至少32随机字节编码，未来只在服务器密钥管理下单独轮换，不变更既有token pepper/管理员MFA/小影密钥。SMTP465隐式TLS与证书校验开启，配置模板只保留占位符。

本次已按用户明确授权执行以下顺序；历史数据保留，未新增微服务或其他基础设施：

1. 公开推送隔离生产基线候选并运行GitHub quality，5项实际任务全部通过；获取完整app/auth镜像，核对工件SHA、镜像ID与non-root。没有使用原旧工作树或现场重新构建。
2. 备份生产数据库、在自建临时库完成隔离恢复并删除该临时库；保留原镜像与配置用于回滚。独立128MiB候选容器的双Argon2短测通过，可信代理仍为172.18.0.6/32。既有staging及其数据库不变。
3. 给站长本人邮箱单发1封固定注册模板邮件，SMTP接受；收件箱/垃圾箱及延迟未验证。验收使用候选库，不向真实用户发信，也不输出验证码或授权码。
4. 生产Caddy保留现场 `library.dufesh.cn`、staging片段、额外网络与图书馆配置，只加载必要的生产边界修改，注册先临时关闸。PostgreSQL日志配置reload并SHOW确认为0/0/terse/panic，数据库容器未重建。
5. 既有migration runner应用追加0028，前27迁移校验和匹配。新表与约束是追加式，历史用户/密码/邮箱状态/绑定/会话不改；不把历史邮箱批量标成已验证，也不强制全员登出。旧账号继续原登录；补验证仅在未来明确过渡政策或敏感邮箱操作时要求。
6. 仅替换app/auth完整镜像，新auth载入SMTP/HMAC及 `AUTH_REGISTRATION_MODE=smtp`，健康通过且RestartCount=0/OOMKilled=false。生产小影、PG、web容器未重建，其他服务镜像保留检查为true，staging未改。
7. 最后检查主域health200、HTTP API与HTTPS www API空POST403、HSTS主域一天及HTTPS/私有no-store等，解除临时注册关闸、正式开放邮箱验证码注册，并记录release至current，时间UTC2026-10-11T15:22:02Z。缺邮箱/伪造verified或role/外部Origin以及未登录私有入口均被拒绝；生产只读手机390与桌面1280注册面板2/2通过，没有API写请求。完整CI覆盖合成多账号权限、会话、旧用户兼容及手机桌面关键链；真实微信/第三方回调、邮箱收件、外部CDN/安全组仍逐项标为未验证。找回密码/改邮箱维持原disabled，未凭注册邮件验收擅自启用其他流程。

学校HTTP风险单独保留。宿主解析地址符合公网要求，但没有真实学校账号导入证据；不能把邮箱注册发布视为学校链路已安全。若后续确认真实凭据泄漏，另行制定学校密码更换/会话失效及调查，不用当前修复宣告事故结束。

安全回滚必须先在 **Caddy关闭 `/api/auth/register` 与 `/api/auth/register/challenge` 写入口**，验证关闸生效后再回退旧app/auth精确镜像；只设 `AUTH_REGISTRATION_MODE=disabled` 无法保证不认识该变量的旧auth关闭注册。保留追加0028安全表/约束及历史记录，不运行旧迁移器，不覆盖生产数据库，不回退到会重开无验证注册的网关配置。整体核对来源头/可信peer与HTTPS保护，重复健康和拒绝测试。HMAC轮换仅使待验证挑战失效，不撤销既有会话。

已准备具体回滚材料于 `/srv/apps/dufesh/shared/backups/security-20261011T151027Z/`：`snapshot.json` 记录原镜像摘要和真实绑定路径，`Caddyfile.rollback-registration-closed` 保留本次HTTPS/代理保护并关register及全部子路径，`docker-compose.rollback.yml` 精确退app/auth到9de3008而保留其他服务，`auth.env.rollback-disabled` 保留密钥并关闭新注册。目录0700，秘密配置0600。应用回滚步骤为：先核对当前仍是本次9a343d1并取得release.lock；把关闸Caddy内容写到snapshot记录的实际绑定文件（文件挂载用原inode写入），执行`docker exec dufesh-web-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`，空POST确认503；加载禁用注册的env，然后用回滚Compose运行`docker compose -p dufesh -f <回滚Compose绝对路径> up -d --no-build --no-deps --wait app auth-api`；只在健康后原子更新current指向9de3008并重新记录manifest，保留0028和日志设置。未实际执行旧镜像回滚再前滚；正式数据库restore属于独立高风险操作，不能拿隔离恢复命令直接覆盖原库。

覆盖恢复生产数据库可能丢失发布后的业务数据，属于另需明确授权的高风险操作；本轮隔离恢复成功不授权执行覆盖恢复。不删除用户或原始资料，不 `down` 生产栈，不重写Git历史。疑似真实密钥确认泄漏后应失效/轮换并审查影响，不能只删除当前文件。

以上修复降低已确认风险，不承诺绝对安全。本地通过的结果和未完成的线上验收分别记录。
