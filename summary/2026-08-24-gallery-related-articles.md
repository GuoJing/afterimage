# Gallery 对齐、关联文章与签名

- Gallery 公开详情的最大宽度从 `1800px` 调整为 `1200px`，与 `.head-inner`、Post 内容及 Logo 左右边界一致；移动端保持 `16px` 页面留白。
- Gallery 后台基本信息区新增“关联文章 URL”，每行一个，最多 20 个。
- 支持 `/` 开头的站内地址和完整 HTTP/HTTPS 地址；拒绝 `javascript:`、协议相对地址、带账号密码的绝对地址、控制字符和超长 URL。
- 保存时去除空行并按首次出现顺序去重，数据位于已有 `settings_json.relatedArticles`，不新增 SQLite 字段，不需要数据库升级。
- 前台仅在有关联文章时显示 `RELATED` 列表，每个链接都带 `target="_blank" rel="noopener noreferrer"`。
- Gallery 页面底部使用 Post 同款 `.article-signature`，显示站点 Logo 和 `Copyright by 作者`。
