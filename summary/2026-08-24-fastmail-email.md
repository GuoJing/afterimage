# Fastmail 邮件发送支持

## 已完成

- 新增 `lib/mailer.js`，封装 SMTP 配置检查、连接验证和邮件发送。
- 新增服务器命令 `npm run mail:verify`，只验证连接、TLS 与身份认证，不发送邮件。
- 新增服务器命令 `npm run mail:test -- recipient@example.com`，发送测试邮件。
- 邮件功能默认关闭；关闭时不影响网站，启用但配置不完整时应用会拒绝启动并指出缺少项。
- 发件人由服务端环境变量固定，调用方不能覆盖 SMTP 凭据或发件地址。
- 没有增加公开或后台测试接口，避免被网页请求滥用发信。

## Fastmail 配置

```env
MAIL_ENABLED=1
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
SMTP_SECURE=1
SMTP_AUTH_METHOD=PLAIN
SMTP_USER=you@example.com
SMTP_PASSWORD=your-fastmail-app-password
MAIL_FROM_ADDRESS=you@example.com
MAIL_FROM_NAME=AFTERIMAGE PHOTOGRAPHY
# MAIL_REPLY_TO=you@example.com
```

`SMTP_PASSWORD` 必须是在 Fastmail 的 Privacy & Security 设置中创建的 App Password，而不是账户登录密码。Fastmail Basic 方案不提供 SMTP/App Password 支持。

## 底层调用

```js
import { sendMail } from './lib/mailer.js';

await sendMail({
  to: 'reader@example.com',
  subject: '邮件主题',
  text: '纯文本正文',
  html: '<p>HTML 正文</p>',
  replyTo: 'optional@example.com',
});
```

模块还导出 `verifyMailTransport()`、`getMailStatus()` 和 `assertMailConfiguration()`。状态输出不包含账号密码。

## DigitalOcean 注意事项

DigitalOcean 默认封锁 Droplet 的 25、465、587 SMTP 出站端口。Fastmail 提供可使用任意端口的 TLS 代理，因此 DigitalOcean 上推荐覆盖为：

```env
SMTP_HOST=smtps-proxy.fastmail.com
SMTP_PORT=443
SMTP_SECURE=1
```

部署后可用下面命令确认 TLS 连接：

```bash
openssl s_client -connect smtps-proxy.fastmail.com:443 -servername smtps-proxy.fastmail.com -brief
```

再执行 `npm run mail:verify` 验证 SMTP 身份。无需开放 UFW 的 SMTP 入站端口。

## 后台邮件验证码登录

后台登录现在强制要求密码与邮件验证码同时正确。新增配置：

```env
ADMIN_2FA_EMAIL=private-admin@example.com
```

该邮箱地址只由后端读取，不会发送给浏览器。邮件功能或收件地址未配置完整时，公开网站可以启动，但后台登录会拒绝工作，不会降级为仅密码认证。

验证码为 6 位数字，10 分钟有效，只在内存中保存 HMAC 摘要，并绑定发起请求的 IP。成功使用后立即删除；连续错误 5 次也会销毁。进程重启会清除全部待验证验证码。

后端分别限制密码尝试、验证码验证、单 IP 发信频率和全局发信频率；前端同时阻止重复提交并显示限流倒计时。登录流程增加 CSRF，并在进入验证码阶段及最终登录成功时轮换 Session ID。

全部后台响应额外设置 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`。
