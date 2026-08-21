import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import session from 'express-session';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const adminBasePath = '/qiajigou';
const siteUrl = normalizeSiteUrl(process.env.SITE_URL || 'https://afterimage.photography');
if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET)) {
  throw new Error('生产环境必须设置 ADMIN_PASSWORD 和 SESSION_SECRET');
}
const defaultLocale = normalizeLocale(process.env.DEFAULT_LOCALE || 'zh');
const configuredLocales = [...new Set((process.env.BLOG_LOCALES || 'zh,en').split(',').map(normalizeLocale).filter(Boolean))];
if (!defaultLocale) throw new Error('DEFAULT_LOCALE 不是有效的语言代码');
if (!configuredLocales.includes(defaultLocale)) configuredLocales.unshift(defaultLocale);

const localeNames = new Intl.DisplayNames([defaultLocale], { type: 'language' });
const languageOptions = buildLanguageOptions();
const blog = {
  title: process.env.BLOG_TITLE || 'AFTERIMAGE PHOTOGRAPHY',
  description: process.env.BLOG_DESCRIPTION || '一个关于摄影、观看与生活的个人博客。',
  author: process.env.BLOG_AUTHOR || process.env.BLOG_TITLE || 'AFTERIMAGE PHOTOGRAPHY',
};

const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'blog.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    published_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS post_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    locale TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    UNIQUE(post_id, locale)
  );
`);

marked.setOptions({ gfm: true, breaks: false });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use(session({
  name: 'afterimage.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.TRUST_PROXY === '1',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.use((req, res, next) => {
  const locale = pickLocale(req);
  const isAdminPath = req.path === adminBasePath || req.path.startsWith(`${adminBasePath}/`);
  if (isAdminPath) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  res.locals.blog = blog;
  res.locals.siteUrl = siteUrl;
  res.locals.siteImageUrl = absoluteUrl('/apple-touch-icon.png');
  res.locals.locales = configuredLocales.map(code => ({ code, name: localeNames.of(code) || code }));
  res.locals.languageOptions = languageOptions;
  res.locals.languageName = code => localeNames.of(code) || code;
  res.locals.adminBasePath = adminBasePath;
  res.locals.currentPath = req.path;
  res.locals.canonicalUrl = absoluteUrl(req.path);
  res.locals.alternateUrls = [];
  res.locals.xDefaultUrl = null;
  res.locals.robots = isAdminPath
    ? 'noindex, nofollow, noarchive'
    : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';
  res.locals.structuredData = null;
  res.locals.markdownUrl = null;
  res.locals.serializeJsonLd = serializeJsonLd;
  setResponseLocale(res, locale);
  next();
});

app.get('/', (req, res) => {
  const posts = getPublishedPosts(res.locals.locale);
  const canonicalUrl = absoluteUrl(homePath(res.locals.locale));
  const alternateUrls = configuredLocales.map(code => ({ locale: code, url: absoluteUrl(homePath(code)) }));
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: blog.title,
    description: blog.description,
    inLanguage: res.locals.locale,
    url: canonicalUrl,
    publisher: publisherStructuredData(),
  };
  res.render('home', { posts, renderMarkdown, canonicalUrl, alternateUrls, xDefaultUrl: absoluteUrl('/'), structuredData });
});

app.get(/^\/post\/([^/]+)\/([^/]+)\.md$/, (req, res) => {
  const locale = normalizeLocale(req.params[0]);
  if (!locale) return res.status(404).type('text').send('Not found');
  const post = getPostBySlug(req.params[1], locale);
  if (!post || post.status !== 'published') return res.status(404).type('text').send('Not found');
  const canonicalUrl = absoluteUrl(postUrl(post.rendered_locale, post.slug));
  res.set('Link', `<${canonicalUrl}>; rel="canonical", <${absoluteUrl('/llms.txt')}>; rel="describedby"`);
  res.type('text/markdown; charset=utf-8').send(renderPostMarkdown(post, canonicalUrl));
});

app.get('/post/:locale/:slug', (req, res) => {
  const locale = normalizeLocale(req.params.locale);
  if (!locale) return res.status(404).render('not-found');
  setResponseLocale(res, locale);
  const post = getPostBySlug(req.params.slug, locale);
  if (!post || (post.status !== 'published' && !req.session.isAdmin)) return res.status(404).render('not-found');
  const canonicalUrl = absoluteUrl(postUrl(post.rendered_locale, post.slug));
  const alternateUrls = post.availableLocales.map(code => ({ locale: code, url: absoluteUrl(postUrl(code, post.slug)) }));
  const xDefaultLocale = post.availableLocales.includes(defaultLocale) ? defaultLocale : post.rendered_locale;
  const markdownUrl = absoluteUrl(`${postUrl(post.rendered_locale, post.slug)}.md`);
  const description = articleDescription(post);
  const image = extractFirstImage(post.body) || absoluteUrl('/apple-touch-icon.png');
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description,
    image: [image],
    datePublished: post.published_at,
    dateModified: sqliteDateToIso(post.updated_at),
    inLanguage: post.rendered_locale,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
    author: { '@type': 'Person', name: blog.author },
    publisher: publisherStructuredData(),
  };
  if (post.status !== 'published') {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  res.render('post', {
    post,
    renderMarkdown,
    description,
    canonicalUrl,
    alternateUrls,
    xDefaultUrl: absoluteUrl(postUrl(xDefaultLocale, post.slug)),
    markdownUrl,
    structuredData,
    htmlLang: post.rendered_locale,
    ogType: 'article',
    ogImage: image,
    publishedAt: post.published_at,
    modifiedAt: sqliteDateToIso(post.updated_at),
    robots: post.status === 'published'
      ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      : 'noindex, nofollow, noarchive',
  });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${absoluteUrl('/sitemap.xml')}`,
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(buildSitemap());
});

app.get('/llms.txt', (req, res) => {
  res.set('Link', `<${absoluteUrl('/llms.txt')}>; rel="describedby"`);
  res.type('text/markdown; charset=utf-8').send(buildLlmsText());
});

app.get('/llms-full.txt', (req, res) => {
  res.set('Link', `<${absoluteUrl('/llms.txt')}>; rel="describedby"`);
  res.type('text/markdown; charset=utf-8').send(buildLlmsFullText());
});

app.get('/language/:locale', (req, res) => {
  const locale = normalizeLocale(req.params.locale);
  if (configuredLocales.includes(locale)) {
    res.cookie('afterimage.locale', locale, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000 });
  }
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//')
    ? req.query.next
    : '/';
  res.redirect(configuredLocales.includes(locale) ? localizePath(next, locale) : next);
});

app.get(`${adminBasePath}/login`, (req, res) => {
  if (req.session.isAdmin) return res.redirect(adminBasePath);
  res.render('admin/login', { error: null });
});

app.post(`${adminBasePath}/login`, (req, res) => {
  const supplied = String(req.body.password || '');
  const expected = process.env.ADMIN_PASSWORD || 'change-me-now';
  if (!safeEqual(supplied, expected)) {
    return res.status(401).render('admin/login', { error: '密码不正确' });
  }
  req.session.regenerate(error => {
    if (error) return res.status(500).send('无法创建登录会话');
    req.session.isAdmin = true;
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.redirect(adminBasePath);
  });
});

app.post(`${adminBasePath}/logout`, requireAdmin, requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect(`${adminBasePath}/login`));
});

app.get(adminBasePath, requireAdmin, (req, res) => {
  const posts = db.prepare(`
    SELECT p.*, COALESCE(t.title,
      (SELECT title FROM post_translations WHERE post_id = p.id ORDER BY id LIMIT 1), p.slug) AS title,
      (SELECT group_concat(locale, ', ') FROM post_translations WHERE post_id = p.id) AS translation_locales
    FROM posts p
    LEFT JOIN post_translations t ON t.post_id = p.id AND t.locale = ?
    ORDER BY COALESCE(p.published_at, p.created_at) DESC
  `).all(defaultLocale);
  res.render('admin/index', { posts, csrf: req.session.csrf });
});

app.get(`${adminBasePath}/posts/new`, requireAdmin, (req, res) => {
  res.render('admin/form', { post: emptyPost(), error: null, csrf: req.session.csrf, isNew: true });
});

app.post(`${adminBasePath}/preview`, requireAdmin, requireCsrf, (req, res) => {
  res.type('html').send(renderMarkdown(String(req.body.markdown || '')));
});

app.post(`${adminBasePath}/posts`, requireAdmin, requireCsrf, (req, res) => {
  try {
    const postId = savePost(null, req.body);
    res.redirect(`${adminBasePath}/posts/${postId}/edit?saved=1`);
  } catch (error) {
    res.status(400).render('admin/form', { post: postFromBody(req.body), error: friendlyError(error), csrf: req.session.csrf, isNew: true });
  }
});

app.get(`${adminBasePath}/posts/:id/edit`, requireAdmin, (req, res) => {
  const post = getPostForAdmin(Number(req.params.id));
  if (!post) return res.status(404).render('not-found');
  res.render('admin/form', { post, error: null, csrf: req.session.csrf, isNew: false, saved: req.query.saved === '1' });
});

app.post(`${adminBasePath}/posts/:id`, requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  try {
    savePost(id, req.body);
    res.redirect(`${adminBasePath}/posts/${id}/edit?saved=1`);
  } catch (error) {
    res.status(400).render('admin/form', { post: { ...postFromBody(req.body), id }, error: friendlyError(error), csrf: req.session.csrf, isNew: false });
  }
});

app.post(`${adminBasePath}/posts/:id/delete`, requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(Number(req.params.id));
  res.redirect(adminBasePath);
});

app.use((req, res) => {
  res.set('X-Robots-Tag', 'noindex, follow');
  res.status(404).render('not-found', { robots: 'noindex, follow' });
});

app.listen(port, () => {
  console.log(`Afterimage Blog: http://localhost:${port}`);
  console.log(`Admin: http://localhost:${port}${adminBasePath}`);
  if (!process.env.ADMIN_PASSWORD) console.warn('警告：当前后台密码是 change-me-now，请在 .env 中设置 ADMIN_PASSWORD。');
  if (!process.env.SESSION_SECRET) console.warn('警告：未设置 SESSION_SECRET，服务重启后登录会话会失效。');
});

function normalizeLocale(value) {
  const locale = String(value || '').trim().toLowerCase().replaceAll('_', '-');
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(locale) ? locale : '';
}

function normalizeSiteUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('SITE_URL 必须使用 http 或 https');
  return url.origin;
}

function absoluteUrl(pathname) {
  return new URL(pathname, `${siteUrl}/`).toString();
}

function homePath(locale) {
  return locale === defaultLocale ? '/' : `/?lang=${encodeURIComponent(locale)}`;
}

function serializeJsonLd(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function publisherStructuredData() {
  return {
    '@type': 'Organization',
    name: blog.title,
    url: absoluteUrl('/'),
    logo: { '@type': 'ImageObject', url: absoluteUrl('/apple-touch-icon.png') },
  };
}

function sqliteDateToIso(value) {
  if (!value) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function articleDescription(post) {
  if (String(post.summary || '').trim()) return String(post.summary).trim();
  const plainText = sanitizeHtml(marked.parse(post.body || ''), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();
  return plainText.slice(0, 200) || blog.description;
}

function extractFirstImage(markdown) {
  const match = String(markdown || '').match(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/);
  if (!match) return null;
  try {
    const url = new URL(match[1], `${siteUrl}/`);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function setResponseLocale(res, locale) {
  res.locals.locale = locale;
  res.locals.langQuery = locale === defaultLocale ? '' : `?lang=${encodeURIComponent(locale)}`;
  res.locals.formatDate = formatDate;
  res.locals.postUrl = slug => postUrl(locale, slug);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function postUrl(locale, slug) {
  return `/post/${encodeURIComponent(locale)}/${encodeURIComponent(slug)}`;
}

function getPublishedTranslations() {
  return db.prepare(`
    SELECT p.slug, p.published_at, p.updated_at, t.locale, t.title, t.summary, t.body
    FROM posts p
    JOIN post_translations t ON t.post_id = p.id
    WHERE p.status = 'published'
    ORDER BY p.published_at DESC, p.slug, t.locale
  `).all();
}

function buildSitemap() {
  const groups = new Map();
  for (const row of getPublishedTranslations()) {
    if (!groups.has(row.slug)) groups.set(row.slug, []);
    groups.get(row.slug).push(row);
  }
  const urls = [
    `  <url><loc>${escapeXml(absoluteUrl('/'))}</loc></url>`,
  ];
  for (const translations of groups.values()) {
    const xDefault = translations.find(row => row.locale === defaultLocale) || translations[0];
    const alternates = translations.map(row =>
      `    <xhtml:link rel="alternate" hreflang="${escapeXml(row.locale)}" href="${escapeXml(absoluteUrl(postUrl(row.locale, row.slug)))}" />`
    );
    alternates.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(absoluteUrl(postUrl(xDefault.locale, xDefault.slug)))}" />`);
    for (const row of translations) {
      urls.push([
        '  <url>',
        `    <loc>${escapeXml(absoluteUrl(postUrl(row.locale, row.slug)))}</loc>`,
        `    <lastmod>${escapeXml(sqliteDateToIso(row.updated_at) || row.published_at)}</lastmod>`,
        ...alternates,
        '  </url>',
      ].join('\n'));
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

function buildLlmsText() {
  const articles = getPublishedTranslations().map(row => {
    const note = articleDescription(row).replace(/\s+/g, ' ');
    return `- [${escapeMarkdownLabel(row.title)}](${absoluteUrl(`${postUrl(row.locale, row.slug)}.md`)}): ${row.locale}; ${note}`;
  });
  return [
    `# ${blog.title}`,
    '',
    `> ${blog.description.replace(/\s+/g, ' ')}`,
    '',
    '这是一个关于摄影、观看、摄影书、摄影师与器材的多语言个人博客。文章链接指向与网页内容对应的纯 Markdown 版本。',
    '',
    '## Articles',
    '',
    ...(articles.length ? articles : ['- 暂无已发布文章。']),
    '',
    '## Optional',
    '',
    `- [完整文章合集](${absoluteUrl('/llms-full.txt')}): 所有已发布语言版本的完整 Markdown 正文。`,
    `- [XML Sitemap](${absoluteUrl('/sitemap.xml')}): 所有可索引网页及语言版本。`,
    '',
  ].join('\n');
}

function buildLlmsFullText() {
  const sections = getPublishedTranslations().map(row => {
    const canonicalUrl = absoluteUrl(postUrl(row.locale, row.slug));
    return renderPostMarkdown(row, canonicalUrl);
  });
  const introduction = [
    `# ${blog.title} — Full Articles`,
    '',
    `> ${blog.description.replace(/\s+/g, ' ')}`,
  ].join('\n');
  return [introduction, ...sections].join('\n\n---\n\n');
}

function renderPostMarkdown(post, canonicalUrl) {
  const summary = String(post.summary || '').trim();
  return [
    `# ${post.title}`,
    '',
    ...(summary ? [`> ${summary.replace(/\s*\n\s*/g, ' ')}`, ''] : []),
    `- Language: ${post.rendered_locale || post.locale}`,
    `- Published: ${formatDate(post.published_at)}`,
    `- Canonical: ${canonicalUrl}`,
    '',
    String(post.body || '').trim(),
    '',
  ].join('\n');
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function escapeMarkdownLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function localizePath(currentPath, locale) {
  const match = currentPath.match(/^\/post\/[^/]+\/([^/]+)$/);
  if (match) return `/post/${encodeURIComponent(locale)}/${match[1]}`;
  return locale === defaultLocale ? '/' : `/?lang=${encodeURIComponent(locale)}`;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
}

function pickLocale(req) {
  const queryLocale = normalizeLocale(req.query.lang);
  if (configuredLocales.includes(queryLocale)) return queryLocale;
  const cookieLocale = normalizeLocale(parseCookies(req.headers.cookie)['afterimage.locale']);
  if (configuredLocales.includes(cookieLocale)) return cookieLocale;
  const preferred = String(req.headers['accept-language'] || '').split(',').map(part => normalizeLocale(part.split(';')[0]));
  return preferred.find(code => configuredLocales.includes(code)) || defaultLocale;
}

function renderMarkdown(markdown) {
  return sanitizeHtml(marked.parse(markdown || ''), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'figure', 'figcaption']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt', 'title', 'loading'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' }) },
  });
}

function getPublishedPosts(locale) {
  const rows = db.prepare(`
    SELECT p.*, COALESCE(chosen.title, fallback.title) AS title,
      COALESCE(chosen.summary, fallback.summary, '') AS summary,
      COALESCE(chosen.body, fallback.body, '') AS body,
      CASE WHEN chosen.id IS NULL THEN ? ELSE ? END AS rendered_locale
    FROM posts p
    LEFT JOIN post_translations chosen ON chosen.post_id = p.id AND chosen.locale = ?
    LEFT JOIN post_translations fallback ON fallback.post_id = p.id AND fallback.locale = ?
    WHERE p.status = 'published' AND COALESCE(chosen.id, fallback.id) IS NOT NULL
    ORDER BY p.published_at DESC
  `).all(defaultLocale, locale, locale, defaultLocale);
  return rows.map(withLocales);
}

function getPostBySlug(slug, locale) {
  const post = db.prepare(`
    SELECT p.*, COALESCE(chosen.title, fallback.title) AS title,
      COALESCE(chosen.summary, fallback.summary, '') AS summary,
      COALESCE(chosen.body, fallback.body, '') AS body,
      CASE WHEN chosen.id IS NULL THEN ? ELSE ? END AS rendered_locale
    FROM posts p
    LEFT JOIN post_translations chosen ON chosen.post_id = p.id AND chosen.locale = ?
    LEFT JOIN post_translations fallback ON fallback.post_id = p.id AND fallback.locale = ?
    WHERE p.slug = ? AND COALESCE(chosen.id, fallback.id) IS NOT NULL
  `).get(defaultLocale, locale, locale, defaultLocale, slug);
  return post ? withLocales(post) : null;
}

function withLocales(post) {
  post.availableLocales = db.prepare('SELECT locale FROM post_translations WHERE post_id = ? ORDER BY locale').all(post.id).map(row => row.locale);
  return post;
}

function getPostForAdmin(id) {
  const base = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!base) return null;
  base.translationList = db.prepare(`
    SELECT locale, title, summary, body FROM post_translations
    WHERE post_id = ? ORDER BY CASE WHEN locale = ? THEN 0 ELSE 1 END, locale
  `).all(id, defaultLocale);
  if (!base.translationList.length) base.translationList.push({ locale: defaultLocale, title: '', summary: '', body: '' });
  return base;
}

function emptyPost() {
  return {
    slug: '',
    status: 'draft',
    published_at: new Date().toISOString().slice(0, 16),
    translationList: [{ locale: defaultLocale, title: '', summary: '', body: '' }],
  };
}

function postFromBody(body) {
  const locales = arrayValue(body.translation_locale);
  const titles = arrayValue(body.translation_title);
  const summaries = arrayValue(body.translation_summary);
  const bodies = arrayValue(body.translation_body);
  const translationList = locales.map((locale, index) => ({
    locale: String(locale || ''),
    title: String(titles[index] || ''),
    summary: String(summaries[index] || ''),
    body: String(bodies[index] || ''),
  }));
  if (!translationList.length) translationList.push({ locale: defaultLocale, title: '', summary: '', body: '' });
  return { slug: body.slug || '', status: body.status || 'draft', published_at: body.published_at || '', translationList };
}

const persistPost = db.transaction((id, data) => {
  const slug = String(data.slug || '').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) throw new Error('INVALID_SLUG');
  const status = data.status === 'published' ? 'published' : 'draft';
  const publishedAt = data.published_at ? new Date(data.published_at).toISOString() : new Date().toISOString();
  let postId = id;
  if (id) {
    db.prepare('UPDATE posts SET slug = ?, status = ?, published_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(slug, status, publishedAt, id);
  } else {
    postId = Number(db.prepare('INSERT INTO posts (slug, status, published_at) VALUES (?, ?, ?)').run(slug, status, publishedAt).lastInsertRowid);
  }
  const translations = parseSubmittedTranslations(data);
  db.prepare('DELETE FROM post_translations WHERE post_id = ?').run(postId);
  const insertTranslation = db.prepare(`
    INSERT INTO post_translations (post_id, locale, title, summary, body) VALUES (?, ?, ?, ?, ?)
  `);
  for (const translation of translations) {
    insertTranslation.run(postId, translation.locale, translation.title, translation.summary, translation.body);
  }
  return postId;
});

function savePost(id, data) {
  return persistPost(id, data);
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect(`${adminBasePath}/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

function requireCsrf(req, res, next) {
  if (!req.session.csrf || !safeEqual(String(req.body.csrf || ''), req.session.csrf)) return res.status(403).send('请求已过期，请刷新页面后重试。');
  next();
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function friendlyError(error) {
  if (String(error.message).includes('UNIQUE constraint failed')) return '这个 URL 已经被使用';
  if (error.message === 'INVALID_SLUG') return 'URL 只能包含英文字母、数字、连字符和下划线';
  if (error.message === 'INVALID_LOCALE') return '请选择有效的语言代码';
  if (error.message === 'DUPLICATE_LOCALE') return '同一种语言只能添加一次';
  if (error.message === 'NO_TRANSLATIONS') return '请至少添加一种语言的文章内容';
  if (error.message.startsWith('MISSING_TITLE:')) return `填写了翻译内容时，标题不能为空（${error.message.split(':')[1]}）`;
  return '保存失败，请检查输入内容';
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function parseSubmittedTranslations(data) {
  const locales = arrayValue(data.translation_locale);
  const titles = arrayValue(data.translation_title);
  const summaries = arrayValue(data.translation_summary);
  const bodies = arrayValue(data.translation_body);
  const seen = new Set();
  const translations = locales.map((value, index) => {
    const locale = normalizeLocale(value);
    if (!locale) throw new Error('INVALID_LOCALE');
    if (seen.has(locale)) throw new Error('DUPLICATE_LOCALE');
    seen.add(locale);
    const title = String(titles[index] || '').trim();
    const summary = String(summaries[index] || '').trim();
    const body = String(bodies[index] || '').trim();
    if (!title) throw new Error(`MISSING_TITLE:${locale}`);
    return { locale, title, summary, body };
  });
  if (!translations.length) throw new Error('NO_TRANSLATIONS');
  return translations;
}

function buildLanguageOptions() {
  const codes = new Set(configuredLocales);
  for (let first = 97; first <= 122; first += 1) {
    for (let second = 97; second <= 122; second += 1) {
      const code = String.fromCharCode(first, second);
      const name = localeNames.of(code);
      if (name && name.toLowerCase() !== code) codes.add(code);
    }
  }
  return [...codes]
    .map(code => ({ code, name: localeNames.of(code) || code }))
    .sort((left, right) => left.name.localeCompare(right.name, defaultLocale));
}
