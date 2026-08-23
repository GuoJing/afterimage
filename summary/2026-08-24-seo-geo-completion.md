# SEO / GEO 功能补全

## 已补全

- 首页按中文、英文、日文生成独立搜索标题、摘要及 initial HTML 中可见的站点介绍。
- 首页 JSON-LD 建立 `WebSite → Organization → Person` 实体关系；About 页面输出 `Person + WebPage + Organization` 图谱，并支持通过 `BLOG_SOCIAL_URLS` 配置 `sameAs`。
- 文章及 Gallery 详情作者链接到当前语言 About 页面，分类链接到可索引 Topic 页面；文章 JSON-LD 和 Open Graph 同步增加作者、分类与图片语义。Collections 列表因整张卡片已经是详情链接，作者保持为纯文本，避免嵌套链接破坏 HTML 结构。
- 新增 `/topics` 和 `/topics/:slug`。Topic 由现有文章 `category` 自动生成，支持语言选择、canonical、hreflang、CollectionPage/ItemList JSON-LD 和空状态。
- 文章详情按当前语言和相同分类自动展示最多 4 篇关联内容，形成可抓取的语义内链。
- Sitemap 补齐各语言首页、Topic 目录和 Topic 详情；`llms.txt` 补充摄影合集及 Topic 入口。
- 每个 Gallery 新增 `/gallery/:slug.md`，输出合集元数据、照片 URL、alt/说明与拍摄时间；`llms.txt` 直接链接 Markdown 版本，`llms-full.txt` 收录完整 Gallery 内容。
- 新上传图片使用原文件名的 SEO 友好片段加短随机标识；正文缺失 alt 时从文件名生成后备文本。
- 首张正文、Gallery 或 Collection 图片使用 `loading=eager` 和 `fetchpriority=high`，其余图片 lazy load，全部异步解码。
- Twitter Card 改为大图卡片，Open Graph/Twitter 图片均包含替代文字。

## 不自动生成的内容

- 不改写文章导言、标题层级、结论、可引用观点和 References；这些属于作者内容，应在后台按文章实际内容编辑。
- 不虚构 Instagram、YouTube、出版、展览或奖项。真实社交链接通过 `BLOG_SOCIAL_URLS` 配置，履历应写入 About 页面。
- 暂不自动生成多尺寸 WebP/AVIF `srcset`，因为这需要确定生产端原图保留、裁切质量、存储成本与旧图迁移策略；现阶段先完成首图优先级、延迟加载、语义文件名和 alt。

本次修改不新增数据库字段，不需要 SQLite 升级语句。
