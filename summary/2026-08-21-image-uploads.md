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
