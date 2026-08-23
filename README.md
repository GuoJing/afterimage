# Afterimage Blog

一个极简的 Node.js + SQLite 多语言博客。页面结构参考现有的 AFTERIMAGE PHOTOGRAPHY，包含文章、独立页面与 Admin 后台。

运行环境要求 Node.js 22.12 或更高版本。

## 已实现

- 带语言的文章 URL：`/post/zh/deep`、`/post/en/deep`
- 带语言的页面 URL：`/page/zh/about`、`/page/en/about`
- 多语言文章归档：`/archive`、`/archive?lang=en`
- 多语言 RSS：`/feed.xml`、`/feed.xml?lang=en`
- SQLite 存储，文章、页面及各自翻译分表
- 中文为默认语言；内容 URL 明确包含语言，缺少该语言翻译时回退到默认语言
- Admin 新建、编辑、发布、删除文章
- 文章级作者与分类；作者默认 `GuoJing`，分类可以留空
- Admin 新建、编辑、发布、删除独立页面
- 全局导航管理，支持自定义名称、URL、排序及当前/新页面打开
- 管理员可预览草稿，普通访客访问草稿仍返回 404
- Markdown 正文，支持外链图片和管理员本地图片上传
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

默认站点语言菜单显示中文、English 和日本語；每种语言使用自己的语言名称展示：

```env
BLOG_LOCALES=zh,en,ja
DEFAULT_LOCALE=zh
```

也可以扩展成：

```env
BLOG_LOCALES=zh,en,ja,fr
```

`BLOG_LOCALES` 控制前台语言菜单，Admin 编辑器则可以为文章或页面添加任意有效语言代码，不受这个列表限制。菜单使用每种语言自己的名称，例如 `中文`、`English`、`日本語`、`français`。内容没有 URL 所指定的语言时，会回退到默认语言；默认语言也不存在时返回 404。

用户通过全站菜单或内容页语言按钮明确选择语言后，站点会记住该偏好。公开 HTML 页面按照“用户已选语言 → URL 指定语言 → `DEFAULT_LOCALE`”的优先级显示；如果访问的文章、页面、首页或归档 URL 与已选语言不同，会临时重定向到所选语言的对应地址。RSS、Markdown、Sitemap 和 llms.txt 等机器读取端点仍严格使用 URL 指定的语言。

## 独立页面

后台的“页面管理”使用与文章相同的多语言 Markdown 编辑器、图片上传、草稿预览和发布逻辑。页面地址固定为：

```text
/page/<语言>/<slug>
```

例如 `/page/zh/about` 与 `/page/en/about` 属于同一个页面的两个语言版本。页面不会出现在首页文章列表中，但已发布页面会进入 Sitemap、llms.txt 和 llms-full.txt，并提供对应的 `.md` 版本。

## 全局导航

后台“导航管理”可以新增、编辑、排序和删除全站导航。每个导航包含：

- 导航名称
- URL：支持 `/` 开头的站内地址、`#` 锚点和完整 HTTP/HTTPS 地址
- 打开方式：当前页面或新页面
- 排序：数字越小越靠前

导航显示在站点标题栏下方、文章或页面正文上方。新页面打开的链接自动附带 `noopener noreferrer`，服务端会拒绝 `javascript:` 等不安全 URL。

文章和独立页面的导航活动状态会忽略 URL 中的语言段。例如导航配置为 `/page/en/about` 时，访问 `/page/zh/about`、`/page/ja/about` 等同一页面的其他语言版本仍会高亮该导航；文章与页面按类型分别匹配，不会因 slug 相同而互相误判。

## 文章归档与 RSS

`/archive` 按发布时间倒序列出中文文章，只显示日期、标题和纯文字摘要，不显示正文图片。通过 `lang` 参数可以查看其他语言版本，例如 `/archive?lang=en` 与 `/archive?lang=ja`。归档只展示实际存在该语言翻译的已发布文章。

RSS 使用相同的语言规则：`/feed.xml` 默认为中文，`/feed.xml?lang=en` 与 `/feed.xml?lang=ja` 分别输出对应语言。每个公开页面的 HTML 都包含当前语言 RSS 的自动发现链接。

## 图片上传

后台 Markdown 编辑器支持选择、拖拽和粘贴图片。上传成功后会在光标位置自动插入图片 URL，例如：

```markdown
![photo](/uploads/library/2026/08/uuid.webp)
```

本地图片存储配置：

```env
IMAGE_STORAGE=local
IMAGE_PREFIX=library
IMAGE_UPLOAD_DIR=/opt/afterimage/data/uploads
IMAGE_PUBLIC_PATH=/uploads
IMAGE_MAX_SIZE_MB=15
```

`IMAGE_PREFIX` 是当前部署使用的任意目录命名，不需要写成 `test` 或 `prod`。例如两套部署可以分别使用 `library`、`archive`；本地文件会保存到 `IMAGE_UPLOAD_DIR/IMAGE_PREFIX/年/月/文件名`。它允许字母、数字、点、下划线、连字符和多级目录。

`IMAGE_UPLOAD_DIR` 可以省略，默认使用项目中的 `data/uploads`。生产服务器推荐配置绝对路径，并确保运行 Node.js 的用户对目录有写权限。

DigitalOcean Spaces + CDN 配置：

```env
IMAGE_STORAGE=spaces
IMAGE_PREFIX=library
IMAGE_MAX_SIZE_MB=15
SPACES_REGION=sgp1
SPACES_BUCKET=your-space-name
SPACES_ENDPOINT=https://sgp1.digitaloceanspaces.com
SPACES_PUBLIC_URL=https://your-space-name.sgp1.cdn.digitaloceanspaces.com
SPACES_ACCESS_KEY=your-limited-access-key
SPACES_SECRET_KEY=your-secret-key
```

Spaces 中的 object key 同样是 `IMAGE_PREFIX/年/月/文件名`。`SPACES_PUBLIC_URL` 可以使用 DigitalOcean 提供的 CDN endpoint，也可以填写已配置证书的自定义 CDN 域名。Access Key 应限制到目标 bucket，并授予 Read/Write/Delete 权限；密钥只保存在 `.env`，不要提交到 Git。

当前支持 JPEG、PNG、WebP、GIF 和 AVIF；服务端根据文件实际内容判断类型，不接受 SVG 或只修改扩展名的伪图片。

图片 URL 使用随机文件名并按年月分目录，可以安全设置长期浏览器/CDN 缓存。本地模式保存相对 URL；Spaces 模式保存 `SPACES_PUBLIC_URL` 下的完整 CDN URL。

图片排版由 Markdown 中是否换行决定。同一行的图片会尽量并排显示：

```markdown
![left](/uploads/example-left.jpg) ![right](/uploads/example-right.jpg)
```

图片之间按回车则上下排列：

```markdown
![top](/uploads/example-top.jpg)
![bottom](/uploads/example-bottom.jpg)
```

在首页、文章详情、独立页面和后台 Markdown 预览中，单张纯图片都会铺满正文的可用宽度；同一行的多张图片会共同平分这一宽度。图片灯箱仍按原始比例和自动尺寸展示，不会强制放大小图。

文章详情页中的正文图片可点击放大；灯箱使用半透明黑色背景，可点击右上角关闭按钮、遮罩空白区域或按 `Esc` 关闭。大图最大为视口宽度的 80% 和视口高度的 86%，小图不会被强制放大。

## SEO 与 AI 搜索

- 每个已发布语言版本都有独立 canonical 和 `hreflang`。
- `/sitemap.xml` 列出多语言归档，以及已发布文章、页面的实际语言版本。
- `/robots.txt` 允许搜索引擎抓取公开内容并声明 Sitemap。
- `/llms.txt` 提供适合 AI/Agent 发现的文章与页面目录，`/llms-full.txt` 提供完整正文合集。
- 每篇文章同时提供纯 Markdown 地址：`/post/<语言>/<slug>.md`。
- 每个页面同时提供纯 Markdown 地址：`/page/<语言>/<slug>.md`。
- 草稿、404 和后台页面通过 `noindex` 或 `X-Robots-Tag` 禁止索引。

## 云端部署

```bash
cp .env.example .env
# 修改 .env
docker compose up -d --build
```

数据保存在 `./data/blog.db`，升级容器时不会丢失。建议用 Caddy 或 Nginx 反向代理到 `127.0.0.1:3000`，并启用 HTTPS；使用反向代理 HTTPS 时设置 `TRUST_PROXY=1`。

Compose 只将应用端口绑定到服务器回环地址 `127.0.0.1:3000`。不要改成 `3000:3000`，否则应用端口可能绕过主机防火墙直接暴露到公网。

本地存储模式备份需要同时保存 `data/blog.db` 和 `data/uploads`（为了获得一致快照，建议先短暂停止服务）。Spaces 本身不等同于备份，如需独立备份应定期同步 bucket。
