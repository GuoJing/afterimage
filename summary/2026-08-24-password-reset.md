# 会员忘记密码功能

## 已实现

- `/account?mode=forgot` 提交注册邮箱；中文、英文、日文界面齐全。
- 对存在和不存在的邮箱统一显示成功提示，实际邮件在响应之后异步发送；成功请求至少等待相同的 150 ms 再响应，进一步降低通过耗时枚举账号的风险。
- 邮件中的 `/account/reset?token=...` 使用 32 字节（256 位）密码学安全随机值，URL-safe 编码后为 43 字符。
- SQLite 仅保存 token 的 SHA-256 摘要，不保存邮件中的原始 token。
- token 30 分钟过期、一次性使用；同一用户申请新链接时旧链接立即作废。
- 获取邮件与验证 token 都有后端限流；邮箱和 IP 至少间隔 2 分钟才能再次申请，另有每小时上限。
- 第一次打开链接后会先轮换 Session ID，再把 token 换成受限 Session 状态并 303 跳转到不含 token 的干净 URL；账号页面统一使用 `no-store`、`no-referrer` 和 `noindex`。
- 新密码沿用注册规则和 scrypt 哈希。修改成功后不自动登录，并使该用户全部旧登录 Session 失效。
- 修改成功后向注册邮箱发送安全通知，邮件不包含密码。

## 数据库迁移

应用启动会自动执行幂等迁移。已有数据库无需手动运行命令。新增结构是：

```sql
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id
ON password_reset_tokens(user_id);
```

注意：`ALTER TABLE` 只能执行一次；服务器代码会先通过 `PRAGMA table_info(users)` 检查字段，因此推荐直接重启应用让它自动迁移。

若确实要手动操作，先备份数据库，然后执行：

```bash
cd /opt/afterimage
cp data/blog.db "data/blog.db.backup-$(date +%Y%m%d-%H%M%S)"
sqlite3 data/blog.db
```

进入 SQLite 后先运行 `.schema users` 和 `.schema password_reset_tokens` 检查，再按缺失情况执行上述 SQL，最后输入 `.quit`。

## 部署要求

- `MAIL_ENABLED=1` 且 SMTP 配置完整，否则注册和密码重置邮件功能都会安全关闭。
- `SITE_URL=https://afterimage.photography` 必须是用户实际访问的 HTTPS 域名；重置链接只从该配置生成，避免 Host Header 注入。
- Cloudflare/Nginx 后使用 `TRUST_PROXY=1`，同时只允许可信代理访问源站，保证 IP 限流读取到正确客户端地址。
- 部署新代码后重启 Node/systemd 服务即可触发数据库迁移。

## 安全设计依据

实现遵循 OWASP Forgot Password Cheat Sheet 的主要建议：统一响应、防自动化滥用、密码学安全随机 token、安全存储、限时、一次性使用、确认两次新密码、重置后使旧会话失效以及发送密码修改通知。
