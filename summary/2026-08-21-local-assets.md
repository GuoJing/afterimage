# 前端本地资源检查

> 后续字体更新：CSS 已按原站恢复 `en-sans / sys-sans / cjk-sans / sys-serif / mono / font-base / font-text` 分层。页面外层文本与文章标题使用 `Source Sans Pro` 优先、项目内置 `Source Sans 3` 作为本地替代；文章正文使用系统字体和 CJK 字体链；不加载任何外站字体资源。

> 旧站精确复核：根据 `afterimage.typlog.io/posts/deep` 使用的 Meguro 0.5.0 与 Yue 1.0.0 CSS，文章标题继承 `Source Sans Pro` 文本字体链，但 `.e-content.yue` 正文会切回系统/CJK 基础字体链。图片组上下边距为 `1.64em`，组内图片通过两侧 `3px` padding 形成 `6px` 间距，连续 gallery 使用 `margin-top:-1.5em` 压缩纵向空白。本项目已用本地 `.image-stack/.image-row` 等价实现，并同步中文强调、标题层级、引用、列表和图注规则；没有引用 Typlog 的 CSS、JS 或字体资源。

> 字重修正：旧站公共 CSS 对 `body` 使用 `text-rendering: optimizeLegibility`、WebKit antialiasing 和 Firefox grayscale；本项目现已同步。文章标题从错误的 `900` 调整为旧站实际呈现的 `700`，正文保持默认 `400`，只有 Logo 继续使用旧站规定的 `900`。

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
