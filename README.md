# Afterimage Blog

一个极简的 Node.js + SQLite 多语言博客。页面结构参考现有的 AFTERIMAGE PHOTOGRAPHY，第一版只实现文章与 Admin 后台。

## 已实现

- 自定义文章 URL：`/posts/deep`、`/posts/任意-slug`
- SQLite 存储，文章与翻译分表
- 中文为默认语言；根据浏览器语言、语言 Cookie 或 `?lang=en` 呈现
- Admin 新建、编辑、发布、删除文章
- Markdown 正文，支持外链图片
- 响应式页面、明暗主题
- Docker / Docker Compose 云端部署
- 后台登录、CSRF 防护、HttpOnly Cookie

## 本地运行

```bash
cp .env.example .env
# 编辑 .env，至少修改 ADMIN_PASSWORD 和 SESSION_SECRET
npm install
npm run dev
```

打开：

- 博客：<http://localhost:3000>
- 后台：<http://localhost:3000/admin>

若没有设置 `ADMIN_PASSWORD`，开发环境临时密码是 `change-me-now`。生产环境缺少 `ADMIN_PASSWORD` 或 `SESSION_SECRET` 时会拒绝启动，避免把默认密码暴露到公网。

## 多语言

默认支持中文和英文：

```env
BLOG_LOCALES=zh,en
DEFAULT_LOCALE=zh
```

也可以扩展成：

```env
BLOG_LOCALES=zh,en,ja,fr
```

重启后 Admin 会自动显示这些语言的编辑标签。某篇文章没有当前语言时，会回退到中文。

## 云端部署

```bash
cp .env.example .env
# 修改 .env
docker compose up -d --build
```

数据保存在 `./data/blog.db`，升级容器时不会丢失。建议用 Caddy 或 Nginx 反向代理到 `127.0.0.1:3000`，并启用 HTTPS；使用反向代理 HTTPS 时设置 `TRUST_PROXY=1`。

备份只需复制 `data/blog.db`（为了获得一致快照，建议先短暂停止容器）。
