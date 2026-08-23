# Gallery URL 与公开详情页交接

## URL 与数据库

- `galleries` 新增 `slug` 字段，后台新建和编辑时必填，规则与文章 URL 相同。
- 公开详情地址为 `GET /gallery/:slug`。
- 应用启动会检查旧数据库；缺少字段时自动执行 `ALTER TABLE`，旧记录自动使用 `gallery-记录ID`，最后创建唯一索引 `galleries_slug_unique`。
- 后台保存时继续校验 URL 格式和唯一性，列表显示完整路径，编辑页提供“查看 Gallery”链接。

手动升级前先执行 `PRAGMA table_info(galleries);`，确认没有 `slug` 后执行：

```sql
ALTER TABLE galleries ADD COLUMN slug TEXT;
UPDATE galleries SET slug = 'gallery-' || id WHERE slug IS NULL OR TRIM(slug) = '';
CREATE UNIQUE INDEX IF NOT EXISTS galleries_slug_unique ON galleries(slug);
```

## 公开详情页

- `masonry` 使用响应式 CSS 多列布局，保留图片原始比例。
- `grid` 使用后台选择的桌面/平板列数、间距、统一画幅和图片适配方式。
- `fade` 提供渐隐切换、前后按钮、计数、键盘方向键、可选缩略图和自动播放；悬停、聚焦或页面隐藏时暂停。
- `justified` 在图片加载后读取真实宽高比，根据目标行高和容器宽度计算每行图片尺寸，并支持末行左对齐、居中或填满。
- 手机端瀑布流、网格和智能拼接均回退为单列，渐隐画廊缩小控件和缩略图。
- 所有照片支持键盘访问和全屏放大浏览；页面包含封面 Open Graph、`ImageGallery` JSON-LD、canonical URL，并加入 Sitemap。

当前只实现 Gallery 详情页，没有新增 Gallery 聚合列表页。
