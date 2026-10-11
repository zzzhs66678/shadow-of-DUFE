# 邮箱补验证与密码恢复安全交付

## 状态与兼容性

生产代码 `2a470c01891473cf669a61d113b4c107fbdf6c53`，独立开发分支 `codex/security-production-20261011`，北京时间2026-10-12 00:38发布。完整CI通过，追加0029迁移并启用两项SMTP恢复功能；具体生产验收见下方。代码及模拟测试通过不代表真实邮件最终投递通过。

- 新注册继续强制服务端邮箱验证码，邮件比较及数据库唯一规则沿用注册安全修复。
- 老用户仍可使用原密码登录，不自动把历史邮箱标记为已验证，不批量撤销会话。
- 已登录的老用户可自愿补验证：确认当前网站密码，收到邮箱令牌后在发起申请的同一登录会话中提交。
- 匿名密码找回只向事先已验证的当前邮箱投递。不存在、停用及未验证账号的请求均返回相同的202；SMTP、数据库和账号查询在相同响应后执行。
- 历史邮箱未验证且已忘记密码的账号，暂不能自动邮件找回，需要站长另行核实归属。仅拥有历史邮箱或提交未经验证的学号都不足以证明账号归属；人工恢复尚未新增自动化后台入口。
- 普通新密码为15–128个Unicode码点；旧短密码仍可登录，界面支持粘贴及密码管理器。一次注册邮箱验证不代表登录MFA。

## 发现与修复证据

以下问题位于此前关闭的恢复功能中；不据此推断已发生线上账号接管。

下表“旧”行号固定指向 `9a343d1ee081e204382cd5a30e59a4b95c4f1270`，“新”行号固定指向 `2a470c01891473cf669a61d113b4c107fbdf6c53`。均已通过 `git show <SHA>:<路径>` 与当前代码核对，后续编辑造成的行号变化以这两个提交为准。

| 分级与类型 | 触发条件及影响 | 证据与修复 | 验证 |
| --- | --- | --- | --- |
| 高，已确认 | 旧逻辑在开启恢复后，只要历史邮箱有active账号即可签发重置令牌；错误或被他人掌控的历史邮箱可能成为账号恢复通道 | 旧 `services/auth-api/src/server.mjs:1037` 只判断active；旧 `services/auth-api/src/db.mjs:1739`、`:1851`、`:1871` 的创建、查询、消费均无已验证邮箱门槛。新 `services/auth-api/src/server.mjs:1070`、`services/auth-api/src/db.mjs:1814`、`:1974`、`:1999` 要求已验证、当前规范邮箱及SQL密码版本一致 | 复现与HTTP测试 `services/auth-api/test/auth-api.test.mjs:498`；状态与版本回归 `tests/account-recovery-security.test.mjs:80`、`:155`，PGlite及原生PG通过 |
| 高，已确认 | 补验证此前无需原密码，令牌绑定userId与邮箱，未绑定精确发起会话或密码版本；同账号另一有效会话可提交，旧密码版本不能使令牌自动失效 | 旧 `services/auth-api/src/server.mjs:857`、`services/auth-api/src/db.mjs:1764`、`:1801`。新 `services/auth-api/src/server.mjs:908` 复核当前密码；新 `services/auth-api/src/db.mjs:1850`、`:1915` 在事务中绑定/重查发起session、邮箱及SQL精度password_changed_at；锁顺序见新 `services/auth-api/src/db.mjs:16`、`:32` | 密码证明HTTP测试 `services/auth-api/test/auth-api.test.mjs:513`；同账号另一会话、另一用户、退出/过期/邮箱变化/密码变化拒绝，见 `tests/account-recovery-security.test.mjs:115`、`:124` |
| 中，已确认 | 原恢复令牌没有成功投递门槛；旧投递helper吞掉SMTP/预算落库错误，没有向调用者返回成功状态 | 旧 `services/auth-api/src/server.mjs:228`、旧 `services/auth-api/src/db.mjs:1739`、`:1764`。新 `ops/postgres/migrations/0029_account_recovery_security.sql:3`、`:9` 追加pending/delivered/failed；新 `services/auth-api/src/server.mjs:228`、`:953`、`:1081` 要求SMTP和租约落库成功后才mark；新 `services/auth-api/src/db.mjs:44`、`:1894`、`:1898` 只允许pending转为delivered/failed，failed不能再变成功 | SMTP/预算异常HTTP测试 `services/auth-api/test/auth-api.test.mjs:540`、`:566`；状态与事务回滚 `tests/account-recovery-security.test.mjs:100`、`:202` |
| 中，已确认 | 旧confirm路径未检查关闭模式，关闭申请并不关闭确认；回退旧代码仍会忽略新增字段 | 旧 `services/auth-api/src/server.mjs:937`、`:1079` 的confirm无模式门槛。新 `services/auth-api/src/server.mjs:866`、`:975`、`:1033`、`:1130` 对两流程的request/confirm均检查disabled；回退9a前必须先在Caddy关闭两个恢复路径全部子入口 | 关闭模式HTTP测试 `services/auth-api/test/auth-api.test.mjs:527` 通过；实际二进制回退未执行 |
| 体验，已确认 | SMTP202不含debugToken，原UI只在debugToken非空时展示输入，真实邮件用户无法填写 | 旧 `app/DufeHubV2.tsx:6336`、`:6401`、`:7091` 以令牌非空决定步骤；新 `app/DufeHubV2.tsx:6266`、`:6310` 使用独立阶段，新 `app/DufeHubV2.tsx:6441`、`:6866`、`:7154` 在真实SMTP响应后显示空令牌输入；`:6977`、`:7197` 支持直接填写已收到的令牌 | `tests/e2e/recovery-security.spec.ts` 桌面/手机6项模拟浏览器通过；`tests/e2e/postgres-recovery-path.spec.mjs` 与既有原生完整浏览器合计2项通过 |

改密、失效本人全部恢复令牌并撤销本人基础/管理员会话的同一事务见新 `services/auth-api/src/db.mjs:1999`、`:2042`、`:2047`、`:2052`、`:2058`；其他账号隔离回归见 `tests/account-recovery-security.test.mjs:182`。过期清理由新 `services/auth-api/src/db.mjs:1902` 和 `services/auth-api/src/index.mjs:16` 复用既有安全清理任务，无新常驻服务；28→29保留旧用户/会话及拒绝旧未绑定令牌的升级回归见 `tests/account-recovery-security.test.mjs:254`。

可复核[完整代码差异](https://github.com/zzzhs66678/shadow-of-DUFE/compare/9a343d1ee081e204382cd5a30e59a4b95c4f1270...2a470c01891473cf669a61d113b4c107fbdf6c53)，其中包含上述代码、迁移、配置示例与测试；不含真实SMTP授权码、用户密码或邮箱令牌。

## 事务、邮件及敏感数据边界

0029只增加恢复/验证令牌的邮箱、密码版本、发起会话和投递状态字段。历史用户、验证状态、密码、绑定及会话不批量改动；迁移前令牌无绑定快照，按新代码不可用。版本快照通过SQL复制，保留微秒，不经JavaScript Date截断。

数据库按用户、凭据、相关会话与令牌一致顺序加锁。同令牌并发只有一次消费；重发使旧令牌失效。改密、消费全部本人恢复令牌和撤销本人基础/管理员提升会话在同一事务中，其他用户不受影响。数据库异常回滚整个修改。

SMTP是事务外依赖：成功发送不代表数据库一定成功标记，标记失败时令牌仍不可用。共用现有数据库发送预算、60秒间隔、每邮箱/全局预算和2个有界发送租约，无新队列、Redis或服务。发送调用固定模板和单个收件人，TLS证书校验保持开启，重试上限0。

43字符恢复令牌由CSPRNG生成，数据库只存现有独立服务端pepper的HMAC摘要，注册6位码继续使用独立注册HMAC密钥。邮箱补验证输入的当前密码只在当前请求内使用，不存明文。日志只记录固定错误事件；SMTP密码、原密码和邮件令牌不进入生产API响应或浏览器持久化存储。个人离线课表数据保留。

## 本地实际检查

| 命令/范围 | 实际结果 |
| --- | --- |
| `node --test --test-name-pattern=... services/auth-api/test/auth-api.test.mjs`修复前复现 | 3项失败：未验证邮箱签发、无密码补验证、关闭模式仍接受confirm；修复后3项通过 |
| `npm test --prefix services/auth-api`等价完整auth测试 | 133通过，0失败 |
| `node --test tests/*.test.mjs tests/*.test.ts`最终全根回归 | 425通过，0失败，9项条件跳过；不是全部原生PG验证 |
| `node --test tests/account-recovery-security.test.mjs`PGlite | 13通过，2原生并发条件跳过 |
| 原生PG17独立runtime角色恢复套件 | 15/15，包括双连接并发、重发、28→29兼容升级 |
| 原生PG角色/既有业务HTTP两套件 | 12/12，包括原有账号、社区、管理员、资料与反馈隔离 |
| `npx playwright test --config playwright.production-security.config.ts`，合成库dufesh_recovery_ci | 最终2/2：完整既有登录/注册/同步/管理员业务和SMTP替身恢复链路 |
| 新增recovery-security模拟浏览器，390/1280px | 最终6/6：SMTP202填码、当前密码证明、Unicode长度、清理敏感状态、登录后保留展开状态 |
| `npm run typecheck`、`npm run build`、相关ESLint、`git diff --check` | 最终通过；UI仅3条既有整页导航warning |
| `node scripts/export-ui-copy.mjs`及自测 | 1999条、2995处；自测通过 |
| `gitleaks git --log-opts=5552424..2a470c0 --redact` | 本轮1提交、约1.91MB扫描0泄漏匹配；不替代既有历史残留调查 |

中间失败没有作为通过隐藏：UI中途补丁曾造成解析失败，已修复；初版账号隔离key使登录后面板收起，被原生回归发现并改为仅清理敏感表单；新恢复测试碰到真实60秒发送冷却，已仅调整该合成收件人的测试时间戳，不放松生产策略；原生浏览器选择器合同随后更新以覆盖两个实际套件。上表是最终结果。

## 完整CI检查实证

已执行 `gh run view 38154902625 --repo zzzhs66678/shadow-of-DUFE --json headSha,status,conclusion,jobs,url`：返回的headSha精确为 `2a470c01891473cf669a61d113b4c107fbdf6c53`，status为completed、conclusion为success。完整quality运行于2026-10-12北京时间00:18–00:27结束，五项job均completed/success，未用本地结果替代。见[完整CI运行](https://github.com/zzzhs66678/shadow-of-DUFE/actions/runs/38154902625)及[该提交的完整工作流与命令](https://github.com/zzzhs66678/shadow-of-DUFE/blob/2a470c01891473cf669a61d113b4c107fbdf6c53/.github/workflows/quality.yml)。

| CI job | 真实结果与检查命令/入口 |
| --- | --- |
| [verify](https://github.com/zzzhs66678/shadow-of-DUFE/actions/runs/38154902625/job/114515755733) | success；`npm run audit:production`、两个服务的`npm audit --omit=dev --audit-level=high`、工作流列出的完整业务Node回归、`npm test --prefix services/auth-api`、`npm run test:xiaoying`、`npm run build`、`npm run typecheck`、渲染/生产网关检查及`npm run test:browser`通过；主站审计沿用有期限的构建依赖例外，不能解释成所有历史告警消失 |
| [postgres-17-integration](https://github.com/zzzhs66678/shadow-of-DUFE/actions/runs/38154902625/job/114515755714) | success；`MIGRATIONS_DIR="$GITHUB_WORKSPACE/ops/postgres/migrations" sh ops/postgres/run-migrations.sh`执行两次；空合成库`SECURITY_POSTGRES_TEST=true node --test tests/registration-security.test.mjs`；runtime角色`node --test tests/postgres-runtime-integration.test.mjs tests/postgres-product-extensions.test.mjs tests/account-recovery-security.test.mjs`；`npx playwright test --config playwright.postgres.config.ts`与`RESTORE_DRILL_MODE=native sh ops/postgres/restore-drill.sh "$backup_file"`通过，恢复测试库残留计数0 |
| [linux-production-images](https://github.com/zzzhs66678/shadow-of-DUFE/actions/runs/38154902625/job/114515755670) | success；三份实际Dockerfile的`docker build --build-arg NODE_IMAGE=node:22-alpine`通过，运行用户node、原生依赖加载和构建链裁剪检查通过；生产网关、隔离CI staging HTTPS栈冒烟以及已验证镜像/运行包打包步骤均成功。该CI staging不代表修改了服务器既有staging |
| [codeql](https://github.com/zzzhs66678/shadow-of-DUFE/actions/runs/38154902625/job/114515755473) | success；工作流固定提交的`github/codeql-action/init`与`analyze`两步均success |
| [full-history-secret-scan](https://github.com/zzzhs66678/shadow-of-DUFE/actions/runs/38154902625/job/114515755685) | success；工作流`fetch-depth: 0`与固定提交的`gitleaks/gitleaks-action`步骤成功。此前手动全历史扫描的疑似学校challenge仍按上一报告待核实，job成功不作为撤销历史风险的依据 |

以上CI通过证明对应提交通过隔离门禁，不证明生产真实收件箱、学校TLS或实际二进制回滚已经验证；生产结果由下方实证独立记录。

## 配置与部署

复用已在服务器设置的SMTP授权码、token pepper、注册HMAC和精确可信代理范围。无需用户在聊天提供任何秘密，也无需新增服务或密钥。配置模板仍默认关闭恢复，只含空白秘密字段。

生产上线顺序：受限目录备份与隔离恢复验证 → 校验通过CI的完整镜像及精确SHA源码 → 复制现场Compose只更新app/auth镜像，保留原有绝对Caddy/PG挂载及网络 → 在真实挂载文件临时关闭四个恢复入口、reload并验证503 → 原迁移runner追加0029 → 两个恢复模式设smtp → 只替换app/auth → 确认新镜像健康与模式已载入 → 恢复原Caddy内容并reload → 更新current/previous及manifest → 公开权限/HTTPS与只读UI检查 → 发布后备份并隔离恢复验证。staging、数据库、web、小影和图书馆容器不替换。

生产数据库原地恢复、账号人工重置、批量会话撤销仍属于单独处理事项，本轮不执行。

## 回滚

保留0029，不倒退迁移或恢复覆盖生产库。旧9a auth忽略新绑定列，且confirm不检查模式，因此不能只把模式改disabled后直接回退。

先取得发布锁、核对当前版本；将本次备份的关闭恢复Caddy内容写入**真实已挂载的文件**并reload，确认reset及email/verification请求/确认均503；保持注册与正常登录；恢复本次备份的关闭两恢复模式配置；再用精确旧镜像Compose仅回退app/auth，健康后恢复current/previous/manifest。恢复入口继续关闸，直到重新发布安全版本。实际二进制回滚未运行，不能声称已演练。

## 未解决或仍未验证

- 真实邮箱收件箱、垃圾箱、邮件正文与延迟未验证；原注册模板仅向站长自有邮箱发送1封被SMTP接受。本轮自动化恢复测试全部使用模拟邮件，没有给真实用户发信。
- 生产真实账号的完整补验证/改密未执行，未使用真实用户密码或撤销真实用户会话。
- 忘记密码且历史邮箱未验证的人工归属核验需要站长个案处理，目前无安全的匿名自动恢复捷径。
- 学校WebVPN的HTTP敏感回源仍为上一报告高风险未解决项；导入功能保留，仅模拟学校接口测试。
- 真实微信回调、安全组/防火墙/CDN完整配置、历史日志/备份敏感残留、告警接收与长期容量仍未完成验证。详见上一份安全审计，不承诺绝对安全。

## 生产发布实证

正式发布：UTC `2026-10-11T16:38:35.368727Z`（北京时间2026-10-12 00:38）。`current`指向2a470c0，`previous`保留9a343d1，服务器发布清单已更新。

- 追加`0029_account_recovery_security.sql`成功，前28迁移校验值不变；数据库迁移数29。新app/auth镜像分别为`sha256:37f9afb7ac2fe6d31af2328f359eddc86b8235d4525247090db754614dcc07ac`、`sha256:1aacb1e7c15cf5287b4edcd36a61894502b6831a646c1864503dc030f0e13e41`，两者healthy、重启0、无OOM。
- `AUTH_PASSWORD_RESET_MODE=smtp`、`AUTH_EMAIL_VERIFICATION_MODE=smtp`已载入；注册仍为smtp。复用服务器现有秘密，不需要重新提交授权码或新增密钥。
- 发布切换期间四个恢复入口已实际验证503，新auth健康后恢复原路由；最终Caddy内容摘要与备份相同，实际可信peer仍172.18.0.6。PG/web/小影/图书馆/staging的容器ID不变。
- CI镜像包`images.tar.gz`的SHA-256为`84a19222340fed66e1c6b451f1ec7feb6471fc84106cd01dc2a488b8ebfda2c5`，清单提交及文件摘要校验通过；精确SHA源码下载包摘要`312eff14550dee3f86105b8860da04c565d71751552faeaf24e2e4f4ae70f08d`，校验路径与成员后解包。未在小内存生产机重新构建。
- 备份目录`/srv/apps/dufesh/shared/backups/recovery-20261011T162109Z`为0700，配置、dump和诊断文件0600。`before-recovery.dump` 3,989,844字节、`after-recovery.dump` 3,991,854字节，均checksum及`pg_restore --list`通过；隔离恢复分别28/29迁移、61表、0无效约束，迁移校验相同，只删除自建临时库。备份角色只读、runtime可用、importer不能访问恢复令牌的权限检查通过。
- 配置差异核查恰为两项恢复模式disabled→smtp，其他秘密与配置保留；备份后的容器ID、Caddy及PG摘要再检查不变。相关实证为服务器备份目录中的`deployment-status.json`、`after-backup-verification.json`、`after-restore-check.json`、`after-deployed-metadata.json`。

公开检查实际执行`node C:/Users/zzz/AppData/Local/Temp/dufesh-recovery-public-check-20261012.mjs`，退出0、状态PASS。只使用匿名隔离浏览器及不存在的`example.com`合成邮箱，没有发真实邮件、修改用户或调用学校接口。

| 生产检查 | 实际结果 |
| --- | --- |
| 匿名session及功能状态 | 200，恢复与补验证available均true，认证响应no-store |
| 不存在邮箱请求找回 | 202，只有`{ok:true}`，无令牌；无邮件投递 |
| 空重置confirm、匿名补验证request/confirm | 分别400、401、401，均no-store |
| 外站Origin、HTTP敏感提交、www敏感提交 | 均403；普通HTTP页面308转HTTPS |
| Cookie、页面安全头 | Secure/HttpOnly/SameSite=Lax，HSTS一天、nosniff、CSP/frame-ancestors通过 |
| 1280/390px真实站点只读页面 | 两项通过；忘记密码→已有重置码入口、空令牌输入、new-password自动填充可用；无横向溢出、混合内容、脚本或HTTP错误 |

结果和截图位于本机`C:/Users/zzz/AppData/Local/Temp/dufesh-prod-recovery-ui-20261012/`：`verification.json`、`reset-1280.png`、`reset-390.png`。截图下方懒加载画廊的空白不作为业务图片故障证据。

真实邮件收件及真实用户完整恢复仍未验证；实际二进制回滚未执行。上线后人工检查可使用站长自己的账号：仍记得密码的历史账号登录→管理账号→输入当前密码补验证→在同一浏览器填邮件令牌，再确认找回邮件能进入收件箱/垃圾箱、令牌仅可用一次。不要在聊天提供密码或令牌；忘记密码且邮箱未验证的账号先个案核实归属。
