import os from 'node:os';
import { getMailStatus, sendMail, verifyMailTransport } from '../lib/mailer.js';

const verifyOnly = process.argv.includes('--verify');
const recipient = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const status = getMailStatus();

console.log(`SMTP: ${status.host}:${status.port} (${status.secure ? 'TLS' : 'STARTTLS'})`);
console.log(`From: ${status.from}`);

try {
  if (verifyOnly) {
    await verifyMailTransport();
    console.log('SMTP 连接、TLS 和身份验证均成功。');
  } else {
    if (!recipient) throw new Error('请提供收件人：npm run mail:test -- recipient@example.com');
    const sentAt = new Date().toISOString();
    const info = await sendMail({
      to: recipient,
      subject: 'Afterimage 邮件发送测试',
      text: `Afterimage 邮件配置正常。\n服务器：${os.hostname()}\n时间：${sentAt}`,
      html: `<p>Afterimage 邮件配置正常。</p><p>服务器：${escapeHtml(os.hostname())}<br>时间：${sentAt}</p>`,
    });
    console.log(`测试邮件已发送，Message-ID: ${info.messageId}`);
  }
} catch (error) {
  console.error(`邮件测试失败：${error.message}`);
  process.exitCode = 1;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
