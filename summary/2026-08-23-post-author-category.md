# 文章作者与分类交接

## 已实现

- `posts` 表新增文章级 `author` 与 `category` 字段，不随语言翻译重复。
- 作者为空时保存为 `GuoJing`；分类为空时保存为空字符串。
- 应用启动会检测旧数据库字段并自动执行兼容迁移，新数据库则直接使用完整表结构。
- 后台文章设置栏可以编辑作者和分类，两个字段均限制为最多 100 个字符。
- 首页文章列表和文章详情页显示发布日期、作者及非空分类；空分类不会留下占位或分隔符。文章详情页采用语言无关的“日期 · 作者值 · 分类值”形式，不显示“作者”“分类”标签。
- 文章详情页的版权署名和 BlogPosting JSON-LD 使用文章作者。
- 文章 Markdown 输出包含作者，并在分类非空时包含分类。

## SQLite 手动升级语句

仅在旧数据库的 `posts` 表尚无对应字段时执行一次：

```sql
ALTER TABLE posts ADD COLUMN author TEXT NOT NULL DEFAULT 'GuoJing';
ALTER TABLE posts ADD COLUMN category TEXT NOT NULL DEFAULT '';
```

SQLite 的 `ADD COLUMN` 不支持在所有部署版本中可靠使用 `IF NOT EXISTS`。重复执行会报字段已存在，因此升级前可以先运行：

```sql
PRAGMA table_info(posts);
```

已有文章会自动得到作者 `GuoJing` 和空分类。
