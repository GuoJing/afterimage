# Gallery 公开列表页

- 新增公开列表地址 `GET /galleries`，以发布时间倒序列出全部 Gallery，并可从整张卡片进入单数形式的 `/gallery/:slug` 详情页；旧列表地址 `/gallery` 以 301 跳转到 `/galleries`。
- 每张列表卡片自动选择最多三张照片：封面优先，其余按照后台拖拽保存的照片顺序补齐；无照片时显示克制的空状态。
- 页面标题统一为 `Collections`，Gallery 详情标题上方不再显示额外的 `GALLERY` 字样。
- 页面内容最大宽度为 `1200px`，与页头 Logo、导航和 Gallery 详情页左右边界一致。
- 每个 Collection 的名称、元数据和描述位于照片上方；每项独占一整行，最多三张预览照片铺满完整内容宽度。预览区采用细边框和充足留白，不使用渐变或 Hover 动效。
- Gallery 导航配置为 `/galleries` 时，列表页和任意 `/gallery/:slug` 详情页都会保持选中状态；旧的 `/gallery` 导航配置也继续兼容。切换语言时 Gallery 路径保持不变。
- 列表页包含 canonical、Open Graph、`CollectionPage` + `ItemList` JSON-LD，并已加入 `/sitemap.xml`。
- 本功能复用现有 `galleries` 与 `gallery_photos` 数据，不需要 SQLite 升级语句。
