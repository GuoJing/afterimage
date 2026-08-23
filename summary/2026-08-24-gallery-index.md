# Gallery 公开列表页

- 新增公开地址 `GET /gallery`，以发布时间倒序列出全部 Gallery，并可从整张卡片进入 `/gallery/:slug` 详情页。
- 每张列表卡片自动选择最多三张照片：封面优先，其余按照后台拖拽保存的照片顺序补齐；无照片时显示克制的空状态。
- 页面内容最大宽度为 `1200px`，与页头 Logo、导航和 Gallery 详情页左右边界一致。
- 桌面端使用双列布局，移动端切换为单列；预览区采用细边框、充足留白和轻微悬停反馈，不使用渐变。
- Gallery 导航配置为 `/gallery` 时，列表页和任意详情页都会保持选中状态；切换语言时 Gallery 路径保持不变。
- 列表页包含 canonical、Open Graph、`CollectionPage` + `ItemList` JSON-LD，并已加入 `/sitemap.xml`。
- 本功能复用现有 `galleries` 与 `gallery_photos` 数据，不需要 SQLite 升级语句。
