# Gallery 后台管理交接

## 已实现

- 新增 `galleries` 与 `gallery_photos` 两张 SQLite 表，应用启动时自动创建。
- Gallery 元数据包括名称、描述、作者、发布时间、单张封面照片和 `settings_json` 扩展设置。
- Gallery 发布时间和照片拍摄时间保留后台输入的本地日期时间，不会因服务器时区转换而在重新编辑时偏移。
- 作者默认为 `GuoJing`，设置默认为 `{}`；设置保存前必须是合法 JSON 对象。
- 后台侧边栏新增“Gallery 管理”，支持列表、新建、编辑和删除。
- 新建流程先创建空 Gallery，再进入编辑页上传照片。
- 照片继续复用现有 Local / DigitalOcean Spaces 图片存储与文件签名校验。
- 后台照片使用 `200px` 高缩略图网格，支持多选上传、照片描述、拍摄时间、拖拽排序、单选封面、取消封面及移除照片。
- 上传和移除照片立即写入数据库；Gallery 元数据、照片描述、拍摄时间、排序和封面点击“保存 Gallery”后统一保存。
- 删除封面照片时会自动清空 Gallery 的封面关联；删除 Gallery 会级联删除照片数据库记录。
- 当前没有新增任何公开 Gallery 路由，前台将在后续功能中单独实现。

## 后台路由

- 列表：`GET /qiajigou/galleries`
- 新建：`GET /qiajigou/galleries/new`
- 创建：`POST /qiajigou/galleries`
- 编辑：`GET /qiajigou/galleries/:id/edit`
- 保存：`POST /qiajigou/galleries/:id`
- 删除：`POST /qiajigou/galleries/:id/delete`
- 上传照片：`POST /qiajigou/galleries/:id/photos`
- 移除照片：`POST /qiajigou/galleries/:galleryId/photos/:photoId/delete`

所有后台路由继续使用管理员 Session 与 CSRF 校验。

## SQLite 手动升级语句

新版应用启动时会自动建表；如需在部署前手动升级，可以执行：

```sql
CREATE TABLE IF NOT EXISTS galleries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'GuoJing',
  published_at TEXT NOT NULL,
  cover_photo_id INTEGER,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gallery_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  taken_at TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS gallery_photos_gallery_position
ON gallery_photos(gallery_id, position, id);
```

升级前仍建议备份 `data/blog.db`；本地图片模式同时备份 `data/uploads`。
