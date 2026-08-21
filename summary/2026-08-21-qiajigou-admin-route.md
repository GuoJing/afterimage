# 后台隐藏路径迁移交接

日期：2026-08-21

## 本次目标

- 前台页面不再提供任何后台入口。
- 后台 URL 前缀由 `/admin` 改为 `/qiajigou`。
- 不兼容旧路径；访问 `/admin` 应返回 404。

## 已完成

- `server.js` 使用单一常量 `adminBasePath = '/qiajigou'` 管理后台前缀。
- 登录、退出、文章列表、新建、编辑、删除和 Markdown 预览路由全部迁移到 `/qiajigou`。
- `adminBasePath` 通过 EJS locals 注入后台模板，模板不再写死 `/admin`。
- 前台 footer 删除了 `Admin` 链接，只保留站点名称。
- 公共 `public/app.js` 不包含 `/qiajigou` 字符串；预览地址由登录后的编辑表单通过 `data-preview-url` 提供。
- README 不直接公开具体后台 URL，只提示从服务端 `adminBasePath` 查看。

## 当前后台路由

- 登录：`GET/POST /qiajigou/login`
- 首页：`GET /qiajigou`
- 退出：`POST /qiajigou/logout`
- 新建页：`GET /qiajigou/posts/new`
- 新建保存：`POST /qiajigou/posts`
- 编辑页：`GET /qiajigou/posts/:id/edit`
- 编辑保存：`POST /qiajigou/posts/:id`
- 删除：`POST /qiajigou/posts/:id/delete`
- Markdown 预览：`POST /qiajigou/preview`

## 验证结果

使用 Node.js 22.23.2 和临时 SQLite 数据库进行验证：

- `GET /admin`：404
- `GET /qiajigou`（未登录）：302 到 `/qiajigou/login?next=%2Fqiajigou`
- `POST /qiajigou/login`：302 到 `/qiajigou`
- 登录后 `GET /qiajigou`：200
- 登录后 `GET /qiajigou/posts/new`：200
- 前台首页 footer 中没有后台链接或隐藏路径。
- 后台页面生成的链接、表单 action 和预览地址均为 `/qiajigou` 前缀。

## 后续注意

- 隐藏路径只能减少普通扫描噪音，不能替代密码、Session、CSRF 和 HTTPS；现有鉴权与 CSRF 保护必须保留。
- 若以后再次更换后台路径，只需修改 `server.js` 顶部的 `adminBasePath`，后台模板会自动使用新值。
- 工作区中还有此前博客多语言、草稿预览和后台编辑器相关的未提交修改，后续 agent 不要覆盖或回退这些改动。
