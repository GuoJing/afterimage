# 全局导航管理交接

日期：2026-08-21

## 已实现

- 新增 `navigation_items` SQLite 表，应用启动时自动创建，无需手动迁移。
- 后台侧边栏新增“导航管理”。
- 管理员可以新增、编辑、排序和删除导航。
- 每个导航包含名称、URL、打开方式和排序数字。
- URL 支持 `/` 开头的站内地址、`#` 锚点及完整 HTTP/HTTPS 地址。
- `javascript:`、协议相对地址、控制字符和其他不安全 URL 会被拒绝。
- 打开方式支持当前页面和新页面；新页面链接输出 `target="_blank" rel="noopener noreferrer"`。
- 全局导航位于站点标题栏下方、首页/文章/页面正文上方。
- 当前页面对应的站内导航会显示活动状态。
- 导航在所有公开页面显示，后台页面不显示。
- 桌面端保持 1200px 内容宽度；移动端支持横向滚动，不挤压或换行导航名称。

## 后台路由

- 列表与新增：`GET /qiajigou/navigation`
- 创建：`POST /qiajigou/navigation`
- 编辑：`GET /qiajigou/navigation/:id/edit`
- 保存：`POST /qiajigou/navigation/:id`
- 删除：`POST /qiajigou/navigation/:id/delete`

所有写操作继续使用管理员 Session 与 CSRF 校验。

## 排序规则

导航按照 `position ASC, id ASC` 排列。数字越小越靠前；排序数字相同时，较早创建的项目靠前。
