# 东财之影：基础 SEO 与收录操作

本轮代码已完成本地验证，尚未部署，也未登录搜索平台或提交收录。

## 实现与文件

| 文件 | 生效行为 |
| --- | --- |
| `app/seo.ts` | 统一正式域名、品牌说明和可收录公共入口；入口页面 canonical 与 sitemap 共用路径 |
| `app/layout.tsx` | 使用统一域名和品牌 description，沿用原 title、Open Graph、Twitter、WebApplication |
| `app/page.tsx` | 保留原品牌 H1/title/canonical；首屏服务端 HTML 加入自然校园工具说明、真实教师/资料链接和 WebSite JSON-LD |
| `app/robots.ts` | 沿用原生 metadata route；补上管理/内测路径本身及查询变体的禁抓规则，公开页与 JS/CSS 仍允许抓取 |
| `app/sitemap.ts` | 沿用原生 metadata route；7 个公共入口 + 439 个去重资料详情，共 446 个 URL；去掉无依据的统一 lastmod |
| `app/materials/materials-catalog.mjs` | 从详情页实际使用的 ID 映射导出资料路径，自动跟随资料增删且去重 |
| `app/materials/[materialId]/page.tsx` | 给真实资料详情生成自身 canonical，保留原有不存在资料的 404 |
| `app/materials/page.tsx`、`app/teachers/page.tsx`、`app/community/page.tsx` | 既有 canonical 改用共享入口表 |
| `app/privacy/page.tsx`、`app/terms/page.tsx`、`app/account/delete/page.tsx` | 补充各自 canonical |
| `tests/rendered-html.test.mjs`、`tests/production-server.test.mjs`、`tests/infrastructure-contract.test.mjs` | 验证真实构建 HTML、全部 sitemap 地址及生产网关的 robots/sitemap 响应；原路径硬编码断言改为检查共享配置 |
| `docs/CURRENT_STATE.md`、`docs/SEO.md` | 记录本地实施结果和上线后操作 |

没有增加依赖、修改 CSS、业务逻辑、生产配置或用户未跟踪文件。没有把查询参数视图伪装成独立页面。个人课表和空教室仍按原方式客户端交互。

## 检查结果与边界

- 框架是 React 19 + TypeScript + vinext 0.0.50，使用兼容 Next App Router 的文件路由、Metadata / generateMetadata / MetadataRoute。部署为 Node 生产网关 + Caddy，构建同时产出 RSC/SSR/client。
- 线上检查：首页、robots.txt、sitemap.xml 返回 200；首页 title、canonical 和品牌 H1 已存在，没有阻止收录的 meta/header noindex。
- HTTP 首页与 HTTPS www 首页都 308 至 `https://dufesh.cn/`；`/privacy/` 308 至 `/privacy`；未知普通路径返回 404。原有 Caddy 域名归一化继续使用。
- 旧 sitemap 漏了资料、社区入口与真实资料详情，且全部日期固定为 2026-07-30。本次去掉不能证明的 lastmod，不以每次请求或构建时间伪装内容更新。
- 当前目录有 457 条资料记录、439 个唯一详情 ID。sitemap 复用详情查询已有的 Map，去重生成；不改原始数据和业务去重语义。
- 首页并非空白 SPA：禁用 JavaScript 也能在 HTML 中读到品牌 H1、介绍、导航和 metadata。但课程数据、今日安排、教师搜索结果及教师详情正文仍需客户端请求；品牌首页可发现不等于所有业务正文都已实现 SSR。
- 教师详情路由没有在服务端验证实体是否存在，也未生成教师级 metadata，存在软 404/弱内容风险。本轮不改教师业务加载方式，教师详情不进入 sitemap。后续若以教师姓名搜索为目标，应单独实现公开数据 SSR、服务端 404 与对应 metadata。
- 社区主题、用户档案、个人收藏和管理员既有 noindex 保留；不将这些页面加入 sitemap。staging 原有全站 X-Robots-Tag noindex 保留，正式站不可照搬 staging 响应头。
- robots 禁抓不是权限控制，也不保证已收录 URL 消失；管理员仍依赖现有鉴权/noindex。
- 本轮不加 IndexNow：品牌首页发现优先使用站点验证、sitemap 和主动请求索引。若以后有频繁公开内容发布，可在真实发布事件后接入，而非每次访问发送通知。IndexNow 不保证收录：[Bing 官方说明](https://www.bing.com/indexnow/getstarted)。

## 上线后人工操作

1. Google：[Search Console](https://search.google.com/search-console) 添加 `dufesh.cn` 域名资源，按后台给出的 DNS TXT 验证；提交 `https://dufesh.cn/sitemap.xml`。URL 检查首页，执行实时测试，再请求编入索引。[官方操作说明](https://developers.google.com/search/docs/monitor-debug/search-console-start)。
2. Bing：[Webmaster Tools](https://www.bing.com/webmasters/) 添加网站，按后台 DNS 验证或从已验证的 Search Console 导入。提交相同 sitemap，用 URL 检查/提交功能检查首页，并查看抓取错误。[官方说明](https://blogs.bing.com/webmaster/June-2025/Start-Using-Bing-Webmaster-Tools-to-Improve-Your-Site-Visibility)。
3. 百度：[搜索资源平台](https://ziyuan.baidu.com/) 登录并添加 `https://dufesh.cn`，按账号当前提供的方式完成站点验证，在普通收录/链接提交等可用入口提交首页；若开放 sitemap 提交权限，提交同一 sitemap。入口名称和配额以登录后实际界面为准，本次未验证登录后权限。
4. 搜狗：[搜狗资源平台](https://zhanzhang.sogou.com/) 登录并按“网站管理”完成验证，在账号开放的“资源提交”入口提交首页及 sitemap（如支持），查看收录索引。当前公开平台仍列出网站验证、资源提交和收录查询，不假设每个账号都有批量权限。

验证优先选后台提供的 DNS 方式。若使用 meta 验证，需要把平台真实 token 加入根 layout 的原生 `metadata.verification`（Google/Bing 或 `other` 下平台指定字段）；不要提交占位 token。若选择下载 HTML/TXT 验证文件，注意 `server.mjs` 限制公开根文件路径：只放到 `public` 不足以确保上线可读，还需精确允许该验证文件路径并验证响应，不能开放整个目录。当前没有任何验证凭据，因此未添加虚假验证标记。

## 发布验收和后续观察

- 直接访问 `https://dufesh.cn/robots.txt` 与 `https://dufesh.cn/sitemap.xml`，分别应为 200 文本/XML，不要求登录，也不跳转首页。
- 查看首页“网页源代码”，应含唯一首页 canonical、品牌 title/description、`<h1>` 和 `"@type":"WebSite"`，站名为“东财之影”，URL 为 `https://dufesh.cn/`。不能只看浏览器 JS 执行后的 DOM。
- sitemap 当前应有 446 个不同 URL，未来随资料目录变化。全量本地构建测试已逐条确认 200、自身 canonical、无 noindex，并确认未知资料/普通路径为 404。资料文件下载可用性与详情 HTML 收录是不同检查，本轮未逐个下载文件。
- 本地验证命令：`npm run build`、`npm run typecheck`、修改文件的 ESLint、`node --test tests/rendered-html.test.mjs tests/production-server.test.mjs tests/materials-catalog.test.mjs`（11/11）、`git diff --check`。
- 发布后每周看一次站长后台：sitemap 是否成功读取、首页索引状态、抓取错误、搜索词“东财之影”的展现和点击。搜索 `东财之影`、`"东财之影"`、`site:dufesh.cn` 可辅助观察；site 查询不代表完整索引清单，不应仅据此判定失败。
- 验证成功、提交成功、抓取成功、收录和品牌词排名是不同阶段。不会承诺几天收录或固定排名。保留稳定域名、真实文案和可访问服务即可，不做关键词堆砌。

实现依据：[Google 网站名称与 WebSite](https://developers.google.com/search/docs/appearance/site-names)、[sitemap 和 lastmod](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)。
