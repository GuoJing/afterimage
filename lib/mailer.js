import nodemailer from 'nodemailer';

const enabled = parseBoolean(process.env.MAIL_ENABLED, false, 'MAIL_ENABLED');
const host = String(process.env.SMTP_HOST || 'smtp.fastmail.com').trim();
const port = parsePort(process.env.SMTP_PORT || '465');
const secure = parseBoolean(process.env.SMTP_SECURE, port === 465, 'SMTP_SECURE');
const authMethod = String(process.env.SMTP_AUTH_METHOD || 'PLAIN').trim().toUpperCase();
const user = String(process.env.SMTP_USER || '').trim();
const password = String(process.env.SMTP_PASSWORD || '');
const fromAddress = String(process.env.MAIL_FROM_ADDRESS || user).trim();
const fromName = String(process.env.MAIL_FROM_NAME || process.env.BLOG_TITLE || 'AFTERIMAGE PHOTOGRAPHY').trim();
const defaultReplyTo = String(process.env.MAIL_REPLY_TO || '').trim();

let transporter;

export function assertMailConfiguration() {
  if (!enabled) return;

  const missing = [];
  if (!host) missing.push('SMTP_HOST');
  if (!user) missing.push('SMTP_USER');
  if (!password) missing.push('SMTP_PASSWORD');
  if (!fromAddress) missing.push('MAIL_FROM_ADDRESS');
  if (missing.length) throw new Error(`邮件已启用，但缺少配置：${missing.join(', ')}`);

  assertHeaderValue(fromAddress, 'MAIL_FROM_ADDRESS');
  assertHeaderValue(fromName, 'MAIL_FROM_NAME');
  if (defaultReplyTo) assertHeaderValue(defaultReplyTo, 'MAIL_REPLY_TO');
}

export function getMailStatus() {
  return {
    enabled,
    configured: enabled && Boolean(host && user && password && fromAddress),
    host,
    port,
    secure,
    from: fromAddress ? (fromName ? `${fromName} <${fromAddress}>` : fromAddress) : '(not configured)',
  };
}

export async function verifyMailTransport() {
  assertMailConfiguration();
  if (!enabled) throw new Error('邮件发送未启用，请设置 MAIL_ENABLED=1');
  return getTransporter().verify();
}

export async function sendMail({ to, subject, text, html, replyTo } = {}) {
  assertMailConfiguration();
  if (!enabled) throw new Error('邮件发送未启用，请设置 MAIL_ENABLED=1');

  const recipients = normalizeRecipients(to);
  const normalizedSubject = String(subject || '').trim();
  if (!recipients.length) throw new Error('邮件收件人不能为空');
  if (!normalizedSubject) throw new Error('邮件主题不能为空');
  if (!text && !html) throw new Error('邮件正文不能为空');

  recipients.forEach(value => assertHeaderValue(value, '邮件收件人'));
  assertHeaderValue(normalizedSubject, '邮件主题');
  const normalizedReplyTo = String(replyTo || defaultReplyTo || '').trim();
  if (normalizedReplyTo) assertHeaderValue(normalizedReplyTo, 'Reply-To');

  return getTransporter().sendMail({
    from: { name: fromName, address: fromAddress },
    to: recipients,
    subject: normalizedSubject,
    text: text ? String(text) : undefined,
    html: html ? String(html) : undefined,
    replyTo: normalizedReplyTo || undefined,
  });
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass: password },
      authMethod,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2', servername: host },
    });
  }
  return transporter;
}

function normalizeRecipients(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => String(item || '').trim()).filter(Boolean);
}

function assertHeaderValue(value, label) {
  if (/\r|\n/.test(String(value))) throw new Error(`${label} 不能包含换行符`);
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error('SMTP_PORT 必须是有效端口');
  return parsed;
}

function parseBoolean(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} 必须是 1/0 或 true/false`);
}
