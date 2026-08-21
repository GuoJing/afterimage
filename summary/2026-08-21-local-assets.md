# 前端本地资源检查

日期：2026-08-21

## 检查结论

- 站点业务 CSS 使用本地 `/style.css`。
- 站点业务 JavaScript 使用本地 `/app.js`。
- favicon 与 Apple Touch Icon 均位于本地 `public` 目录。
- 原先唯一的运行时第三方样式依赖是 Google Fonts 的 Source Sans 3，现已改为本地托管。
- 页面不再从参考站、Typlog、Google Fonts 或其他第三方加载 CSS、JavaScript、字体、favicon。

## 本地字体

- `public/fonts/source-sans-3-latin.woff2`
- `public/fonts/source-sans-3-latin-ext.woff2`
- `public/fonts/OFL.txt`

字体通过 `public/style.css` 中的本地 `@font-face` 加载，保留了原有 Source Sans 3 的视觉，并使用 `font-display: swap`。中文及其他未包含字符继续使用系统字体回退，不会访问第三方字体服务。

## 保留的外部 URL 类型

以下 URL 不属于外部样式或脚本依赖：

- canonical、hreflang、Open Graph、Sitemap 和 llms.txt 中的本站绝对 URL。
- JSON-LD 中的 `https://schema.org` 上下文标识；它只是结构化数据命名空间，浏览器不会把它当作脚本或样式加载。
- 管理员在 Markdown 正文中主动添加的外链图片。外链图片仍由图片来源网站提供；如需完全离线或完全自主托管，后续应增加图片上传并存储到本地/自有对象存储。

## 后续检查方法

运行以下搜索时，模板和静态资源中不应再出现第三方 CSS、JS 或字体地址：

```bash
rg -n "https?://|@import|url\\(" views public
```

允许出现的结果应仅为动态 SEO 数据，不应出现在 `script src`、样式表 `link href`、CSS `@import` 或字体 `url()` 中。
