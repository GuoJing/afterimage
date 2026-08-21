# Favicon、SEO 与 GEO 交接

> 后续更新：默认前台语言为 `zh,en,ja`，语言菜单以各语言自称显示，并支持点击菜单外部或按 `Esc` 自动关闭。已有部署若在 `.env` 明确设置了 `BLOG_LOCALES`，需同步改为 `BLOG_LOCALES=zh,en,ja` 才会显示日语入口。

日期：2026-08-21

## 本次目标

- 使用现有 `afterimage.photography` 网站的 favicon。
- 确保文章详情页可被传统搜索引擎抓取和理解。
- 为 AI 搜索和 Agent 提供清晰、可读取的内容入口（GEO 基础能力）。
- 保持草稿、404 和隐藏后台不可索引。

## Favicon

从现有站点实际 HTML 中确认并下载了原始资源：

- `public/favicon.ico`：原站 50×50 ICO。
- `public/apple-touch-icon.png`：原站 1400×1400 PNG。

所有页面的 `<head>` 都会输出 `rel="icon"` 和 `rel="apple-touch-icon"`，资源由当前应用本地托管，不依赖 Typlog 外链可用性。

## SEO 实现

- 新增 `SITE_URL` 配置；默认值为 `https://afterimage.photography`。
- 文章 HTML 为服务端渲染，标题、摘要、正文、时间和语言链接无需 JavaScript 即可被抓取。
- 每个已发布语言版本输出：
  - 唯一 canonical URL。
  - 所有真实翻译的 `hreflang` 与 `x-default`。
  - 与实际渲染内容一致的 `<html lang>`。
  - Open Graph 与 Twitter Card。
  - `BlogPosting` JSON-LD，包括标题、摘要、图片、发布日期、修改日期、语言、作者、发布者和 canonical。
  - 可索引 robots meta，允许完整摘要和大图预览。
- 请求的语言不存在并回退默认语言时，canonical、HTML lang、JSON-LD 和 Markdown 链接全部指向实际渲染语言，避免重复内容。
- `/sitemap.xml` 动态列出所有已发布文章的真实语言版本、更新时间和语言替代链接，不包含草稿。
- `/robots.txt` 允许公开内容抓取并声明 Sitemap；不会在其中暴露隐藏后台路径。
- 404 使用 `X-Robots-Tag: noindex, follow`。
- 草稿预览和后台页面使用 `noindex, nofollow, noarchive`；后台同时设置 HTML meta 和 `X-Robots-Tag`。

## GEO / AI 可读能力

- `/llms.txt`：按 llms.txt 提案格式提供站点说明、已发布文章目录和简短摘要。
- `/llms-full.txt`：提供所有已发布语言版本的完整 Markdown 正文合集。
- `/post/<locale>/<slug>.md`：提供与每篇 HTML 文章对应的纯 Markdown 版本。
- HTML 文章使用 `rel="alternate" type="text/markdown"` 指向 Markdown 版本，并用 `rel="describedby"` 指向 `/llms.txt`。
- Markdown 响应包含 canonical 与 llms.txt `Link` 响应头。
- AI 文件和 Sitemap 均只使用已发布文章，不会泄露草稿或后台内容。

## 验证结果

使用 Node.js 22.23.2、临时 SQLite 数据库、中文/英文已发布文章及一篇草稿进行集成验证：

- 中文文章 HTML：200，正文为服务端输出。
- 英文文章 HTML：200，使用英文 canonical、lang、摘要和 JSON-LD。
- 法语路由回退中文：200，canonical 和 lang 正确指向中文。
- JSON-LD：可被 `JSON.parse` 正确解析，类型为 `BlogPosting`。
- Sitemap：200，并通过 `xmllint --noout`。
- robots.txt、llms.txt、llms-full.txt：均为 200。
- 文章 `.md`：200，`Content-Type: text/markdown; charset=utf-8`，canonical Link 响应头正确。
- favicon：200，`image/vnd.microsoft.icon`。
- Apple Touch Icon：200，`image/png`。
- 后台登录页：HTML meta 和响应头均为 noindex。
- 404：404，并带 noindex 响应头。
- `npm run check` 和 `git diff --check` 通过。

## 部署后仍需人工完成

- 确认生产环境 `SITE_URL=https://afterimage.photography`，尤其是在未来更换域名时同步更新。
- 在 Google Search Console 和 Bing Webmaster Tools 验证域名，并提交 `https://afterimage.photography/sitemap.xml`。
- 使用 Google URL Inspection / Rich Results Test 检查一篇线上文章并请求抓取。
- 搜索引擎和 AI 是否实际收录、何时收录由各平台决定；当前代码提供了抓取与理解所需的技术信号，但不能保证收录时间或排名。

## 参考依据

- Google Search Central：Article/BlogPosting JSON-LD、canonical、robots meta/X-Robots-Tag 与 Sitemap 指南。
- llms.txt v2 提案：根目录 `llms.txt`、Markdown 页面替代版本与 `rel="describedby"`/`rel="alternate"`。
- 现有站点 `https://afterimage.photography/` 的 favicon、Apple Touch Icon 和基础社交元信息。
