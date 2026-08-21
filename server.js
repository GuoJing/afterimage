import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import Database from 'better-sqlite3';
import express from 'express';
import session from 'express-session';
import { Lexer, marked, Renderer } from 'marked';
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
const configuredLocales = [...new Set((process.env.BLOG_LOCALES || 'zh,en,ja').split(',').map(normalizeLocale).filter(Boolean))];
if (!defaultLocale) throw new Error('DEFAULT_LOCALE 不是有效的语言代码');
if (!configuredLocales.includes(defaultLocale)) configuredLocales.unshift(defaultLocale);

const nativeLanguageNames = new Map();
const languageOptions = buildLanguageOptions();
const blog = {
  title: process.env.BLOG_TITLE || 'AFTERIMAGE PHOTOGRAPHY',
  description: process.env.BLOG_DESCRIPTION || '一个关于摄影、观看与生活的个人博客。',
  author: process.env.BLOG_AUTHOR || process.env.BLOG_TITLE || 'AFTERIMAGE PHOTOGRAPHY',
};
const archiveCopy = {
  zh: { title: '归档', description: '按时间浏览所有已发布文章。' },
  en: { title: 'Archive', description: 'Browse all published posts by date.' },
  ja: { title: 'アーカイブ', description: '公開済みの記事を日付順に表示します。' },
};

const imageStorage = String(process.env.IMAGE_STORAGE || 'local').trim().toLowerCase();
if (!['local', 'spaces'].includes(imageStorage)) throw new Error('IMAGE_STORAGE 只能是 local 或 spaces');
const imageUploadDir = path.resolve(process.env.IMAGE_UPLOAD_DIR || path.join(__dirname, 'data', 'uploads'));
const imagePublicPath = normalizePublicPath(process.env.IMAGE_PUBLIC_PATH || '/uploads');
const imagePrefix = normalizeImagePrefix(process.env.IMAGE_PREFIX || 'images');
const imageMaxSizeMb = normalizeImageMaxSize(process.env.IMAGE_MAX_SIZE_MB || '15');
const imageMaxBytes = imageMaxSizeMb * 1024 * 1024;
const spaces = imageStorage === 'spaces' ? createSpacesStorage() : null;
if (imageStorage === 'local') fs.mkdirSync(imageUploadDir, { recursive: true });

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

  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS page_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    locale TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    UNIQUE(page_id, locale)
  );

  CREATE TABLE IF NOT EXISTS navigation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT 'self' CHECK (target IN ('self', 'blank')),
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const markdownRenderer = new Renderer();
markdownRenderer.paragraph = function renderParagraph(token) {
  if (!isImageOnlyParagraph(token)) return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
  const rows = token.raw
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => `<span class="image-row">${this.parser.parseInline(Lexer.lexInline(line, this.options))}</span>`)
    .join('');
  return `<div class="image-stack">${rows}</div>\n`;
};
marked.setOptions({ gfm: true, breaks: false, renderer: markdownRenderer });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
if (imageStorage === 'local') {
  app.use(imagePublicPath, (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  }, express.static(imageUploadDir, { maxAge: '1y', immutable: true, index: false, dotfiles: 'deny' }));
}
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
  res.locals.locales = configuredLocales.map(code => ({ code, name: languageName(code) }));
  res.locals.languageOptions = languageOptions;
  res.locals.languageName = languageName;
  res.locals.navigationItems = isAdminPath ? [] : getNavigationItems();
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
  res.locals.imageUploadUrl = `${adminBasePath}/uploads/images`;
  res.locals.imageMaxSizeMb = imageMaxSizeMb;
  res.locals.imageMaxBytes = imageMaxBytes;
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

app.get('/archive', (req, res) => {
  const locale = parameterLocale(req);
  setResponseLocale(res, locale);
  const posts = getPublishedPostsByExactLocale(locale);
  const title = archiveTitle(locale);
  const description = archiveDescription(locale);
  const canonicalUrl = absoluteUrl(archivePath(locale));
  const alternateUrls = configuredLocales.map(code => ({ locale: code, url: absoluteUrl(archivePath(code)) }));
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    inLanguage: locale,
    url: canonicalUrl,
    isPartOf: { '@type': 'WebSite', name: blog.title, url: absoluteUrl('/') },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: posts.map((post, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        url: absoluteUrl(postUrl(locale, post.slug)),
        name: post.title,
      })),
    },
  };
  res.render('archive', {
    posts,
    archiveTitle: title,
    archiveExcerpt,
    description,
    canonicalUrl,
    alternateUrls,
    xDefaultUrl: absoluteUrl(archivePath(defaultLocale)),
    structuredData,
    htmlLang: locale,
  });
});

app.get('/feed.xml', (req, res) => {
  const locale = parameterLocale(req);
  const posts = getPublishedPostsByExactLocale(locale);
  res.type('application/rss+xml; charset=utf-8').send(buildRssFeed(locale, posts));
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

app.get(/^\/page\/([^/]+)\/([^/]+)\.md$/, (req, res) => {
  const locale = normalizeLocale(req.params[0]);
  if (!locale) return res.status(404).type('text').send('Not found');
  const page = getPageBySlug(req.params[1], locale);
  if (!page || page.status !== 'published') return res.status(404).type('text').send('Not found');
  const canonicalUrl = absoluteUrl(pageUrl(page.rendered_locale, page.slug));
  res.set('Link', `<${canonicalUrl}>; rel="canonical", <${absoluteUrl('/llms.txt')}>; rel="describedby"`);
  res.type('text/markdown; charset=utf-8').send(renderPageMarkdown(page, canonicalUrl));
});

app.get('/page/:locale/:slug', (req, res) => {
  const locale = normalizeLocale(req.params.locale);
  if (!locale) return res.status(404).render('not-found');
  setResponseLocale(res, locale);
  const page = getPageBySlug(req.params.slug, locale);
  if (!page || (page.status !== 'published' && !req.session.isAdmin)) return res.status(404).render('not-found');
  const canonicalUrl = absoluteUrl(pageUrl(page.rendered_locale, page.slug));
  const alternateUrls = page.availableLocales.map(code => ({ locale: code, url: absoluteUrl(pageUrl(code, page.slug)) }));
  const xDefaultLocale = page.availableLocales.includes(defaultLocale) ? defaultLocale : page.rendered_locale;
  const markdownUrl = absoluteUrl(`${pageUrl(page.rendered_locale, page.slug)}.md`);
  const description = articleDescription(page);
  const image = extractFirstImage(page.body) || absoluteUrl('/apple-touch-icon.png');
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: page.title,
    description,
    image,
    dateModified: sqliteDateToIso(page.updated_at),
    inLanguage: page.rendered_locale,
    url: canonicalUrl,
    publisher: publisherStructuredData(),
  };
  if (page.status !== 'published') {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  res.render('page', {
    page,
    renderMarkdown,
    description,
    canonicalUrl,
    alternateUrls,
    xDefaultUrl: absoluteUrl(pageUrl(xDefaultLocale, page.slug)),
    markdownUrl,
    structuredData,
    htmlLang: page.rendered_locale,
    ogType: 'website',
    ogImage: image,
    modifiedAt: sqliteDateToIso(page.updated_at),
    robots: page.status === 'published'
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

app.post(
  `${adminBasePath}/uploads/images`,
  requireAdmin,
  requireCsrf,
  parseImageBody,
  async (req, res) => {
    const image = detectImageType(req.body);
    if (!image) return res.status(415).json({ error: '仅支持 JPEG、PNG、WebP、GIF 或 AVIF 图片。' });

    try {
      const url = await storeImage(req.body, image);
      res.status(201).json({ url, mimeType: image.mimeType, size: req.body.length });
    } catch (error) {
      console.error('图片上传失败：', error);
      res.status(502).json({ error: '图片存储失败，请稍后重试。' });
    }
  },
);

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

app.get(`${adminBasePath}/pages`, requireAdmin, (req, res) => {
  const pages = db.prepare(`
    SELECT p.*, COALESCE(t.title,
      (SELECT title FROM page_translations WHERE page_id = p.id ORDER BY id LIMIT 1), p.slug) AS title,
      (SELECT group_concat(locale, ', ') FROM page_translations WHERE page_id = p.id) AS translation_locales
    FROM pages p
    LEFT JOIN page_translations t ON t.page_id = p.id AND t.locale = ?
    ORDER BY p.updated_at DESC, p.created_at DESC
  `).all(defaultLocale);
  res.render('admin/pages', { pages, csrf: req.session.csrf });
});

app.get(`${adminBasePath}/pages/new`, requireAdmin, (req, res) => {
  res.render('admin/page-form', { page: emptyPage(), error: null, csrf: req.session.csrf, isNew: true });
});

app.post(`${adminBasePath}/pages`, requireAdmin, requireCsrf, (req, res) => {
  try {
    const pageId = savePage(null, req.body);
    res.redirect(`${adminBasePath}/pages/${pageId}/edit?saved=1`);
  } catch (error) {
    res.status(400).render('admin/page-form', { page: pageFromBody(req.body), error: friendlyError(error), csrf: req.session.csrf, isNew: true });
  }
});

app.get(`${adminBasePath}/pages/:id/edit`, requireAdmin, (req, res) => {
  const page = getPageForAdmin(Number(req.params.id));
  if (!page) return res.status(404).render('not-found');
  res.render('admin/page-form', { page, error: null, csrf: req.session.csrf, isNew: false, saved: req.query.saved === '1' });
});

app.post(`${adminBasePath}/pages/:id`, requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  try {
    savePage(id, req.body);
    res.redirect(`${adminBasePath}/pages/${id}/edit?saved=1`);
  } catch (error) {
    res.status(400).render('admin/page-form', { page: { ...pageFromBody(req.body), id }, error: friendlyError(error), csrf: req.session.csrf, isNew: false });
  }
});

app.post(`${adminBasePath}/pages/:id/delete`, requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM pages WHERE id = ?').run(Number(req.params.id));
  res.redirect(`${adminBasePath}/pages`);
});

app.get(`${adminBasePath}/navigation`, requireAdmin, (req, res) => {
  res.render('admin/navigation', {
    items: getNavigationItems(),
    navigation: emptyNavigation(),
    error: null,
    csrf: req.session.csrf,
    isNew: true,
    saved: req.query.saved === '1',
  });
});

app.post(`${adminBasePath}/navigation`, requireAdmin, requireCsrf, (req, res) => {
  try {
    saveNavigation(null, req.body);
    res.redirect(`${adminBasePath}/navigation?saved=1`);
  } catch (error) {
    res.status(400).render('admin/navigation', {
      items: getNavigationItems(),
      navigation: navigationFromBody(req.body),
      error: friendlyError(error),
      csrf: req.session.csrf,
      isNew: true,
    });
  }
});

app.get(`${adminBasePath}/navigation/:id/edit`, requireAdmin, (req, res) => {
  const navigation = getNavigationItem(Number(req.params.id));
  if (!navigation) return res.status(404).render('not-found');
  res.render('admin/navigation', {
    items: getNavigationItems(),
    navigation,
    error: null,
    csrf: req.session.csrf,
    isNew: false,
    saved: req.query.saved === '1',
  });
});

app.post(`${adminBasePath}/navigation/:id`, requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  try {
    saveNavigation(id, req.body);
    res.redirect(`${adminBasePath}/navigation/${id}/edit?saved=1`);
  } catch (error) {
    res.status(400).render('admin/navigation', {
      items: getNavigationItems(),
      navigation: { ...navigationFromBody(req.body), id },
      error: friendlyError(error),
      csrf: req.session.csrf,
      isNew: false,
    });
  }
});

app.post(`${adminBasePath}/navigation/:id/delete`, requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM navigation_items WHERE id = ?').run(Number(req.params.id));
  res.redirect(`${adminBasePath}/navigation`);
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

function normalizePublicPath(value) {
  const pathname = `/${String(value || '').trim().replace(/^\/+|\/+$/g, '')}`;
  if (pathname === '/' || pathname.includes('..') || !/^\/[A-Za-z0-9/_-]+$/.test(pathname)) {
    throw new Error('IMAGE_PUBLIC_PATH 必须是有效路径，例如 /uploads');
  }
  return pathname;
}

function normalizeImagePrefix(value) {
  const prefix = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  const segments = prefix.split('/');
  if (!prefix || segments.some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === '.' || segment === '..')) {
    throw new Error('IMAGE_PREFIX 必须是有效的相对目录，例如 media 或 library/main');
  }
  return segments.join('/');
}

function normalizeImageMaxSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 1 || size > 50) throw new Error('IMAGE_MAX_SIZE_MB 必须介于 1 和 50 之间');
  return size;
}

function parseImageBody(req, res, next) {
  express.raw({ type: () => true, limit: imageMaxBytes })(req, res, error => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: `图片不能超过 ${imageMaxSizeMb} MB。` });
    if (error) return res.status(400).json({ error: '无法读取上传的图片。' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '请选择需要上传的图片。' });
    next();
  });
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', mimeType: 'image/png' };
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return { extension: 'gif', mimeType: 'image/gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: 'webp', mimeType: 'image/webp' };
  }
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = buffer.subarray(8, Math.min(buffer.length, 32)).toString('ascii');
    if (brands.includes('avif') || brands.includes('avis')) return { extension: 'avif', mimeType: 'image/avif' };
  }
  return null;
}

function createSpacesStorage() {
  const region = requiredEnvironment('SPACES_REGION');
  const bucket = requiredEnvironment('SPACES_BUCKET');
  const endpoint = normalizeHttpsUrl(process.env.SPACES_ENDPOINT || `https://${region}.digitaloceanspaces.com`, 'SPACES_ENDPOINT');
  const publicUrl = normalizeHttpsUrl(requiredEnvironment('SPACES_PUBLIC_URL'), 'SPACES_PUBLIC_URL');
  const accessKeyId = requiredEnvironment('SPACES_ACCESS_KEY');
  const secretAccessKey = requiredEnvironment('SPACES_SECRET_KEY');
  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: false,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { bucket, publicUrl, client };
}

async function storeImage(buffer, image) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const filename = `${crypto.randomUUID()}.${image.extension}`;
  const objectKey = `${imagePrefix}/${year}/${month}/${filename}`;

  if (imageStorage === 'spaces') {
    await spaces.client.send(new PutObjectCommand({
      Bucket: spaces.bucket,
      Key: objectKey,
      Body: buffer,
      ACL: 'public-read',
      ContentType: image.mimeType,
      ContentDisposition: 'inline',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return `${spaces.publicUrl}/${objectKey}`;
  }

  const destination = path.join(imageUploadDir, ...objectKey.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer, { flag: 'wx', mode: 0o640 });
  return `${imagePublicPath}/${objectKey}`;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`IMAGE_STORAGE=spaces 时必须设置 ${name}`);
  return value;
}

function normalizeHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 必须是有效的 HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} 必须是有效的 HTTPS URL`);
  }
  return url.toString().replace(/\/+$/, '');
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

function archivePath(locale) {
  return locale === defaultLocale ? '/archive' : `/archive?lang=${encodeURIComponent(locale)}`;
}

function feedPath(locale) {
  return locale === defaultLocale ? '/feed.xml' : `/feed.xml?lang=${encodeURIComponent(locale)}`;
}

function parameterLocale(req) {
  return normalizeLocale(req.query.lang) || defaultLocale;
}

function archiveTitle(locale) {
  return (archiveCopy[locale] || archiveCopy.en).title;
}

function archiveDescription(locale) {
  return (archiveCopy[locale] || archiveCopy.en).description;
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
  res.locals.feedUrl = feedPath(locale);
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

function pageUrl(locale, slug) {
  return `/page/${encodeURIComponent(locale)}/${encodeURIComponent(slug)}`;
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

function getPublishedPageTranslations() {
  return db.prepare(`
    SELECT p.slug, p.updated_at, t.locale, t.title, t.summary, t.body
    FROM pages p
    JOIN page_translations t ON t.page_id = p.id
    WHERE p.status = 'published'
    ORDER BY p.slug, t.locale
  `).all();
}

function buildSitemap() {
  const urls = [
    `  <url><loc>${escapeXml(absoluteUrl('/'))}</loc></url>`,
  ];

  const archiveAlternates = configuredLocales.map(locale =>
    `    <xhtml:link rel="alternate" hreflang="${escapeXml(locale)}" href="${escapeXml(absoluteUrl(archivePath(locale)))}" />`
  );
  archiveAlternates.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(absoluteUrl(archivePath(defaultLocale)))}" />`);
  for (const locale of configuredLocales) {
    urls.push([
      '  <url>',
      `    <loc>${escapeXml(absoluteUrl(archivePath(locale)))}</loc>`,
      ...archiveAlternates,
      '  </url>',
    ].join('\n'));
  }

  const collections = [
    { rows: getPublishedTranslations(), urlFor: postUrl },
    { rows: getPublishedPageTranslations(), urlFor: pageUrl },
  ];
  for (const collection of collections) {
    const groups = new Map();
    for (const row of collection.rows) {
      if (!groups.has(row.slug)) groups.set(row.slug, []);
      groups.get(row.slug).push(row);
    }
    for (const translations of groups.values()) {
      const xDefault = translations.find(row => row.locale === defaultLocale) || translations[0];
      const alternates = translations.map(row =>
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(row.locale)}" href="${escapeXml(absoluteUrl(collection.urlFor(row.locale, row.slug)))}" />`
      );
      alternates.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(absoluteUrl(collection.urlFor(xDefault.locale, xDefault.slug)))}" />`);
      for (const row of translations) {
        urls.push([
          '  <url>',
          `    <loc>${escapeXml(absoluteUrl(collection.urlFor(row.locale, row.slug)))}</loc>`,
          `    <lastmod>${escapeXml(sqliteDateToIso(row.updated_at) || row.published_at)}</lastmod>`,
          ...alternates,
          '  </url>',
        ].join('\n'));
      }
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
  const pages = getPublishedPageTranslations().map(row => {
    const note = articleDescription(row).replace(/\s+/g, ' ');
    return `- [${escapeMarkdownLabel(row.title)}](${absoluteUrl(`${pageUrl(row.locale, row.slug)}.md`)}): ${row.locale}; ${note}`;
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
    '## Pages',
    '',
    ...(pages.length ? pages : ['- 暂无已发布页面。']),
    '',
    '## Optional',
    '',
    `- [完整文章合集](${absoluteUrl('/llms-full.txt')}): 所有已发布语言版本的完整 Markdown 正文。`,
    `- [XML Sitemap](${absoluteUrl('/sitemap.xml')}): 所有可索引网页及语言版本。`,
    '',
  ].join('\n');
}

function buildLlmsFullText() {
  const articleSections = getPublishedTranslations().map(row => {
    const canonicalUrl = absoluteUrl(postUrl(row.locale, row.slug));
    return renderPostMarkdown(row, canonicalUrl);
  });
  const pageSections = getPublishedPageTranslations().map(row => {
    const canonicalUrl = absoluteUrl(pageUrl(row.locale, row.slug));
    return renderPageMarkdown(row, canonicalUrl);
  });
  const introduction = [
    `# ${blog.title} — Full Content`,
    '',
    `> ${blog.description.replace(/\s+/g, ' ')}`,
  ].join('\n');
  return [introduction, ...articleSections, ...pageSections].join('\n\n---\n\n');
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

function renderPageMarkdown(page, canonicalUrl) {
  const summary = String(page.summary || '').trim();
  return [
    `# ${page.title}`,
    '',
    ...(summary ? [`> ${summary.replace(/\s*\n\s*/g, ' ')}`, ''] : []),
    `- Language: ${page.rendered_locale || page.locale}`,
    `- Canonical: ${canonicalUrl}`,
    '',
    String(page.body || '').trim(),
    '',
  ].join('\n');
}

function buildRssFeed(locale, posts) {
  const selfUrl = absoluteUrl(feedPath(locale));
  const channelUrl = absoluteUrl(archivePath(locale));
  const items = posts.map(post => {
    const url = absoluteUrl(postUrl(locale, post.slug));
    const excerpt = archiveExcerpt(post, 320);
    const content = cdata(absolutizeFeedHtml(renderMarkdown(post.body)));
    return [
      '    <item>',
      `      <title>${rssXml(post.title)}</title>`,
      `      <link>${rssXml(url)}</link>`,
      `      <guid isPermaLink="true">${rssXml(url)}</guid>`,
      `      <pubDate>${rssXml(rssDate(post.published_at))}</pubDate>`,
      `      <description>${rssXml(excerpt)}</description>`,
      `      <content:encoded><![CDATA[${content}]]></content:encoded>`,
      '    </item>',
    ].join('\n');
  });
  const latestUpdate = posts.reduce((latest, post) => {
    const value = sqliteDateToIso(post.updated_at) || post.published_at;
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) || timestamp <= latest.timestamp ? latest : { timestamp, value };
  }, { timestamp: 0, value: null });
  const lastBuildDate = latestUpdate.value ? rssDate(latestUpdate.value) : new Date().toUTCString();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    <title>${rssXml(`${blog.title} — ${archiveTitle(locale)}`)}</title>`,
    `    <link>${rssXml(channelUrl)}</link>`,
    `    <description>${rssXml(archiveDescription(locale))}</description>`,
    `    <language>${rssXml(locale)}</language>`,
    `    <lastBuildDate>${rssXml(lastBuildDate)}</lastBuildDate>`,
    `    <atom:link href="${rssXml(selfUrl)}" rel="self" type="application/rss+xml" />`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function rssDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toUTCString() : date.toUTCString();
}

function rssXml(value) {
  return escapeXml(xmlSafeText(value));
}

function cdata(value) {
  return xmlSafeText(value).replaceAll(']]>', ']]]]><![CDATA[>');
}

function xmlSafeText(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

function absolutizeFeedHtml(html) {
  return String(html).replace(/\b(src|href)="(\/(?!\/)[^"]*)"/g, (match, attribute, pathname) => {
    return `${attribute}="${absoluteUrl(pathname)}"`;
  });
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function escapeMarkdownLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function localizePath(currentPath, locale) {
  if (currentPath === '/archive') return archivePath(locale);
  const postMatch = currentPath.match(/^\/post\/[^/]+\/([^/]+)$/);
  if (postMatch) return `/post/${encodeURIComponent(locale)}/${postMatch[1]}`;
  const pageMatch = currentPath.match(/^\/page\/[^/]+\/([^/]+)$/);
  if (pageMatch) return `/page/${encodeURIComponent(locale)}/${pageMatch[1]}`;
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
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      div: ['class'],
      span: ['class'],
      img: ['src', 'alt', 'title', 'loading'],
    },
    allowedClasses: { div: ['image-stack'], span: ['image-row'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' }) },
  });
}

function isImageOnlyParagraph(token) {
  return token.tokens.length > 0 && token.tokens.every(item =>
    item.type === 'image' || (item.type === 'text' && !item.raw.trim())
  );
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

function getPublishedPostsByExactLocale(locale) {
  return db.prepare(`
    SELECT p.*, t.title, t.summary, t.body, t.locale AS rendered_locale
    FROM posts p
    JOIN post_translations t ON t.post_id = p.id AND t.locale = ?
    WHERE p.status = 'published'
    ORDER BY p.published_at DESC, p.id DESC
  `).all(locale);
}

function archiveExcerpt(post, maxLength = 260) {
  const source = String(post.summary || '').trim() || String(post.body || '');
  const plainText = sanitizeHtml(marked.parse(source), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();
  if (plainText.length <= maxLength) return plainText;
  return `${plainText.slice(0, maxLength).trimEnd()}……`;
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

function getPageBySlug(slug, locale) {
  const page = db.prepare(`
    SELECT p.*, COALESCE(chosen.title, fallback.title) AS title,
      COALESCE(chosen.summary, fallback.summary, '') AS summary,
      COALESCE(chosen.body, fallback.body, '') AS body,
      CASE WHEN chosen.id IS NULL THEN ? ELSE ? END AS rendered_locale
    FROM pages p
    LEFT JOIN page_translations chosen ON chosen.page_id = p.id AND chosen.locale = ?
    LEFT JOIN page_translations fallback ON fallback.page_id = p.id AND fallback.locale = ?
    WHERE p.slug = ? AND COALESCE(chosen.id, fallback.id) IS NOT NULL
  `).get(defaultLocale, locale, locale, defaultLocale, slug);
  return page ? withPageLocales(page) : null;
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

function withPageLocales(page) {
  page.availableLocales = db.prepare('SELECT locale FROM page_translations WHERE page_id = ? ORDER BY locale').all(page.id).map(row => row.locale);
  return page;
}

function getPageForAdmin(id) {
  const base = db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
  if (!base) return null;
  base.translationList = db.prepare(`
    SELECT locale, title, summary, body FROM page_translations
    WHERE page_id = ? ORDER BY CASE WHEN locale = ? THEN 0 ELSE 1 END, locale
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

function emptyPage() {
  return {
    slug: '',
    status: 'draft',
    translationList: [{ locale: defaultLocale, title: '', summary: '', body: '' }],
  };
}

function pageFromBody(body) {
  const page = postFromBody(body);
  return { slug: page.slug, status: page.status, translationList: page.translationList };
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

const persistPage = db.transaction((id, data) => {
  const slug = String(data.slug || '').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) throw new Error('INVALID_SLUG');
  const status = data.status === 'published' ? 'published' : 'draft';
  let pageId = id;
  if (id) {
    db.prepare('UPDATE pages SET slug = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(slug, status, id);
  } else {
    pageId = Number(db.prepare('INSERT INTO pages (slug, status) VALUES (?, ?)').run(slug, status).lastInsertRowid);
  }
  const translations = parseSubmittedTranslations(data);
  db.prepare('DELETE FROM page_translations WHERE page_id = ?').run(pageId);
  const insertTranslation = db.prepare(`
    INSERT INTO page_translations (page_id, locale, title, summary, body) VALUES (?, ?, ?, ?, ?)
  `);
  for (const translation of translations) {
    insertTranslation.run(pageId, translation.locale, translation.title, translation.summary, translation.body);
  }
  return pageId;
});

function savePage(id, data) {
  return persistPage(id, data);
}

function getNavigationItems() {
  return db.prepare(`
    SELECT id, label, url, target, position
    FROM navigation_items
    ORDER BY position ASC, id ASC
  `).all();
}

function getNavigationItem(id) {
  return db.prepare(`
    SELECT id, label, url, target, position
    FROM navigation_items
    WHERE id = ?
  `).get(id);
}

function emptyNavigation() {
  return { label: '', url: '', target: 'self', position: 0 };
}

function navigationFromBody(body) {
  return {
    label: String(body.label || ''),
    url: String(body.url || ''),
    target: body.target === 'blank' ? 'blank' : 'self',
    position: String(body.position ?? '0'),
  };
}

function saveNavigation(id, data) {
  const label = String(data.label || '').trim();
  if (!label || label.length > 80) throw new Error('INVALID_NAVIGATION_LABEL');
  const url = normalizeNavigationUrl(data.url);
  const target = data.target === 'blank' ? 'blank' : 'self';
  const position = Number(data.position || 0);
  if (!Number.isInteger(position) || position < -9999 || position > 9999) throw new Error('INVALID_NAVIGATION_POSITION');
  if (id) {
    const result = db.prepare(`
      UPDATE navigation_items
      SET label = ?, url = ?, target = ?, position = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(label, url, target, position, id);
    if (!result.changes) throw new Error('NAVIGATION_NOT_FOUND');
    return id;
  }
  return Number(db.prepare(`
    INSERT INTO navigation_items (label, url, target, position)
    VALUES (?, ?, ?, ?)
  `).run(label, url, target, position).lastInsertRowid);
}

function normalizeNavigationUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.length > 2048 || /[\u0000-\u001F\u007F]/.test(url)) throw new Error('INVALID_NAVIGATION_URL');
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (url.startsWith('#') && !url.includes(' ')) return url;
  try {
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.toString();
  } catch {
    // The shared error below keeps invalid and unsafe schemes indistinguishable.
  }
  throw new Error('INVALID_NAVIGATION_URL');
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect(`${adminBasePath}/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

function requireCsrf(req, res, next) {
  const supplied = String(req.body?.csrf || req.get('x-csrf-token') || '');
  if (!req.session.csrf || !safeEqual(supplied, req.session.csrf)) return res.status(403).send('请求已过期，请刷新页面后重试。');
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
  if (error.message === 'NO_TRANSLATIONS') return '请至少添加一种语言的内容';
  if (error.message.startsWith('MISSING_TITLE:')) return `填写了翻译内容时，标题不能为空（${error.message.split(':')[1]}）`;
  if (error.message === 'INVALID_NAVIGATION_LABEL') return '导航名称不能为空，且不能超过 80 个字符';
  if (error.message === 'INVALID_NAVIGATION_URL') return '请输入站内 / 开头的地址、# 锚点或完整的 HTTP/HTTPS 地址';
  if (error.message === 'INVALID_NAVIGATION_POSITION') return '排序必须是 -9999 到 9999 之间的整数';
  if (error.message === 'NAVIGATION_NOT_FOUND') return '这个导航已经不存在';
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
      const name = languageName(code);
      if (name && name.toLowerCase() !== code) codes.add(code);
    }
  }
  return [...codes]
    .map(code => ({ code, name: languageName(code) }))
    .sort((left, right) => left.name.localeCompare(right.name, defaultLocale));
}

function languageName(code) {
  const locale = normalizeLocale(code);
  if (!locale) return String(code || '').toUpperCase();
  if (nativeLanguageNames.has(locale)) return nativeLanguageNames.get(locale);
  let name = locale.toUpperCase();
  try {
    name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale) || name;
  } catch {}
  nativeLanguageNames.set(locale, name);
  return name;
}
