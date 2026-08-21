# Afterimage Blog

一个极简的 Node.js + SQLite 多语言博客。页面结构参考现有的 AFTERIMAGE PHOTOGRAPHY，第一版只实现文章与 Admin 后台。

运行环境要求 Node.js 22.12 或更高版本。

## 已实现

- 带语言的文章 URL：`/post/zh/deep`、`/post/en/deep`
- SQLite 存储，文章与翻译分表
- 中文为默认语言；文章 URL 明确包含语言，缺少该语言翻译时回退到默认语言
- Admin 新建、编辑、发布、删除文章
- 管理员可预览草稿，普通访客访问草稿仍返回 404
- Markdown 正文，支持外链图片
- 文章 canonical、hreflang、Open Graph、Twitter Card 与 BlogPosting JSON-LD
- 动态 `robots.txt`、`sitemap.xml`、`llms.txt`、`llms-full.txt` 和文章 Markdown 版本
- 响应式页面、明暗主题
- Docker / Docker Compose 云端部署
- 后台登录、CSRF 防护、HttpOnly Cookie

## 本地运行

```bash
nvm use
cp .env.example .env
# 编辑 .env，至少修改 ADMIN_PASSWORD 和 SESSION_SECRET
npm install
npm run dev
```

`npm run dev` 和 `npm start` 会自动读取项目根目录的 `.env`。

`SITE_URL` 用于生成 canonical、结构化数据、Sitemap 和 AI 可读链接，部署时必须设置为公开站点地址，例如 `https://afterimage.photography`。

打开：

- 博客：<http://localhost:3000>
- 后台：使用仅管理员知晓的自定义路径（当前配置见服务端 `adminBasePath`）

若没有设置 `ADMIN_PASSWORD`，开发环境临时密码是 `change-me-now`。生产环境缺少 `ADMIN_PASSWORD` 或 `SESSION_SECRET` 时会拒绝启动，避免把默认密码暴露到公网。

## 多语言

默认站点语言菜单显示中文和英文：

```env
BLOG_LOCALES=zh,en
DEFAULT_LOCALE=zh
```

也可以扩展成：

```env
BLOG_LOCALES=zh,en,ja,fr
```

`BLOG_LOCALES` 控制前台语言菜单，Admin 编辑器则可以为文章添加任意有效语言代码，不受这个列表限制。某篇文章没有 URL 所指定的语言时，会回退到默认语言；默认语言也不存在时返回 404。

## SEO 与 AI 搜索

- 每个已发布语言版本都有独立 canonical 和 `hreflang`。
- `/sitemap.xml` 只列出已发布文章及其实际存在的语言版本。
- `/robots.txt` 允许搜索引擎抓取公开内容并声明 Sitemap。
- `/llms.txt` 提供适合 AI/Agent 发现的文章目录，`/llms-full.txt` 提供完整正文合集。
- 每篇文章同时提供纯 Markdown 地址：`/post/<语言>/<slug>.md`。
- 草稿、404 和后台页面通过 `noindex` 或 `X-Robots-Tag` 禁止索引。

## 云端部署

```bash
cp .env.example .env
# 修改 .env
docker compose up -d --build
```

数据保存在 `./data/blog.db`，升级容器时不会丢失。建议用 Caddy 或 Nginx 反向代理到 `127.0.0.1:3000`，并启用 HTTPS；使用反向代理 HTTPS 时设置 `TRUST_PROXY=1`。

Compose 只将应用端口绑定到服务器回环地址 `127.0.0.1:3000`。不要改成 `3000:3000`，否则应用端口可能绕过主机防火墙直接暴露到公网。

备份只需复制 `data/blog.db`（为了获得一致快照，建议先短暂停止容器）。
