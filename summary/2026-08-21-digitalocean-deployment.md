# DigitalOcean 部署交接

日期：2026-08-21

## 推荐结构

- Ubuntu 24.04 LTS Droplet。
- GitHub 只读 Deploy Key 拉取单一仓库。
- Docker Engine + Compose 构建和运行 Node.js 22 容器。
- Caddy 在宿主机监听 80/443，自动申请 HTTPS，并反向代理到 `127.0.0.1:3000`。
- UFW 只开放 OpenSSH、HTTP 和 HTTPS。
- DigitalOcean Cloud Firewall 同样只开放 TCP 22、80、443。

## 已修正的端口暴露

`compose.yml` 使用：

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

这样容器端口只对宿主机开放，由 Caddy 代理；不要改回 `3000:3000`，Docker 发布的公网端口可能绕过 UFW。

## 生产环境关键配置

- `SITE_URL=https://afterimage.photography`
- `TRUST_PROXY=1`
- `ADMIN_PASSWORD` 使用独立强密码。
- `SESSION_SECRET` 使用至少 32 字节的随机值。
- `.env` 权限设为 `600`，文件不能提交 Git。

## 数据与更新

- SQLite 数据持久化在仓库目录的 `data/blog.db`。
- 更新代码前先备份数据库。
- 更新流程：`git pull --ff-only`，然后 `docker compose up -d --build`。
- 检查：`docker compose ps`、`docker compose logs --tail=100 blog`、`systemctl status caddy`。

## DNS 与 HTTPS

- 域名 A 记录指向 Droplet 公网 IPv4。
- 如果存在旧 AAAA 记录但 Droplet 没有对应 IPv6，应删除或修正。
- Caddy 申请证书前，DNS 必须已经指向 Droplet，且公网 TCP 80/443 必须开放。
