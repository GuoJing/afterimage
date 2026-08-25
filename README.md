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
- Gallery 后台管理：元数据、封面、照片上传、描述、拍摄时间与拖拽排序
- 全局导航管理，支持自定义名称、URL、排序及当前/新页面打开
- 后台用户管理：新增、编辑、封禁、0–5 会员等级及邮件密码重置
- 管理员可预览草稿，普通访客访问草稿仍返回 404
- Markdown 正文，支持外链图片和管理员本地图片上传
- 文章 canonical、hreflang、Open Graph、Twitter Card 与 BlogPosting JSON-LD
- 可索引的多语言 Topic 页面、同主题文章关联和 About 作者实体 Schema
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

会员和管理员登录状态保存在 `DATABASE_PATH` 指向的 SQLite 数据库中，Node.js 或 systemd 重启不会让尚未过期的登录状态失效。会话最长 30 天，注销会立即删除对应记录；过期记录会自动清理。会员登录页默认勾选“30 天内记住我”，取消勾选后只发送浏览器会话 Cookie，关闭浏览器即失效。`SESSION_SECRET` 必须长期保持不变，修改它会使已有 Cookie 的签名全部失效，这也是主动让所有人退出登录的方法。生产环境部署时还应保持 `DATABASE_PATH` 指向持久化磁盘，而不是临时目录。

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

## Gallery 后台

后台“Gallery 管理”支持先创建空 Gallery，再进入编辑页上传和整理照片。Gallery 包含唯一 URL 后缀、名称、发布时间、描述、作者、单张封面照片、关联文章 URL 和详情页皮肤；作者默认为 `GuoJing`。公开详情地址为 `/gallery/:slug`，例如 `/gallery/tokyo-2026`。

详情页皮肤提供四种预设，并将选择和参数保存到现有 `settings_json`：瀑布流可设置桌面/平板列数、间距和照片描述；平铺网格可设置列数、间距、统一画幅及图片适配；渐隐画廊可设置自动播放、停留/渐变时间、图片适配和缩略图导航；智能拼接可设置目标/最大行高、间距、末行对齐和照片描述。后台不再要求直接编辑 JSON。旧 Gallery 的空设置会自动使用默认瀑布流，无需数据库迁移。

照片复用现有 `IMAGE_STORAGE` 配置上传到本地目录或 DigitalOcean Spaces。后台以固定 `200px` 高度的缩略图网格展示照片，可以填写每张照片的描述和拍摄时间、拖拽调整顺序、单选封面或取消封面。上传与移除立即生效，元数据、封面和排序通过“保存 Gallery”统一保存。

关联文章通过后台文本框每行填写一个 URL，支持 `/` 开头的站内地址和完整 HTTP/HTTPS 地址，最多 20 个。服务端会校验、去重并保存到 `settings_json.relatedArticles`；前台在 Gallery 底部展示，全部使用新标签页打开。

公开列表地址为复数形式 `/galleries`，页面标题为 `Collections`；详情地址继续使用单数形式 `/gallery/:slug`，且详情标题上方不再显示额外的 Gallery 字样。旧列表地址 `/gallery` 会永久跳转到 `/galleries`。每个 Collection 自动以封面优先、照片排序靠前的规则选择最多三张预览图，并从卡片进入详情页。Collection 名称和信息显示在照片上方，每个 Collection 独占一整行，预览照片铺满与站点 Logo、Post 相同的 `1200px` 内容宽度；页面保持留白设计，不使用渐变、厚重装饰或 Hover 动效。

公开详情页会按照保存的皮肤和参数渲染照片，包含 Gallery 元数据、照片描述和拍摄时间、响应式布局、键盘可操作的渐隐切换、图片放大浏览，以及与 Post 相同的 Logo + Copyright 签名。Gallery 列表与公开详情都会加入 XML Sitemap。

旧数据库启动新版应用时会自动增加 `galleries.slug`，为旧记录生成 `gallery-记录ID`，并创建唯一索引。需要手动升级时，先用 `PRAGMA table_info(galleries);` 确认尚无 `slug` 字段，再执行：

```sql
ALTER TABLE galleries ADD COLUMN slug TEXT;
UPDATE galleries SET slug = 'gallery-' || id WHERE slug IS NULL OR TRIM(slug) = '';
CREATE UNIQUE INDEX IF NOT EXISTS galleries_slug_unique ON galleries(slug);
```

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

新上传图片的 URL 使用“原文件名语义化片段 + 短随机标识”并按年月分目录，例如 `beijing-hutong-midnight-a1b2c3d4e5f6.jpg`；既保留图片搜索可理解的文件名，也避免重名并支持长期浏览器/CDN 缓存。已有图片 URL 不会被修改。本地模式保存相对 URL；Spaces 模式保存 `SPACES_PUBLIC_URL` 下的完整 CDN URL。

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

## 邮件发送（Fastmail）

应用内置通用 SMTP 邮件模块，默认关闭，不会影响网站启动。Fastmail 标准配置使用 `smtp.fastmail.com` 的 465 端口和直接 TLS；登录账号填写完整邮箱地址，密码必须使用 Fastmail 后台生成的 App Password，不能填写日常登录密码。具体参数见 [Fastmail 官方服务器配置](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports)。

按照 [Fastmail App Password 指南](https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords)，在 `Settings → Privacy & Security → Connected apps & API tokens → Manage app passwords and access` 中新建 App Password，然后在服务器 `.env` 增加：

```env
MAIL_ENABLED=1
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
SMTP_SECURE=1
SMTP_AUTH_METHOD=PLAIN
SMTP_USER=you@example.com
SMTP_PASSWORD=your-fastmail-app-password
MAIL_FROM_ADDRESS=you@example.com
MAIL_FROM_NAME=AFTERIMAGE PHOTOGRAPHY
# MAIL_REPLY_TO=you@example.com
# 新会员注册通知收件地址；不填写时使用 ADMIN_2FA_EMAIL
MEMBER_REGISTRATION_NOTIFY_EMAIL=private-admin@example.com
```

先验证 SMTP 连接、TLS 和身份认证，不发送邮件：

```bash
npm run mail:verify
```

再向指定地址发送一封测试邮件：

```bash
npm run mail:test -- recipient@example.com
```

业务代码需要发信时，从 `lib/mailer.js` 导入 `sendMail({ to, subject, text, html, replyTo })`。发件人固定取服务端配置，调用方不能覆盖 SMTP 凭据或发件人。

[DigitalOcean 官方说明](https://docs.digitalocean.com/support/why-is-smtp-blocked/)指出 Droplet 默认封锁 25、465 和 587 出站端口。Fastmail 官方同时提供可使用任意端口的 TLS 代理；因此在 DigitalOcean 上推荐把上面的三项改为：

```env
SMTP_HOST=smtps-proxy.fastmail.com
SMTP_PORT=443
SMTP_SECURE=1
```

可先执行 `openssl s_client -connect smtps-proxy.fastmail.com:443 -servername smtps-proxy.fastmail.com -brief` 检查 TLS 连接，再运行 `npm run mail:verify` 验证身份。它是出站连接，不需要在服务器防火墙开放入站 443、465 或 587 端口。

## 后台两步登录

后台登录强制使用“管理员密码 + 邮件验证码”。验证码由服务器调用上述 SMTP 模块发送，收件地址仅存在 `.env`，不会下发到浏览器或写入页面源码：

```env
ADMIN_2FA_EMAIL=private-admin@example.com
```

必须同时正确配置 `MAIL_ENABLED=1` 及 SMTP 变量。邮件未配置完整时公开网站仍可正常运行，但后台登录会安全关闭，不会退回到仅密码登录。

登录安全规则：

- 密码正确后才发送随机 6 位数字验证码。
- 验证码只在进程内存保存 HMAC 摘要，不保存明文，10 分钟后过期。
- 验证码绑定发起登录的 IP，验证成功后立即删除，不能重复使用。
- 单个验证码最多尝试 5 次；密码尝试、验证码验证、单 IP 发信及全站发信分别由后端限流。
- 登录表单包含会话 CSRF，成功登录前后都会重新生成 Session ID。
- 前端提交后立即禁用按钮，后端触发限流时页面显示重试倒计时。
- 后台响应禁止浏览器及代理缓存，并使用 `no-referrer`，避免登录页信息进入外部请求。

验证码存放在内存中，因此重启 Node.js 服务会使所有尚未使用的验证码立即失效，这是预期行为。

## 会员登录与注册

页头提供随当前语言显示的登录入口，会员页面地址为 `/account`。默认显示登录，可切换到注册；界面及注册邮件支持中文、English、日本語。

会员可以使用邮箱或登录名登录。注册字段包括：

- 登录名：必填，只允许 3–32 位英文字母，统一按小写保存且不区分大小写。
- 邮箱：必填、唯一，用于接收注册验证码。
- 昵称：必填，最多 20 个 Unicode 字符，支持中文、英文和日文。
- 密码及确认密码：必填且必须一致；至少 12 位，同时包含大小写字母、数字和符号，并且不能包含登录名、邮箱名称或常见弱密码片段。
- 头像：可选，仅支持服务端验证后的 JPEG、PNG、WebP、AVIF，最大 1 MiB。
- 会员等级：数据库字段 `membership_level`，默认值为 `0`，留给后续文章访问等级使用。

密码使用 Node.js `scrypt`、独立随机盐和固定安全参数生成不可逆哈希，数据库不保存明文密码。不存在的账号同样执行一次 scrypt，降低通过响应耗时判断账号是否存在的风险。

注册验证码由后端通过 SMTP 发送，5 分钟失效，成功使用后立即销毁，连续错误 5 次也会销毁。验证码在内存中只保存 HMAC 摘要。前端和后端都要求至少间隔 2 分钟才能重新发送；后端同时按 IP、邮箱和全站总量限流。注册、登录提交均带会话 CSRF，并在认证成功时轮换 Session ID。

每次会员注册成功后，系统会向 `MEMBER_REGISTRATION_NOTIFY_EMAIL` 发送审核通知；未单独配置时沿用 `ADMIN_2FA_EMAIL`。邮件包含登录名、昵称、邮箱、注册时间以及仅管理员可访问的用户编辑链接，方便及时审核并封禁不合规账号。通知发送失败只会记录服务端错误，不会造成用户账号重复创建。

头像沿用 `IMAGE_STORAGE` 配置。本地存储路径为 `IMAGE_UPLOAD_DIR/IMAGE_PREFIX/avatars/年/月/文件名`；Spaces 模式使用相同 object key 并返回 CDN 地址。

登录页提供“忘记密码”入口。用户提交邮箱后，无论账号是否存在都会看到相同提示，邮件也在响应之后异步发送，降低账号枚举风险。重置链接包含 256 位安全随机 token，数据库仅保存 SHA-256 摘要；链接 30 分钟失效、只能使用一次，新申请的链接会让该账号之前尚未使用的链接失效。请求邮件及验证链接均按 IP 和邮箱限流。

密码重置继续使用与注册相同的强密码规则和 scrypt 存储。成功修改后不会自动登录，并会增加用户的 `session_version`，从而让该账号的全部旧登录会话失效；系统还会向注册邮箱发送密码已修改通知。页面及邮件支持中文、English、日本語。重置邮件地址只根据 `SITE_URL` 生成，不读取请求的 Host；生产环境必须将它设为正确的 HTTPS 站点地址。

应用启动时会自动创建 `users`、`password_reset_tokens` 表，并自动为旧 `users` 表增加 `session_version`，无需手动迁移。服务器位于反向代理后时应正确设置 `TRUST_PROXY=1` 并确保代理传递可信的客户端 IP，否则按 IP 的限流可能无法准确区分访客。

### 后台用户管理

后台侧栏的“用户管理”可以查看会员列表，新增或修改登录名、邮箱、昵称、账号状态与会员等级。等级只能从 0–5 下拉选择；状态改为“封禁”后用户不能登录，已有登录会话也会立即失效。修改邮箱同样会使旧会话和未使用的密码重置链接失效。

管理员不能读取或直接修改会员密码。新增用户时数据库写入不可登录的随机占位凭据；如果账号状态为正常，系统会自动向用户邮箱发送 30 分钟有效的一次性密码设置链接。已有用户的编辑页也可以单独触发密码重置邮件。管理员触发的发信同样按邮箱和 IP 限流，并受后台登录、CSRF 与重复提交保护。

## SEO 与 AI 搜索

- 每个已发布语言版本都有独立 canonical 和 `hreflang`。
- 首页根据语言生成独立 Title、Description 和可见的站点介绍；可以使用 `HOME_SEO_TITLE_<语言>`、`HOME_SEO_DESCRIPTION_<语言>`、`HOME_INTRO_<语言>` 覆盖默认文案。
- 首页使用 `WebSite + Organization + Person` 实体图；slug 为 `about` 的独立页面额外输出摄影师 `Person` Schema。`BLOG_AUTHOR` 配置作者名，`BLOG_SOCIAL_URLS` 可用英文逗号配置 Instagram、YouTube 等公开身份链接。
- 文章分类自动成为 `/topics/<分类-slug>` 聚合页；`/topics` 提供主题目录。Topic 页面按语言聚合文章，文章页会自动显示同分类的关联文章。
- `/sitemap.xml` 列出多语言首页、归档、Topic 目录与详情，以及已发布文章、页面和 Gallery 的 canonical URL。
- `/robots.txt` 允许搜索引擎抓取公开内容并声明 Sitemap。
- `/llms.txt` 提供适合 AI/Agent 发现的文章、页面、摄影合集和 Topic 目录，`/llms-full.txt` 提供完整正文合集。
- 每篇文章同时提供纯 Markdown 地址：`/post/<语言>/<slug>.md`。
- 每个页面同时提供纯 Markdown 地址：`/page/<语言>/<slug>.md`。
- 每个 Gallery 同时提供包含照片 URL、说明和拍摄时间的 Markdown 地址：`/gallery/<slug>.md`。
- 文章作者和分类均为可抓取的内部链接；文章 JSON-LD 包含作者 About URL，Open Graph 包含作者、分类和图片替代文字。
- Markdown 正文确保图片存在 alt；没有填写时从图片文件名生成安全后备文本。首张正文或 Gallery 图片使用 eager + high priority，其余图片 lazy load 并异步解码。
- 草稿、404 和后台页面通过 `noindex` 或 `X-Robots-Tag` 禁止索引。

自动生成的 Topic 不需要数据库升级：继续在文章后台填写现有“分类”字符串即可。建议使用稳定、具体的分类名称，例如 `Street Photography`、`Photography History`，同一主题保持拼写一致。

## 云端部署

```bash
cp .env.example .env
# 修改 .env
docker compose up -d --build
```

数据保存在 `./data/blog.db`，升级容器时不会丢失。建议用 Caddy 或 Nginx 反向代理到 `127.0.0.1:3000`，并启用 HTTPS；使用反向代理 HTTPS 时设置 `TRUST_PROXY=1`。

Compose 只将应用端口绑定到服务器回环地址 `127.0.0.1:3000`。不要改成 `3000:3000`，否则应用端口可能绕过主机防火墙直接暴露到公网。

本地存储模式备份需要同时保存 `data/blog.db` 和 `data/uploads`（为了获得一致快照，建议先短暂停止服务）。Spaces 本身不等同于备份，如需独立备份应定期同步 bucket。
