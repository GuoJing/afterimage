# 图片上传功能总结

## 已实现

- 后台文章 Markdown 编辑器支持点击选择、拖拽和从剪贴板粘贴图片。
- 上传成功后在当前光标位置插入 Markdown 相对地址，并触发现有实时预览。
- 上传接口为 `POST /qiajigou/uploads/images`，仅已登录管理员可用，并要求 `X-CSRF-Token`。
- 服务端使用文件签名识别 JPEG、PNG、WebP、GIF、AVIF；SVG 和伪装图片会返回 415。
- 图片采用 UUID 文件名，使用自定义 `IMAGE_PREFIX` 并按 UTC 年/月保存。
- `/uploads` 静态响应包含 `nosniff`，随机 URL 使用一年 immutable 缓存。
- `IMAGE_STORAGE=local` 保存到 Droplet 文件系统；`IMAGE_STORAGE=spaces` 通过 S3 API 上传到 DigitalOcean Spaces，并返回 CDN URL。
- Spaces 使用 `@aws-sdk/client-s3`，上传请求本身使用原始图片请求体，不需要 multipart 中间件。
- Markdown 同一源码行内的纯图片会渲染为 `.image-row` 横向组；源码换行会拆成多个纵向 row。后台预览和文章详情共用该渲染逻辑。
- 图片组和组内图片的桌面端间距统一为 8px，移动端为 6px；整组上下边距为 12px，避免摄影文章出现过大的纵向留白。
- 首页、文章详情、独立页面和后台 Markdown 预览中的单张纯图片都会铺满正文可用宽度，不再按原始像素宽度缩在中间；同一行多图仍共同平分可用宽度，灯箱继续使用图片原始自动尺寸。
- 后台 Markdown 输入区使用弹性布局，会跟随右侧长预览自动拉高，避免预览内容很多时左侧输入框提前结束。
- 文章详情正文图片带可访问的点击/键盘入口，动态灯箱支持半透明黑色遮罩、右上角关闭、遮罩点击和 `Esc`，并锁定背景滚动。
- 多图灯箱提供上一张、下一张和当前位置提示，点击两侧按钮或按键盘 `←` / `→` 均可循环浏览；关闭按钮改为较小且几何居中的 CSS 图标。
- 灯箱图片使用 `max-width: 80vw`、`max-height: 86vh` 和原始自动尺寸，因此不会把小图片强制放大。
- 前台明暗主题按钮现在以滑块位置、高亮太阳/月亮和动态辅助文案明确展示当前模式；首次访问会解析系统偏好并保存后续手动选择。
- 后台摘要字段位于各语言版本自己的编辑面板中，和该语言的标题、正文一起保存；右侧设置栏只保留文章级状态、发布日期与操作。文章页的 meta description、Open Graph、Twitter Card、JSON-LD 和文章列表继续使用实际渲染语言的摘要。

## 验证记录

- Node.js 22 本地服务与临时 SQLite 数据库验证通过。
- 两张同一 Markdown 源码行的图片保持同排；换行图片保持独立行，浏览器计算后的图片间距为 8px。
- 图片灯箱的点击、关闭按钮、遮罩关闭和 `Esc` 已验证。
- 长图片预览场景下，Markdown 输入区和预览区浏览器实测均为 637px 高。
- 明暗模式切换后，根节点主题、按钮状态、提示文案和滑块位置同步变化。

## 环境变量

```env
IMAGE_STORAGE=local
IMAGE_PREFIX=library
IMAGE_UPLOAD_DIR=/opt/afterimage/data/uploads
IMAGE_PUBLIC_PATH=/uploads
IMAGE_MAX_SIZE_MB=15
```

`IMAGE_UPLOAD_DIR` 未配置时默认为项目根目录下的 `data/uploads`。本地保存路径及 URL 都包含 `IMAGE_PREFIX/年/月`。`IMAGE_MAX_SIZE_MB` 允许 1–50 MB。

Spaces 配置：

```env
IMAGE_STORAGE=spaces
IMAGE_PREFIX=library
SPACES_REGION=sgp1
SPACES_BUCKET=your-space-name
SPACES_ENDPOINT=https://sgp1.digitaloceanspaces.com
SPACES_PUBLIC_URL=https://your-space-name.sgp1.cdn.digitaloceanspaces.com
SPACES_ACCESS_KEY=your-limited-access-key
SPACES_SECRET_KEY=your-secret-key
```

上传对象公开读取，设置 `Content-Type`、`Content-Disposition: inline` 和一年 immutable 缓存。S3 客户端关闭非必需 checksum 计算，并依照 DigitalOcean 官方 SDK 示例使用 `us-east-1` 作为签名 region；`SPACES_REGION` 用于组成实际 endpoint。`SPACES_PUBLIC_URL` 不参与签名，可使用 DigitalOcean CDN endpoint 或自定义 CDN 域名。

## Debian 部署更新

```bash
mkdir -p /opt/afterimage/data/uploads
chown -R afterimage:afterimage /opt/afterimage/data
systemctl restart afterimage
```

本地模式备份时必须同时包含 SQLite 数据库与 `data/uploads`。Spaces 不提供独立备份保证，需要按需同步到另一个 bucket 或本地。切换存储不会自动迁移旧图片；旧 URL 必须继续可访问，或批量更新文章正文。
