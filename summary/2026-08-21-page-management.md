# 多语言页面管理交接

日期：2026-08-21

## 已实现

- 新增独立 `pages` 与 `page_translations` 数据表，不与文章数据混用。
- 页面支持草稿、发布、自定义 slug，以及任意数量的语言版本。
- 公开页面路由为 `/page/<language>/<slug>`，例如 `/page/zh/about`。
- 请求语言不存在时回退默认语言；默认语言也不存在时返回 404。
- 管理员可以预览草稿，普通访客访问草稿返回 404。
- 后台侧边栏新增“页面管理”，包含列表、新建、编辑、发布和删除。
- 页面编辑器复用文章的 Markdown 预览、图片选择、拖拽、粘贴上传与多语言标签交互。
- 页面输出 canonical、hreflang、Open Graph、WebPage JSON-LD 和实际渲染语言。
- 已发布页面会进入 `/sitemap.xml`、`/llms.txt` 和 `/llms-full.txt`。
- 每个已发布页面语言版本提供 `/page/<language>/<slug>.md` 纯 Markdown 输出。
- 页面语言选择器与站点语言菜单都保持当前页面 slug，不会跳回首页。

## 后台路由

- 列表：`GET /qiajigou/pages`
- 新建：`GET /qiajigou/pages/new`
- 创建：`POST /qiajigou/pages`
- 编辑：`GET /qiajigou/pages/:id/edit`
- 保存：`POST /qiajigou/pages/:id`
- 删除：`POST /qiajigou/pages/:id/delete`

所有写操作继续使用管理员 Session 和 CSRF 校验。

## 数据与部署

- 数据仍保存在现有 SQLite 文件，无需单独执行迁移命令；应用启动时会自动创建新表。
- 页面正文图片沿用当前 `IMAGE_STORAGE` 配置，本地与 DigitalOcean Spaces 均可使用。
- 页面与文章允许使用相同 slug，因为它们分别位于 `/page/` 和 `/post/` 路由空间。
