import { sendMail } from './mailer.js';

const copyByLocale = {
  zh: { subject: '新文章', read: '在网站阅读全文', preferences: '管理订阅偏好', rights: '保留所有权利。' },
  en: { subject: 'New article', read: 'Read the full article', preferences: 'Manage subscription preferences', rights: 'All rights reserved.' },
  ja: { subject: '新しい記事', read: 'サイトで続きを読む', preferences: '配信設定を管理', rights: 'All rights reserved.' },
};

export function createPostEmail({ blog, post, articleUrl, preferencesUrl, bodyHtml, year = new Date().getFullYear() }) {
  const locale = String(post.rendered_locale || post.locale || 'zh').split('-')[0];
  const copy = copyByLocale[locale] || copyByLocale.en;
  const title = escapeHtml(post.title);
  const summary = escapeHtml(post.summary || '');
  const author = escapeHtml(post.author || blog.author || '');
  const publishedAt = escapeHtml(String(post.published_at || '').slice(0, 10).replaceAll('-', '.'));
  const siteTitle = escapeHtml(blog.title);
  const safeArticleUrl = escapeAttribute(articleUrl);
  const safePreferencesUrl = escapeAttribute(preferencesUrl);
  const subjectTitle = String(post.title || '').replace(/[\r\n]+/g, ' ').trim();
  const html = `<!doctype html>
<html lang="${escapeAttribute(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#f5f5f3;color:#222;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB",sans-serif}.wrap{max-width:680px;margin:0 auto;padding:38px 20px}.card{background:#fff;padding:44px 48px;border:1px solid #e7e7e3}.brand{margin:0 0 56px;font-size:13px;font-weight:700;letter-spacing:.08em}.title{margin:0;font-size:38px;line-height:1.18;font-weight:600}.meta{margin:15px 0 32px;color:#777;font-size:13px}.summary{margin:0 0 32px;color:#555;font-size:17px;line-height:1.75}.prose{font-size:17px;line-height:1.9}.prose p{margin:0 0 24px}.prose img{display:block;max-width:100%;height:auto;margin:18px auto}.prose a{color:inherit}.read{display:inline-block;margin-top:28px;padding:12px 18px;color:#fff!important;background:#222;text-decoration:none}.footer{padding:28px 4px 0;color:#777;font-size:12px;line-height:1.7}.footer a{color:#555}@media(max-width:560px){.wrap{padding:18px 10px}.card{padding:30px 22px}.title{font-size:30px}}</style></head>
<body><div class="wrap"><main class="card"><p class="brand">${siteTitle}</p><h1 class="title">${title}</h1><p class="meta">${publishedAt}${author ? ` · ${author}` : ''}</p>${summary ? `<p class="summary">${summary}</p>` : ''}<div class="prose">${bodyHtml}</div><a class="read" href="${safeArticleUrl}">${copy.read} →</a></main><footer class="footer">© ${Number(year)} ${siteTitle}. ${copy.rights}<br><a href="${safePreferencesUrl}">${copy.preferences}</a></footer></div></body></html>`;
  const text = [post.title, post.summary, articleUrl, '', `© ${year} ${blog.title}. ${copy.rights}`, preferencesUrl].filter(Boolean).join('\n\n');
  return { subject: `${copy.subject}｜${subjectTitle}`, text, html };
}

export async function sendPostEmail({ to, ...options }) {
  return sendMail({ to, ...createPostEmail(options) });
}

function escapeHtml(value) {
  return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
