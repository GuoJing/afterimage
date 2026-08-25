# 会员登录注册功能总结

## 功能范围

- 页头新增会员入口，未登录时按当前语言显示 `登录`、`Login`、`ログイン`；登录后显示昵称。
- `/account` 默认显示登录，同页可切换注册，支持中文、英文、日文。
- 支持使用邮箱或登录名登录。
- 注册成功后自动建立会员会话；会员中心显示登录名与会员等级。
- 退出会员登录只移除会员身份，不影响同一浏览器中可能存在的管理员会话。
- 会员和管理员共用 SQLite 持久化 Session Store；进程或 systemd 重启后，只要 Cookie 未过期且 `SESSION_SECRET` 没有改变，登录状态会继续有效。

## 用户数据

应用启动时自动执行：

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  nickname TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  membership_level INTEGER NOT NULL DEFAULT 0 CHECK (membership_level >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

已有部署只需更新代码并重启，服务会自动建表。也可以在停止服务并备份数据库后，用下面方式手动执行：

```bash
sqlite3 /opt/afterimage/data/blog.db
```

进入 SQLite 后粘贴上述 SQL，执行 `.schema users` 检查，再输入 `.quit`。

`membership_level` 默认是 `0`，本次只保留字段，尚未对文章设置阅读等级。

## 密码安全

- 登录名只允许 3–32 位英文字母，标准化为小写。
- 密码至少 12 位，必须包含大小写字母、数字与符号，不能包含登录名、邮箱名称或常见弱密码片段。
- 两次密码输入必须完全一致。
- 使用异步 `scrypt`，参数为 `N=32768, r=8, p=1`，每个密码使用 16 字节随机盐，输出 64 字节哈希。
- 登录失败统一返回相同提示；账号不存在时仍执行一次 scrypt，降低时序枚举风险。
- 登录按 IP 与登录标识分别限流，成功登录时轮换 Session ID。

## 注册验证码

- 后端通过现有 `sendMail()` SMTP 模块发送，邮件内容按中文、英文、日文生成。
- 随机 6 位数字，5 分钟有效，内存中只保存 HMAC 摘要。
- 验证码与标准化邮箱及当前 Session 关联；成功后只能使用一次，错误 5 次后销毁。
- 同一 IP 或邮箱至少间隔 2 分钟才能发送；每小时单 IP 3 次、单邮箱 3 次、全站 30 次。
- 验证尝试和注册提交另有 IP 限流。
- 前端使用按钮锁定、倒计时和 localStorage 避免重复点击；后端限流是最终安全边界。

## 头像

- multipart 请求使用 Multer 内存存储，单文件硬限制 1 MiB。
- 不信任扩展名或浏览器 MIME，服务端检查实际文件签名。
- 仅允许 JPEG、PNG、WebP、AVIF；拒绝 SVG 和动画 GIF。
- 本地或 Spaces 均存入 `IMAGE_PREFIX/avatars/年/月/文件名`。
- 登录后，公共页面右上角会在昵称前显示 28px 圆形头像；没有头像时使用黑底白字并显示昵称的首个 Unicode 字符，图片使用 `object-fit: cover` 裁切。

## 部署要求

- `SESSION_SECRET` 必须是稳定的随机值，部署和重启时不能重新生成或修改。
- `DATABASE_PATH` 必须指向持久化磁盘。应用会自动创建 `sessions` 表和过期时间索引，无需手动执行迁移。
- 会话默认 7 天过期；注销、Session ID 轮换、会员封禁和密码修改仍会按原有安全逻辑使对应身份失效。

会员注册复用 Fastmail SMTP 配置，不新增密钥：

```env
MAIL_ENABLED=1
SMTP_HOST=smtps-proxy.fastmail.com
SMTP_PORT=443
SMTP_SECURE=1
SMTP_AUTH_METHOD=PLAIN
SMTP_USER=your-address@example.com
SMTP_PASSWORD=your-fastmail-app-password
MAIL_FROM_ADDRESS=your-address@example.com
TRUST_PROXY=1
```

邮件不可用时，现有会员仍可以登录，但新会员无法发送注册验证码。
