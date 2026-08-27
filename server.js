import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import Database from 'better-sqlite3';
import express from 'express';
import session from 'express-session';
import { Lexer, marked, Renderer } from 'marked';
import multer from 'multer';
import sanitizeHtml from 'sanitize-html';
import { AdminLoginRateLimitError, createAdminLoginSecurity } from './lib/admin-login-security.js';
import { assertMailConfiguration, getMailStatus } from './lib/mailer.js';
import { createPasswordResetSecurity, createPasswordResetToken, createRegistrationSecurity, hashPassword, hashPasswordResetToken, isMemberEmail, MemberRateLimitError, normalizeEmail, sendRegistrationAdminNotification, validateManagedUserFields, validateMemberFields, validateNewPassword, verifyPassword } from './lib/member-security.js';
import { normalizePostCategory, POST_CATEGORIES } from './lib/post-categories.js';
import { sendPostEmail } from './lib/post-email.js';
import { SqliteSessionStore } from './lib/sqlite-session-store.js';
import { SubscriptionStore } from './lib/subscription-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;
const homePageSize = 10;
const adminBasePath = '/qiajigou';
const siteUrl = normalizeSiteUrl(process.env.SITE_URL || 'https://afterimage.photography');
assertMailConfiguration();
const mailStatus = getMailStatus();
const registrationNotificationEmail = normalizeEmail(process.env.MEMBER_REGISTRATION_NOTIFY_EMAIL || process.env.ADMIN_2FA_EMAIL);
if (registrationNotificationEmail && !isMemberEmail(registrationNotificationEmail)) {
  throw new Error('MEMBER_REGISTRATION_NOTIFY_EMAIL 必须是有效邮箱地址');
}
const adminLoginSecurity = createAdminLoginSecurity({
  recipient: process.env.ADMIN_2FA_EMAIL,
  mailConfigured: mailStatus.configured,
});
const registrationSecurity = createRegistrationSecurity({ mailConfigured: mailStatus.configured });
const passwordResetSecurity = createPasswordResetSecurity({ mailConfigured: mailStatus.configured });
if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET)) {
  throw new Error('生产环境必须设置 ADMIN_PASSWORD 和 SESSION_SECRET');
}
if (process.env.NODE_ENV === 'production' && !siteUrl.startsWith('https://')) {
  throw new Error('生产环境的 SITE_URL 必须使用 HTTPS，以安全发送密码重置链接');
}
const defaultLocale = normalizeLocale(process.env.DEFAULT_LOCALE || 'zh');
const configuredLocales = [...new Set((process.env.BLOG_LOCALES || 'zh,en,ja').split(',').map(normalizeLocale).filter(Boolean))];
const defaultPostEditorLocales = ['zh', 'en', 'ja'];
if (!defaultLocale) throw new Error('DEFAULT_LOCALE 不是有效的语言代码');
if (!configuredLocales.includes(defaultLocale)) configuredLocales.unshift(defaultLocale);

const nativeLanguageNames = new Map();
const languageOptions = buildLanguageOptions();
const blog = {
  title: process.env.BLOG_TITLE || 'AFTERIMAGE PHOTOGRAPHY',
  description: process.env.BLOG_DESCRIPTION || '一个关于摄影、观看与生活的个人博客。',
  author: process.env.BLOG_AUTHOR || 'GuoJing',
};
const socialUrls = normalizeSocialUrls(process.env.BLOG_SOCIAL_URLS);
const seoCopyByLocale = buildSeoCopy();
const archiveCopy = {
  zh: { title: '归档', description: '按时间浏览所有已发布文章。' },
  en: { title: 'Archive', description: 'Browse all published posts by date.' },
  ja: { title: 'アーカイブ', description: '公開済みの記事を日付順に表示します。' },
};
const homePaginationCopy = {
  zh: { previous: '上一页', next: '下一页', navigation: '文章分页', page: number => `第 ${number} 页` },
  en: { previous: 'Previous', next: 'Next', navigation: 'Article pagination', page: number => `Page ${number}` },
  ja: { previous: '前のページ', next: '次のページ', navigation: '記事のページナビゲーション', page: number => `${number}ページ` },
};
const galleryThemes = [
  { id: 'masonry', name: '瀑布流', description: '保留照片原始比例，自然向下排列。' },
  { id: 'grid', name: '平铺网格', description: '统一画幅和列数，呈现规整的作品墙。' },
  { id: 'fade', name: '渐隐画廊', description: '以单张大图渐变切换，适合叙事浏览。' },
  { id: 'justified', name: '智能拼接', description: '按照片比例自动组合成宽度一致的图片行。' },
];
const galleryThemeIds = new Set(galleryThemes.map(theme => theme.id));
const galleryThemeDefaults = {
  masonry: { columnsDesktop: 4, columnsTablet: 3, gap: 16, showCaptions: true },
  grid: { columnsDesktop: 4, columnsTablet: 2, gap: 12, aspectRatio: '3:2', imageFit: 'cover' },
  fade: { autoplay: true, intervalMs: 5000, transitionMs: 900, imageFit: 'contain', showThumbnails: true },
  justified: { targetRowHeight: 320, maxRowHeight: 480, gap: 10, lastRow: 'left', showCaptions: false },
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
    author TEXT NOT NULL DEFAULT 'GuoJing',
    category TEXT NOT NULL DEFAULT '',
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

  CREATE TABLE IF NOT EXISTS galleries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT 'GuoJing',
    published_at TEXT NOT NULL,
    cover_photo_id INTEGER,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS gallery_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    taken_at TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS gallery_photos_gallery_position
  ON gallery_photos(gallery_id, position, id);

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT NOT NULL DEFAULT '',
    membership_level INTEGER NOT NULL DEFAULT 0 CHECK (membership_level >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    session_version INTEGER NOT NULL DEFAULT 0,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

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
`);
const postColumns = new Set(db.prepare('PRAGMA table_info(posts)').all().map(column => column.name));
if (!postColumns.has('author')) db.exec("ALTER TABLE posts ADD COLUMN author TEXT NOT NULL DEFAULT 'GuoJing'");
if (!postColumns.has('category')) db.exec("ALTER TABLE posts ADD COLUMN category TEXT NOT NULL DEFAULT ''");
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
if (!userColumns.has('session_version')) db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at < datetime('now', '-1 day'))").run(Date.now());
ensureGallerySlugSchema();
const subscriptionStore = new SubscriptionStore(db, { defaultLocale });
const postDeliveryLocks = new Set();

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
const sessionStore = new SqliteSessionStore({ db, ttlMs: sessionTtlMs });
app.use(session({
  name: 'afterimage.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.TRUST_PROXY === '1',
    maxAge: sessionTtlMs,
  },
}));

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1, fields: 12, fieldSize: 16 * 1024 },
});

app.use((req, res, next) => {
  const locale = pickLocale(req);
  const isAdminPath = req.path === adminBasePath || req.path.startsWith(`${adminBasePath}/`);
  const isAccountPath = req.path === '/account' || req.path.startsWith('/account/');
  if (isAdminPath) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
  }
  if (isAccountPath || req.path === '/subscribe') {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
  }
  res.locals.blog = blog;
  res.locals.siteUrl = siteUrl;
  res.locals.siteImageUrl = absoluteUrl('/apple-touch-icon.png');
  res.locals.locales = configuredLocales.map(code => ({ code, name: languageName(code) }));
  res.locals.languageOptions = languageOptions;
  res.locals.languageName = languageName;
  res.locals.postCategoryOptions = POST_CATEGORIES;
  res.locals.navigationItems = isAdminPath ? [] : getNavigationItems();
  res.locals.isNavigationActive = isNavigationActive;
  res.locals.adminBasePath = adminBasePath;
  res.locals.currentUser = getCurrentUser(req);
  res.locals.accountUrl = accountUrl(locale);
  res.locals.accountLabel = accountCopy(locale).login;
  res.locals.currentPath = req.path;
  res.locals.languageSwitchPath = req.originalUrl;
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
  res.locals.datetimeLocalValue = datetimeLocalValue;
  res.locals.galleryThemes = galleryThemes;
  setResponseLocale(res, locale);
  next();
});

app.get('/', (req, res) => {
  const page = parseHomePage(req.query.page);
  if (!page) return res.status(404).render('not-found');
  const selectedLocale = getSelectedLocale(req);
  const requestedLocale = parameterLocale(req);
  if (selectedLocale && selectedLocale !== requestedLocale) {
    return res.redirect(302, homePath(selectedLocale, page));
  }
  const totalPosts = countPublishedPosts(res.locals.locale);
  const totalPages = Math.max(1, Math.ceil(totalPosts / homePageSize));
  if (page > totalPages) return res.status(404).render('not-found');
  const posts = getPublishedPosts(res.locals.locale, homePageSize, (page - 1) * homePageSize);
  const canonicalUrl = absoluteUrl(homePath(res.locals.locale, page));
  const alternateUrls = configuredLocales.map(code => ({ locale: code, url: absoluteUrl(homePath(code, page)) }));
  const homeSeo = seoCopy(res.locals.locale);
  const paginationCopy = homePaginationCopy[res.locals.locale] || homePaginationCopy.en;
  const documentTitle = page === 1 ? homeSeo.title : `${homeSeo.title} — ${paginationCopy.page(page)}`;
  const description = page === 1 ? homeSeo.description : `${homeSeo.description} ${paginationCopy.page(page)}`;
  const previousUrl = page > 1 ? homePath(res.locals.locale, page - 1) : null;
  const nextUrl = page < totalPages ? homePath(res.locals.locale, page + 1) : null;
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${absoluteUrl('/')}#website`,
        name: blog.title,
        description: homeSeo.description,
        inLanguage: res.locals.locale,
        url: absoluteUrl(homePath(res.locals.locale)),
        publisher: { '@id': `${absoluteUrl('/')}#organization` },
      },
      publisherStructuredData(),
      personStructuredData(blog.author, res.locals.locale),
    ],
  };
  res.render('home', {
    posts,
    renderMarkdown,
    canonicalUrl,
    alternateUrls,
    xDefaultUrl: absoluteUrl(homePath(defaultLocale, page)),
    previousUrl,
    nextUrl,
    structuredData,
    description,
    documentTitle,
    homeSeo,
    page,
    paginationCopy,
  });
});

app.get('/archive', (req, res) => {
  const requestedLocale = parameterLocale(req);
  const selectedLocale = getSelectedLocale(req);
  if (selectedLocale && selectedLocale !== requestedLocale) {
    return res.redirect(302, archivePath(selectedLocale));
  }
  const locale = selectedLocale || requestedLocale;
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

app.get('/topics', (req, res) => {
  const locale = preferredParameterizedLocale(req, res, '/topics');
  if (!locale) return;
  const topics = getTopics(locale);
  const copy = seoCopy(locale);
  const canonicalUrl = absoluteUrl(topicsPath(locale));
  const alternateUrls = configuredLocales.map(code => ({ locale: code, url: absoluteUrl(topicsPath(code)) }));
  const description = copy.topicsDescription;
  const structuredData = collectionStructuredData(copy.topicsTitle, description, canonicalUrl, locale,
    topics.map(topic => ({ name: topic.name, url: absoluteUrl(topicPath(topic.slug, locale)) })));
  res.render('topics', {
    topics,
    description,
    canonicalUrl,
    alternateUrls,
    xDefaultUrl: absoluteUrl(topicsPath(defaultLocale)),
    structuredData,
    htmlLang: locale,
    pageTitle: copy.topicsTitle,
    copy,
  });
});

app.get('/topics/:slug', (req, res) => {
  const locale = preferredParameterizedLocale(req, res, `/topics/${encodeURIComponent(req.params.slug)}`);
  if (!locale) return;
  const topic = getTopic(req.params.slug, locale);
  if (!topic) return res.status(404).render('not-found');
  const availableLocales = configuredLocales.filter(code => getTopic(req.params.slug, code));
  const canonicalUrl = absoluteUrl(topicPath(topic.slug, locale));
  const alternateUrls = availableLocales.map(code => ({ locale: code, url: absoluteUrl(topicPath(topic.slug, code)) }));
  const copy = seoCopy(locale);
  const description = localizedTopicDescription(topic.name, topic.posts.length, locale);
  const structuredData = collectionStructuredData(topic.name, description, canonicalUrl, locale,
    topic.posts.map(post => ({ name: post.title, url: absoluteUrl(postUrl(locale, post.slug)) })));
  res.render('topic', {
    topic,
    description,
    canonicalUrl,
    alternateUrls,
    xDefaultUrl: absoluteUrl(topicPath(topic.slug, availableLocales.includes(defaultLocale) ? defaultLocale : locale)),
    structuredData,
    htmlLang: locale,
    copy,
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
  const requestedLocale = normalizeLocale(req.params.locale);
  if (!requestedLocale) return res.status(404).render('not-found');
  const selectedLocale = getSelectedLocale(req);
  if (selectedLocale && selectedLocale !== requestedLocale) {
    return res.redirect(302, postUrl(selectedLocale, req.params.slug));
  }
  const locale = selectedLocale || requestedLocale;
  setResponseLocale(res, locale);
  const post = getPostBySlug(req.params.slug, locale);
  if (!post || (post.status !== 'published' && !req.session.isAdmin)) return res.status(404).render('not-found');
  const canonicalUrl = absoluteUrl(postUrl(post.rendered_locale, post.slug));
  const alternateUrls = post.availableLocales.map(code => ({ locale: code, url: absoluteUrl(postUrl(code, post.slug)) }));
  const xDefaultLocale = post.availableLocales.includes(defaultLocale) ? defaultLocale : post.rendered_locale;
  const markdownUrl = absoluteUrl(`${postUrl(post.rendered_locale, post.slug)}.md`);
  const description = articleDescription(post);
  const image = extractFirstImage(post.body) || absoluteUrl('/apple-touch-icon.png');
  const authorUrl = absoluteUrl(pageUrl(post.rendered_locale, 'about'));
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
    author: { '@type': 'Person', name: post.author, url: authorUrl },
    publisher: publisherStructuredData(),
  };
  const relatedPosts = getRelatedPosts(post, post.rendered_locale);
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
    ogImageAlt: post.title,
    authorName: post.author,
    articleAuthorUrl: authorUrl,
    articleSection: post.category,
    publishedAt: post.published_at,
    modifiedAt: sqliteDateToIso(post.updated_at),
    relatedPosts,
    authorUrl: pageUrl(post.rendered_locale, 'about'),
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
  const requestedLocale = normalizeLocale(req.params.locale);
  if (!requestedLocale) return res.status(404).render('not-found');
  const selectedLocale = getSelectedLocale(req);
  if (selectedLocale && selectedLocale !== requestedLocale) {
    return res.redirect(302, pageUrl(selectedLocale, req.params.slug));
  }
  const locale = selectedLocale || requestedLocale;
  setResponseLocale(res, locale);
  const page = getPageBySlug(req.params.slug, locale);
  if (!page || (page.status !== 'published' && !req.session.isAdmin)) return res.status(404).render('not-found');
  const canonicalUrl = absoluteUrl(pageUrl(page.rendered_locale, page.slug));
  const alternateUrls = page.availableLocales.map(code => ({ locale: code, url: absoluteUrl(pageUrl(code, page.slug)) }));
  const xDefaultLocale = page.availableLocales.includes(defaultLocale) ? defaultLocale : page.rendered_locale;
  const markdownUrl = absoluteUrl(`${pageUrl(page.rendered_locale, page.slug)}.md`);
  const description = articleDescription(page);
  const image = extractFirstImage(page.body) || absoluteUrl('/apple-touch-icon.png');
  const webPageData = {
    '@type': 'WebPage',
    '@id': `${canonicalUrl}#webpage`,
    name: page.title,
    description,
    image,
    dateModified: sqliteDateToIso(page.updated_at),
    inLanguage: page.rendered_locale,
    url: canonicalUrl,
    publisher: { '@id': `${absoluteUrl('/')}#organization` },
  };
  const structuredData = page.slug.toLowerCase() === 'about'
    ? {
        '@context': 'https://schema.org',
        '@graph': [
          webPageData,
          { ...personStructuredData(blog.author, page.rendered_locale), mainEntityOfPage: { '@id': `${canonicalUrl}#webpage` } },
          publisherStructuredData(),
        ],
      }
    : { '@context': 'https://schema.org', ...webPageData };
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
    ogImageAlt: page.title,
    authorName: page.slug.toLowerCase() === 'about' ? blog.author : undefined,
    documentTitle: page.slug.toLowerCase() === 'about' ? `${blog.author} — Photographer | ${blog.title}` : '',
    modifiedAt: sqliteDateToIso(page.updated_at),
    robots: page.status === 'published'
      ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      : 'noindex, nofollow, noarchive',
  });
});

app.get('/galleries', (req, res) => {
  const galleries = getGalleriesForPublic();
  const canonicalUrl = absoluteUrl('/galleries');
  const description = `Browse ${blog.title} photo collections.`;
  const previewPhoto = galleries.find(gallery => gallery.preview_photos.length)?.preview_photos[0];
  const image = previewPhoto?.image_url ? absoluteUrl(previewPhoto.image_url) : absoluteUrl('/apple-touch-icon.png');
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `Collections — ${blog.title}`,
    description,
    url: canonicalUrl,
    image,
    publisher: publisherStructuredData(),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: galleries.length,
      itemListElement: galleries.map((gallery, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: gallery.name,
        url: absoluteUrl(galleryUrl(gallery.slug)),
      })),
    },
  };
  res.render('galleries', {
    galleries,
    description,
    canonicalUrl,
    structuredData,
    ogType: 'website',
    ogImage: image,
    ogImageAlt: 'Photography collections',
  });
});

app.get('/gallery', (req, res) => {
  res.redirect(301, '/galleries');
});

app.get(/^\/gallery\/([^/]+)\.md$/, (req, res) => {
  const gallery = getGalleryBySlug(req.params[0]);
  if (!gallery) return res.status(404).type('text').send('Not found');
  const canonicalUrl = absoluteUrl(galleryUrl(gallery.slug));
  res.set('Link', `<${canonicalUrl}>; rel="canonical", <${absoluteUrl('/llms.txt')}>; rel="describedby"`);
  res.type('text/markdown; charset=utf-8').send(renderGalleryMarkdown(gallery, canonicalUrl));
});

app.get('/gallery/:slug', (req, res) => {
  const gallery = getGalleryBySlug(req.params.slug);
  if (!gallery) return res.status(404).render('not-found');
  const canonicalUrl = absoluteUrl(galleryUrl(gallery.slug));
  const description = gallery.description || `${gallery.name} — ${gallery.photos.length} photos by ${gallery.author}`;
  const coverPhoto = gallery.photos.find(photo => photo.id === Number(gallery.cover_photo_id)) || gallery.photos[0];
  const image = coverPhoto?.image_url ? absoluteUrl(coverPhoto.image_url) : absoluteUrl('/apple-touch-icon.png');
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'ImageGallery',
    name: gallery.name,
    description,
    url: canonicalUrl,
    image,
    datePublished: gallery.published_at,
    dateModified: sqliteDateToIso(gallery.updated_at),
    author: { '@type': 'Person', name: gallery.author, url: absoluteUrl(pageUrl(res.locals.locale, 'about')) },
    publisher: publisherStructuredData(),
    associatedMedia: gallery.photos.map(photo => ({
      '@type': 'ImageObject',
      contentUrl: absoluteUrl(photo.image_url),
      ...(photo.description ? { caption: photo.description } : {}),
      ...(photo.taken_at ? { dateCreated: photo.taken_at } : {}),
    })),
  };
  res.render('gallery', {
    gallery,
    description,
    canonicalUrl,
    structuredData,
    ogType: 'website',
    ogImage: image,
    ogImageAlt: gallery.name,
    authorName: gallery.author,
    markdownUrl: absoluteUrl(`${galleryUrl(gallery.slug)}.md`),
    publishedAt: gallery.published_at,
    modifiedAt: sqliteDateToIso(gallery.updated_at),
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
  const canSelectLocale = isAvailableLocale(locale);
  if (canSelectLocale) {
    res.cookie('afterimage.locale', locale, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000 });
  }
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//')
    ? req.query.next
    : '/';
  res.redirect(canSelectLocale ? localizePath(next, locale) : next);
});

app.get('/account', (req, res) => {
  renderAccount(req, res);
});

app.post('/account/forgot', async (req, res) => {
  const responseStartedAt = Date.now();
  if (!validMemberCsrf(req)) return renderAccount(req, res.status(403), { mode: 'forgot', errorCode: 'EXPIRED_FORM' });
  if (!passwordResetSecurity.ready) return renderAccount(req, res.status(503), { mode: 'forgot', errorCode: 'MAIL_UNAVAILABLE' });
  const email = normalizeEmail(req.body.email);
  if (!isMemberEmail(email)) return renderAccount(req, res.status(400), { mode: 'forgot', errorCode: 'INVALID_EMAIL', fields: { email } });

  try {
    passwordResetSecurity.consumeRequest(email, req.ip);
  } catch (error) {
    return handleMemberRateLimit(req, res, error, 'forgot', { email });
  }

  const user = db.prepare("SELECT id, email FROM users WHERE email = ? COLLATE NOCASE AND status = 'active' LIMIT 1").get(email);
  if (user) {
    const reset = createPasswordResetRecord(user.id, res.locals.locale);
    setImmediate(() => passwordResetSecurity.sendResetEmail({ to: user.email, resetUrl: reset.resetUrl, locale: res.locals.locale })
      .catch(error => console.error('会员密码重置邮件发送失败：', error)));
  }

  await waitForMinimumDuration(responseStartedAt, 150);
  res.redirect(`${accountUrl(res.locals.locale)}&mode=forgot&sent=1`);
});

app.get('/account/reset', async (req, res) => {
  try {
    passwordResetSecurity.consumeTokenAttempt(req.ip);
  } catch (error) {
    return handleMemberRateLimit(req, res, error, 'reset');
  }

  if (typeof req.query.token === 'string') {
    const tokenHash = hashPasswordResetToken(req.query.token);
    const reset = tokenHash ? findValidPasswordReset(tokenHash) : null;
    await regenerateSession(req);
    if (reset) req.session.pendingPasswordReset = tokenHash;
    req.session.memberCsrf = createLoginCsrf();
    await saveSession(req);
    return res.redirect(303, `${accountResetUrl(res.locals.locale)}${reset ? '' : '&invalid=1'}`);
  }

  const reset = getPendingPasswordReset(req);
  if (!reset) delete req.session.pendingPasswordReset;
  return renderAccount(req, res, {
    mode: 'reset',
    errorCode: !reset || req.query.invalid === '1' ? 'INVALID_RESET_TOKEN' : null,
    resetAvailable: Boolean(reset),
  });
});

app.post('/account/reset', async (req, res) => {
  if (!validMemberCsrf(req)) return renderAccount(req, res.status(403), { mode: 'reset', errorCode: 'EXPIRED_FORM', resetAvailable: Boolean(getPendingPasswordReset(req)) });
  try {
    passwordResetSecurity.consumeTokenAttempt(req.ip);
  } catch (error) {
    return handleMemberRateLimit(req, res, error, 'reset');
  }
  const reset = getPendingPasswordReset(req);
  if (!reset) return renderAccount(req, res.status(400), { mode: 'reset', errorCode: 'INVALID_RESET_TOKEN', resetAvailable: false });

  let password;
  try {
    password = validateNewPassword({ ...req.body, username: reset.username, email: reset.email });
  } catch (error) {
    return renderAccount(req, res.status(400), { mode: 'reset', errorCode: error.code || 'INVALID_REGISTRATION', resetAvailable: true });
  }

  try {
    const passwordHash = await hashPassword(password);
    const changedUser = db.transaction(() => {
      const current = findValidPasswordReset(req.session.pendingPasswordReset);
      if (!current) return null;
      db.prepare(`
        UPDATE users
        SET password_hash = ?, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'active'
      `).run(passwordHash, current.user_id);
      db.prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(current.user_id);
      return current;
    })();
    if (!changedUser) {
      delete req.session.pendingPasswordReset;
      return renderAccount(req, res.status(400), { mode: 'reset', errorCode: 'INVALID_RESET_TOKEN', resetAvailable: false });
    }

    await regenerateSession(req);
    req.session.memberCsrf = createLoginCsrf();
    await saveSession(req);
    setImmediate(() => passwordResetSecurity.sendPasswordChangedEmail({ to: changedUser.email, locale: res.locals.locale })
      .catch(error => console.error('会员密码修改通知邮件发送失败：', error)));
    return res.redirect(`${accountUrl(res.locals.locale)}&reset=1`);
  } catch (error) {
    console.error('会员密码重置失败：', error);
    return renderAccount(req, res.status(500), { mode: 'reset', errorCode: 'RESET_FAILED', resetAvailable: true });
  }
});

app.post('/account/login', async (req, res) => {
  if (!validMemberCsrf(req)) return renderAccount(req, res.status(403), { mode: 'login', errorCode: 'EXPIRED_FORM' });
  const rawIdentifier = String(req.body.identifier || '').trim().toLowerCase();
  const identifier = rawIdentifier.slice(0, 254);
  try {
    registrationSecurity.consumeLoginAttempt(req.ip, identifier);
  } catch (error) {
    return handleMemberRateLimit(req, res, error, 'login');
  }

  const user = db.prepare(`
    SELECT id, password_hash, status, session_version
    FROM users
    WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE
    LIMIT 1
  `).get(identifier, identifier);
  const rawPassword = String(req.body.password || '');
  const passwordValid = await verifyPassword(rawPassword.length <= 128 ? rawPassword : '', user?.password_hash);
  if (!user || user.status !== 'active' || !passwordValid) {
    return renderAccount(req, res.status(401), {
      mode: 'login',
      errorCode: 'INVALID_LOGIN',
      fields: { identifier, remember: req.body.remember === '1' },
    });
  }

  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  try {
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.userSessionVersion = user.session_version;
    req.session.memberCsrf = createLoginCsrf();
    req.session.cookie.maxAge = req.body.remember === '1' ? sessionTtlMs : null;
    await saveSession(req);
    res.redirect(accountUrl(res.locals.locale));
  } catch {
    res.status(500).send('无法创建登录会话');
  }
});

app.post('/account/register/code', async (req, res) => {
  const wantsJson = req.is('application/json') || req.accepts(['json', 'html']) === 'json';
  if (!validMemberCsrf(req)) return memberCodeResponse(req, res.status(403), wantsJson, 'EXPIRED_FORM');
  if (!registrationSecurity.ready) return memberCodeResponse(req, res.status(503), wantsJson, 'MAIL_UNAVAILABLE');
  const email = normalizeEmail(req.body.email);
  if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email)) {
    return memberCodeResponse(req, res.status(409), wantsJson, 'EMAIL_EXISTS');
  }

  try {
    const challenge = await registrationSecurity.issueCode(email, req.ip, res.locals.locale);
    registrationSecurity.invalidateChallenge(req.session.registrationChallenge);
    req.session.registrationChallenge = challenge.id;
    req.session.registrationEmail = email;
    req.session.registrationNextSendAt = challenge.nextSendAt;
    await saveSession(req);
    if (wantsJson) return res.json({ ok: true, message: accountCopy(res.locals.locale).codeSent, retryAfterSeconds: 120 });
    res.redirect(`${accountUrl(res.locals.locale)}&mode=register&sent=1`);
  } catch (error) {
    if (error instanceof MemberRateLimitError) {
      res.set('Retry-After', String(error.retryAfterSeconds));
      if (wantsJson) return res.status(429).json({ ok: false, message: accountCopy(res.locals.locale).tooMany, retryAfterSeconds: error.retryAfterSeconds });
      return renderAccount(req, res.status(429), { mode: 'register', errorCode: 'TOO_MANY', retryAfterSeconds: error.retryAfterSeconds, fields: { email } });
    }
    if (error.code === 'INVALID_EMAIL') return memberCodeResponse(req, res.status(400), wantsJson, 'INVALID_EMAIL', { email });
    console.error('会员注册验证码发送失败：', error);
    return memberCodeResponse(req, res.status(502), wantsJson, 'CODE_SEND_FAILED', { email });
  }
});

app.post('/account/register', consumeMemberRegistrationAttempt, parseAvatarUpload, async (req, res) => {
  if (!validMemberCsrf(req)) return renderAccount(req, res.status(403), { mode: 'register', errorCode: 'EXPIRED_FORM' });
  let fields;
  try {
    fields = validateMemberFields(req.body);
  } catch (error) {
    return renderAccount(req, res.status(400), { mode: 'register', errorCode: error.code || 'INVALID_REGISTRATION', fields: memberFormFields(req.body) });
  }
  const safeFields = memberFormFields(fields);

  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(fields.username)) {
    return renderAccount(req, res.status(409), { mode: 'register', errorCode: 'USERNAME_EXISTS', fields: safeFields });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(fields.email)) {
    return renderAccount(req, res.status(409), { mode: 'register', errorCode: 'EMAIL_EXISTS', fields: safeFields });
  }

  let avatarType = null;
  if (req.file) {
    avatarType = detectImageType(req.file.buffer);
    if (!avatarType || !['jpg', 'png', 'webp', 'avif'].includes(avatarType.extension)) {
      return renderAccount(req, res.status(415), { mode: 'register', errorCode: 'INVALID_AVATAR', fields: safeFields });
    }
  }

  const challengeMatches = req.session.registrationEmail === fields.email;
  let codeResult;
  try {
    codeResult = challengeMatches
      ? registrationSecurity.verifyCode(req.session.registrationChallenge, fields.email, req.ip, req.body.code)
      : { status: 'missing' };
  } catch (error) {
    return handleMemberRateLimit(req, res, error, 'register', safeFields);
  }
  if (codeResult.status !== 'ok') {
    if (['expired', 'locked', 'missing'].includes(codeResult.status)) clearRegistrationChallenge(req);
    const errorCode = codeResult.status === 'invalid' ? 'INVALID_CODE' : 'EXPIRED_CODE';
    return renderAccount(req, res.status(400), { mode: 'register', errorCode, fields: safeFields });
  }
  clearRegistrationChallenge(req);

  try {
    const passwordHash = await hashPassword(fields.password);
    const avatarUrl = req.file ? await storeImage(req.file.buffer, avatarType, req.file.originalname, 'avatars') : '';
    const result = db.prepare(`
      INSERT INTO users (username, email, nickname, password_hash, avatar_url, membership_level)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(fields.username, fields.email, fields.nickname, passwordHash, avatarUrl);
    await regenerateSession(req);
    req.session.userId = Number(result.lastInsertRowid);
    req.session.userSessionVersion = 0;
    req.session.memberCsrf = createLoginCsrf();
    await saveSession(req);
    if (registrationNotificationEmail) {
      const newUser = { id: Number(result.lastInsertRowid), username: fields.username, email: fields.email, nickname: fields.nickname };
      setImmediate(() => sendRegistrationAdminNotification({
        to: registrationNotificationEmail,
        user: newUser,
        reviewUrl: absoluteUrl(`${adminBasePath}/users/${newUser.id}/edit`),
      }).catch(error => console.error('新会员注册通知邮件发送失败：', error)));
    }
    res.redirect(`${accountUrl(res.locals.locale)}&registered=1`);
  } catch (error) {
    console.error('会员注册失败：', error);
    const errorCode = String(error.message).includes('users.username') ? 'USERNAME_EXISTS'
      : String(error.message).includes('users.email') ? 'EMAIL_EXISTS' : 'REGISTRATION_FAILED';
    renderAccount(req, res.status(500), { mode: 'register', errorCode, fields: safeFields });
  }
});

app.post('/account/logout', (req, res) => {
  if (!validMemberCsrf(req)) return res.status(403).send('请求已过期，请刷新页面后重试。');
  delete req.session.userId;
  delete req.session.userSessionVersion;
  req.session.memberCsrf = createLoginCsrf();
  res.redirect(accountUrl(res.locals.locale));
});

app.get('/subscribe', requireMember, (req, res) => {
  if (!req.session.memberCsrf) req.session.memberCsrf = createLoginCsrf();
  const currentUser = res.locals.currentUser;
  res.render('subscribe', {
    copy: subscribeCopy(res.locals.locale),
    subscription: subscriptionStore.getPreferences(currentUser.id, res.locals.locale),
    memberCsrf: req.session.memberCsrf,
    saved: req.query.saved === '1',
    currentUser,
  });
});

app.post('/subscribe', requireMember, (req, res) => {
  if (!validMemberCsrf(req)) return res.status(403).send('请求已过期，请刷新页面后重试。');
  subscriptionStore.savePreferences(res.locals.currentUser.id, {
    locale: res.locals.locale,
    newPosts: req.body.new_posts === '1',
    newsletter: req.body.newsletter === '1',
    events: req.body.events === '1',
  });
  res.redirect(`/subscribe?lang=${encodeURIComponent(res.locals.locale)}&saved=1`);
});

app.get(`${adminBasePath}/login`, (req, res) => {
  if (req.session.isAdmin) return res.redirect(adminBasePath);
  renderAdminLogin(req, res);
});

app.post(`${adminBasePath}/login`, async (req, res) => {
  if (req.session.isAdmin) return res.redirect(adminBasePath);
  if (!validLoginCsrf(req)) return renderAdminLogin(req, res.status(403), { error: '登录页面已过期，请刷新后重试。' });
  if (!adminLoginSecurity.ready) return renderAdminLogin(req, res.status(503), { error: '登录暂时不可用，请稍后再试。' });

  try {
    adminLoginSecurity.consumePasswordAttempt(req.ip);
  } catch (error) {
    return handleLoginRateLimit(req, res, error);
  }

  const supplied = String(req.body.password || '');
  const expected = process.env.ADMIN_PASSWORD || 'change-me-now';
  if (!safeSecretEqual(supplied, expected)) {
    return renderAdminLogin(req, res.status(401), { error: '登录信息不正确。' });
  }

  try {
    await regenerateSession(req);
    const challenge = await adminLoginSecurity.issueCode(req.ip);
    req.session.pendingAdminChallenge = challenge.id;
    req.session.loginCsrf = createLoginCsrf();
    await saveSession(req);
    res.redirect(`${adminBasePath}/login`);
  } catch (error) {
    if (error instanceof AdminLoginRateLimitError) return handleLoginRateLimit(req, res, error);
    console.error('后台登录验证码发送失败：', error);
    renderAdminLogin(req, res.status(502), { error: '验证码发送失败，请稍后再试。' });
  }
});

app.post(`${adminBasePath}/login/code`, async (req, res) => {
  if (req.session.isAdmin) return res.redirect(adminBasePath);
  if (!validLoginCsrf(req)) return renderAdminLogin(req, res.status(403), { error: '登录页面已过期，请刷新后重试。' });

  const challengeId = req.session.pendingAdminChallenge;
  let result;
  try {
    result = adminLoginSecurity.verifyCode(challengeId, req.ip, req.body.code);
  } catch (error) {
    return handleLoginRateLimit(req, res, error);
  }

  if (result.status !== 'ok') {
    if (['expired', 'locked', 'missing'].includes(result.status)) delete req.session.pendingAdminChallenge;
    const error = result.status === 'invalid'
      ? `验证码不正确${result.attemptsRemaining ? `，还可尝试 ${result.attemptsRemaining} 次` : ''}。`
      : '验证码已失效，请重新输入密码登录。';
    return renderAdminLogin(req, res.status(401), { error });
  }

  delete req.session.pendingAdminChallenge;
  try {
    await regenerateSession(req);
    req.session.isAdmin = true;
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    await saveSession(req);
    res.redirect(adminBasePath);
  } catch {
    res.status(500).send('无法创建登录会话');
  }
});

app.post(`${adminBasePath}/login/reset`, async (req, res) => {
  if (req.session.isAdmin) return res.redirect(adminBasePath);
  if (!validLoginCsrf(req)) return renderAdminLogin(req, res.status(403), { error: '登录页面已过期，请刷新后重试。' });
  adminLoginSecurity.invalidateChallenge(req.session.pendingAdminChallenge);
  try {
    await regenerateSession(req);
    res.redirect(`${adminBasePath}/login`);
  } catch {
    res.status(500).send('无法重置登录会话');
  }
});

app.post(`${adminBasePath}/logout`, requireAdmin, requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect(`${adminBasePath}/login`));
});

app.get(adminBasePath, requireAdmin, (req, res) => {
  const posts = db.prepare(`
    SELECT p.*, COALESCE(t.title,
      (SELECT title FROM post_translations WHERE post_id = p.id ORDER BY id LIMIT 1), p.slug) AS title,
      (SELECT group_concat(locale, ', ') FROM post_translations WHERE post_id = p.id) AS translation_locales,
      (SELECT COUNT(*) FROM users u
        WHERE u.status = 'active' AND NOT EXISTS (
          SELECT 1 FROM user_subscription_opt_outs opt_out
          WHERE opt_out.user_id = u.id AND opt_out.subscription_type = 'new_posts'
        )) AS subscriber_count,
      (SELECT COUNT(*) FROM post_email_deliveries d WHERE d.post_id = p.id AND d.sent_at IS NOT NULL) AS sent_count
    FROM posts p
    LEFT JOIN post_translations t ON t.post_id = p.id AND t.locale = ?
    ORDER BY COALESCE(p.published_at, p.created_at) DESC
  `).all(defaultLocale);
  res.render('admin/index', { posts, csrf: req.session.csrf });
});

app.get(`${adminBasePath}/users`, requireAdmin, (req, res) => {
  res.render('admin/users', { users: getUsersForAdmin(), csrf: req.session.csrf });
});

app.get(`${adminBasePath}/users/new`, requireAdmin, (req, res) => {
  renderAdminUserForm(req, res, { user: emptyManagedUser(), isNew: true });
});

app.post(`${adminBasePath}/users`, requireAdmin, requireCsrf, async (req, res) => {
  let user;
  try {
    user = validateManagedUser(req.body);
    assertManagedUserUnique(user);
    const result = db.prepare(`
      INSERT INTO users (username, email, nickname, password_hash, membership_level, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.username, user.email, user.nickname, unusablePasswordHash(), user.membership_level, user.status);
    const created = getUserForAdmin(Number(result.lastInsertRowid));
    const resetStatus = created.status === 'active'
      ? await sendAdminPasswordReset(created, req.ip, res.locals.locale)
      : 'blocked';
    return res.redirect(`${adminBasePath}/users/${created.id}/edit?created=1&reset=${encodeURIComponent(resetStatus)}`);
  } catch (error) {
    return renderAdminUserForm(req, res.status(400), {
      user: user || managedUserFromBody(req.body),
      isNew: true,
      error: managedUserError(error),
    });
  }
});

app.get(`${adminBasePath}/users/:id/edit`, requireAdmin, (req, res) => {
  const user = getUserForAdmin(Number(req.params.id));
  if (!user) return res.status(404).render('not-found');
  renderAdminUserForm(req, res, { user, isNew: false });
});

app.post(`${adminBasePath}/users/:id`, requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const existing = getUserForAdmin(id);
  if (!existing) return res.status(404).render('not-found');
  let user;
  try {
    user = validateManagedUser(req.body);
    assertManagedUserUnique(user, id);
    const securityChanged = existing.email !== user.email || existing.status !== user.status;
    db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET username = ?, email = ?, nickname = ?, membership_level = ?, status = ?,
            session_version = session_version + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(user.username, user.email, user.nickname, user.membership_level, user.status, securityChanged ? 1 : 0, id);
      if (securityChanged) {
        db.prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(id);
      }
    })();
    return res.redirect(`${adminBasePath}/users/${id}/edit?saved=1`);
  } catch (error) {
    return renderAdminUserForm(req, res.status(400), {
      user: { ...(user || managedUserFromBody(req.body)), id, created_at: existing.created_at, last_login_at: existing.last_login_at },
      isNew: false,
      error: managedUserError(error),
    });
  }
});

app.post(`${adminBasePath}/users/:id/reset-password`, requireAdmin, requireCsrf, async (req, res) => {
  const user = getUserForAdmin(Number(req.params.id));
  if (!user) return res.status(404).render('not-found');
  const resetStatus = user.status === 'active'
    ? await sendAdminPasswordReset(user, req.ip, res.locals.locale)
    : 'blocked';
  res.redirect(`${adminBasePath}/users/${user.id}/edit?reset=${encodeURIComponent(resetStatus)}`);
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
      const url = await storeImage(req.body, image, req.get('X-File-Name'));
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

app.get(`${adminBasePath}/posts/:id/delivery`, requireAdmin, (req, res) => {
  const post = getPostForAdmin(Number(req.params.id));
  if (!post) return res.status(404).render('not-found');
  const users = subscriptionStore.getDeliveryUsers(post.id);
  res.render('admin/post-delivery', {
    post,
    users,
    csrf: req.session.csrf,
    mailConfigured: mailStatus.configured,
    busy: postDeliveryLocks.has(post.id),
    result: deliveryResultCopy(req.query),
  });
});

app.post(`${adminBasePath}/posts/:id/delivery/send-all`, requireAdmin, requireCsrf, async (req, res) => {
  const postId = Number(req.params.id);
  const post = getPostForAdmin(postId);
  if (!post) return res.status(404).render('not-found');
  if (post.status !== 'published') return res.redirect(`${adminBasePath}/posts/${postId}/delivery?error=draft`);
  if (!mailStatus.configured) return res.redirect(`${adminBasePath}/posts/${postId}/delivery?error=mail`);
  if (postDeliveryLocks.has(postId)) return res.redirect(`${adminBasePath}/posts/${postId}/delivery?error=busy`);

  postDeliveryLocks.add(postId);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  try {
    for (const user of subscriptionStore.getDeliveryUsers(postId)) {
      if (user.sent_at) {
        skipped += 1;
        continue;
      }
      const delivered = await deliverPostToUser(post, user);
      if (delivered) sent += 1;
      else failed += 1;
    }
  } finally {
    postDeliveryLocks.delete(postId);
  }
  res.redirect(`${adminBasePath}/posts/${postId}/delivery?sent=${sent}&failed=${failed}&skipped=${skipped}`);
});

app.post(`${adminBasePath}/posts/:id/delivery/users/:userId/force`, requireAdmin, requireCsrf, async (req, res) => {
  const postId = Number(req.params.id);
  const userId = Number(req.params.userId);
  const post = getPostForAdmin(postId);
  const user = subscriptionStore.getRecipient(userId);
  if (!post || !user) return res.status(404).render('not-found');
  if (post.status !== 'published') return res.redirect(`${adminBasePath}/posts/${postId}/delivery?error=draft`);
  if (!mailStatus.configured) return res.redirect(`${adminBasePath}/posts/${postId}/delivery?error=mail`);
  if (postDeliveryLocks.has(postId)) return res.redirect(`${adminBasePath}/posts/${postId}/delivery?error=busy`);

  postDeliveryLocks.add(postId);
  let delivered = false;
  try {
    delivered = await deliverPostToUser(post, user);
  } finally {
    postDeliveryLocks.delete(postId);
  }
  res.redirect(`${adminBasePath}/posts/${postId}/delivery?force=${delivered ? 'sent' : 'failed'}&user=${userId}`);
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

app.get(`${adminBasePath}/galleries`, requireAdmin, (req, res) => {
  res.render('admin/galleries', { galleries: getGalleriesForAdmin(), csrf: req.session.csrf });
});

app.get(`${adminBasePath}/galleries/new`, requireAdmin, (req, res) => {
  res.render('admin/gallery-form', { gallery: emptyGallery(), error: null, csrf: req.session.csrf, isNew: true });
});

app.post(`${adminBasePath}/galleries`, requireAdmin, requireCsrf, (req, res) => {
  try {
    const galleryId = saveGallery(null, req.body);
    res.redirect(`${adminBasePath}/galleries/${galleryId}/edit?saved=1`);
  } catch (error) {
    res.status(400).render('admin/gallery-form', {
      gallery: galleryFromBody(req.body),
      error: friendlyError(error),
      csrf: req.session.csrf,
      isNew: true,
    });
  }
});

app.get(`${adminBasePath}/galleries/:id/edit`, requireAdmin, (req, res) => {
  const gallery = getGalleryForAdmin(Number(req.params.id));
  if (!gallery) return res.status(404).render('not-found');
  res.render('admin/gallery-form', {
    gallery,
    error: null,
    csrf: req.session.csrf,
    isNew: false,
    saved: req.query.saved === '1',
  });
});

app.post(`${adminBasePath}/galleries/:id`, requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  try {
    saveGallery(id, req.body);
    res.redirect(`${adminBasePath}/galleries/${id}/edit?saved=1`);
  } catch (error) {
    const persisted = getGalleryForAdmin(id);
    if (!persisted) return res.status(404).render('not-found');
    res.status(400).render('admin/gallery-form', {
      gallery: galleryFromBody(req.body, persisted),
      error: friendlyError(error),
      csrf: req.session.csrf,
      isNew: false,
    });
  }
});

app.post(`${adminBasePath}/galleries/:id/delete`, requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM galleries WHERE id = ?').run(Number(req.params.id));
  res.redirect(`${adminBasePath}/galleries`);
});

app.post(
  `${adminBasePath}/galleries/:id/photos`,
  requireAdmin,
  requireCsrf,
  parseImageBody,
  async (req, res) => {
    const galleryId = Number(req.params.id);
    if (!db.prepare('SELECT id FROM galleries WHERE id = ?').get(galleryId)) {
      return res.status(404).json({ error: 'Gallery 不存在。' });
    }
    const image = detectImageType(req.body);
    if (!image) return res.status(415).json({ error: '仅支持 JPEG、PNG、WebP、GIF 或 AVIF 图片。' });

    try {
      const imageUrl = await storeImage(req.body, image, req.get('X-File-Name'));
      const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM gallery_photos WHERE gallery_id = ?').get(galleryId).next_position;
      const photoId = Number(db.prepare(`
        INSERT INTO gallery_photos (gallery_id, image_url, position) VALUES (?, ?, ?)
      `).run(galleryId, imageUrl, position).lastInsertRowid);
      res.status(201).json({ id: photoId, imageUrl, description: '', takenAt: '', position });
    } catch (error) {
      console.error('Gallery 图片上传失败：', error);
      res.status(502).json({ error: '图片存储失败，请稍后重试。' });
    }
  },
);

app.post(`${adminBasePath}/galleries/:galleryId/photos/:photoId/delete`, requireAdmin, requireCsrf, (req, res) => {
  const galleryId = Number(req.params.galleryId);
  const photoId = Number(req.params.photoId);
  const result = db.transaction(() => {
    db.prepare('UPDATE galleries SET cover_photo_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND cover_photo_id = ?').run(galleryId, photoId);
    return db.prepare('DELETE FROM gallery_photos WHERE id = ? AND gallery_id = ?').run(photoId, galleryId);
  })();
  if (!result.changes) return res.status(404).json({ error: '照片不存在。' });
  res.json({ ok: true });
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
  const mailStatus = getMailStatus();
  console.log(mailStatus.enabled
    ? `Mail: ${mailStatus.host}:${mailStatus.port} (${mailStatus.secure ? 'TLS' : 'STARTTLS'})`
    : 'Mail: disabled');
  if (adminLoginSecurity.ready) console.log('Admin 2FA: enabled');
  else console.warn(`Admin 2FA: login unavailable (${adminLoginSecurity.configurationError})`);
  console.log(`Member registration: ${registrationSecurity.ready ? 'enabled' : 'unavailable (mail disabled)'}`);
  console.log(`Sessions: SQLite (${databasePath})`);
  if (registrationNotificationEmail) console.log('Member registration notifications: enabled');
  else console.warn('Member registration notifications: unavailable (set MEMBER_REGISTRATION_NOTIFY_EMAIL or ADMIN_2FA_EMAIL)');
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

async function storeImage(buffer, image, encodedOriginalName = '', subdirectory = '') {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const filename = `${seoImageBasename(encodedOriginalName)}-${crypto.randomBytes(6).toString('hex')}.${image.extension}`;
  const normalizedSubdirectory = subdirectory ? normalizeImagePrefix(subdirectory) : '';
  const objectKey = [imagePrefix, normalizedSubdirectory, year, month, filename].filter(Boolean).join('/');

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

function seoImageBasename(encodedName) {
  let name = String(encodedName || '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw header value and sanitize it below.
  }
  const extensionless = path.basename(name).replace(/\.[A-Za-z0-9]{2,5}$/, '');
  return extensionless.normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'photo';
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

function homePath(locale, page = 1) {
  const params = new URLSearchParams();
  if (locale !== defaultLocale) params.set('lang', locale);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

function archivePath(locale) {
  return locale === defaultLocale ? '/archive' : `/archive?lang=${encodeURIComponent(locale)}`;
}

function feedPath(locale) {
  return locale === defaultLocale ? '/feed.xml' : `/feed.xml?lang=${encodeURIComponent(locale)}`;
}

function topicsPath(locale) {
  return locale === defaultLocale ? '/topics' : `/topics?lang=${encodeURIComponent(locale)}`;
}

function topicPath(slug, locale) {
  const pathname = `/topics/${encodeURIComponent(slug)}`;
  return locale === defaultLocale ? pathname : `${pathname}?lang=${encodeURIComponent(locale)}`;
}

function preferredParameterizedLocale(req, res, pathname) {
  const requestedLocale = parameterLocale(req);
  const selectedLocale = getSelectedLocale(req);
  if (selectedLocale && selectedLocale !== requestedLocale) {
    const target = selectedLocale === defaultLocale ? pathname : `${pathname}?lang=${encodeURIComponent(selectedLocale)}`;
    res.redirect(302, target);
    return null;
  }
  const locale = selectedLocale || requestedLocale;
  setResponseLocale(res, locale);
  return locale;
}

function parameterLocale(req) {
  return normalizeLocale(req.query.lang) || defaultLocale;
}

function parseHomePage(value) {
  if (value === undefined) return 1;
  if (Array.isArray(value) || !/^[1-9]\d*$/.test(String(value))) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : null;
}

function archiveTitle(locale) {
  return (archiveCopy[locale] || archiveCopy.en).title;
}

function archiveDescription(locale) {
  return (archiveCopy[locale] || archiveCopy.en).description;
}

function seoCopy(locale) {
  return seoCopyByLocale[locale] || seoCopyByLocale.en;
}

function buildSeoCopy() {
  const defaults = {
    zh: {
      title: `${blog.title} — 摄影作品、摄影写作与视觉文化`,
      description: `Afterimage Photography 是摄影师 ${blog.author} 的独立摄影档案与写作网站，关注街头摄影、纪实摄影、摄影文化、摄影史与个人视觉项目。`,
      introductionTitle: 'About Afterimage',
      introduction: `Afterimage Photography 是摄影师 ${blog.author} 的独立摄影档案与摄影写作网站，关注街头摄影、纪实摄影、摄影文化、摄影史以及个人视觉项目。`,
      aboutLink: '关于作者', topicsTitle: '主题', topicsDescription: '按摄影主题浏览文章与视觉研究。',
      topicLabel: '主题', relatedTitle: '相关文章', articlesLabel: '篇文章', noTopics: '暂时还没有主题。',
    },
    en: {
      title: `${blog.title} — Photography, Essays & Visual Stories`,
      description: `Afterimage Photography is an independent photography journal and visual archive by photographer ${blog.author}, exploring street photography, documentary work, visual culture and photography history.`,
      introductionTitle: 'About Afterimage',
      introduction: `Afterimage Photography is an independent photography journal and visual archive by photographer ${blog.author}, exploring street photography, documentary photography, visual culture, photography history and personal projects.`,
      aboutLink: 'About the photographer', topicsTitle: 'Topics', topicsDescription: 'Browse essays and visual research by photography topic.',
      topicLabel: 'Topic', relatedTitle: 'Related essays', articlesLabel: 'articles', noTopics: 'No topics yet.',
    },
    ja: {
      title: `${blog.title} — 写真作品、エッセイと視覚文化`,
      description: `Afterimage Photography は写真家 ${blog.author} による独立した写真アーカイブと執筆サイトです。ストリート写真、ドキュメンタリー、視覚文化、写真史を扱います。`,
      introductionTitle: 'Afterimage について',
      introduction: `Afterimage Photography は写真家 ${blog.author} による独立した写真アーカイブと写真エッセイのサイトです。ストリート写真、ドキュメンタリー写真、視覚文化、写真史、個人プロジェクトを扱います。`,
      aboutLink: '写真家について', topicsTitle: 'トピック', topicsDescription: '写真のテーマからエッセイと視覚研究を探す。',
      topicLabel: 'トピック', relatedTitle: '関連記事', articlesLabel: '記事', noTopics: 'トピックはまだありません。',
    },
  };
  return Object.fromEntries(configuredLocales.map(locale => {
    const fallback = defaults[locale] || defaults.en;
    const suffix = locale.toUpperCase().replaceAll('-', '_');
    return [locale, {
      ...fallback,
      title: String(process.env[`HOME_SEO_TITLE_${suffix}`] || fallback.title).trim(),
      description: String(process.env[`HOME_SEO_DESCRIPTION_${suffix}`] || fallback.description).trim(),
      introduction: String(process.env[`HOME_INTRO_${suffix}`] || fallback.introduction).trim(),
    }];
  }));
}

function normalizeSocialUrls(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(item => {
    try {
      const url = new URL(item);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}

function localizedTopicDescription(name, count, locale) {
  if (locale === 'zh') return `浏览 Afterimage Photography 中关于「${name}」的 ${count} 篇文章与摄影思考。`;
  if (locale === 'ja') return `Afterimage Photography の「${name}」に関する ${count} 件の記事と写真考察。`;
  return `Browse ${count} ${count === 1 ? 'article' : 'articles'} about ${name} from Afterimage Photography.`;
}

function serializeJsonLd(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function publisherStructuredData() {
  return {
    '@type': 'Organization',
    '@id': `${absoluteUrl('/')}#organization`,
    name: blog.title,
    url: absoluteUrl('/'),
    logo: { '@type': 'ImageObject', url: absoluteUrl('/apple-touch-icon.png') },
    founder: { '@id': `${absoluteUrl(pageUrl(defaultLocale, 'about'))}#person` },
  };
}

function personStructuredData(name, locale) {
  const url = absoluteUrl(pageUrl(locale, 'about'));
  return {
    '@type': 'Person',
    '@id': `${url}#person`,
    name: String(name || blog.author),
    jobTitle: 'Photographer',
    url,
    ...(socialUrls.length ? { sameAs: socialUrls } : {}),
  };
}

function collectionStructuredData(name, description, url, locale, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    description,
    url,
    inLanguage: locale,
    isPartOf: { '@id': `${absoluteUrl('/')}#website` },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: items.length,
      itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, ...item })),
    },
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
  res.locals.topicUrl = category => topicPath(topicSlug(category), locale);
  res.locals.topicPath = slug => topicPath(slug, locale);
  res.locals.seoCopy = seoCopy(locale);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function datetimeLocalValue(value) {
  const source = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(source) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(source)) return source.slice(0, 16);
  const date = new Date(source);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16);
}

function postUrl(locale, slug) {
  return `/post/${encodeURIComponent(locale)}/${encodeURIComponent(slug)}`;
}

function pageUrl(locale, slug) {
  return `/page/${encodeURIComponent(locale)}/${encodeURIComponent(slug)}`;
}

function galleryUrl(slug) {
  return `/gallery/${encodeURIComponent(slug)}`;
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
    `  <url><loc>${escapeXml(absoluteUrl('/galleries'))}</loc></url>`,
  ];

  const homeAlternates = configuredLocales.map(locale =>
    `    <xhtml:link rel="alternate" hreflang="${escapeXml(locale)}" href="${escapeXml(absoluteUrl(homePath(locale)))}" />`
  );
  homeAlternates.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(absoluteUrl('/'))}" />`);
  for (const locale of configuredLocales) {
    urls.push([
      '  <url>',
      `    <loc>${escapeXml(absoluteUrl(homePath(locale)))}</loc>`,
      ...homeAlternates,
      '  </url>',
    ].join('\n'));
  }

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

  const topicsAlternates = configuredLocales.map(locale =>
    `    <xhtml:link rel="alternate" hreflang="${escapeXml(locale)}" href="${escapeXml(absoluteUrl(topicsPath(locale)))}" />`
  );
  topicsAlternates.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(absoluteUrl(topicsPath(defaultLocale)))}" />`);
  for (const locale of configuredLocales) {
    urls.push([
      '  <url>',
      `    <loc>${escapeXml(absoluteUrl(topicsPath(locale)))}</loc>`,
      ...topicsAlternates,
      '  </url>',
    ].join('\n'));
  }

  const topicGroups = new Map();
  for (const locale of configuredLocales) {
    for (const topic of getTopics(locale)) {
      if (!topicGroups.has(topic.slug)) topicGroups.set(topic.slug, []);
      topicGroups.get(topic.slug).push({ locale, topic });
    }
  }
  for (const entries of topicGroups.values()) {
    const xDefault = entries.find(entry => entry.locale === defaultLocale) || entries[0];
    const alternates = entries.map(entry =>
      `    <xhtml:link rel="alternate" hreflang="${escapeXml(entry.locale)}" href="${escapeXml(absoluteUrl(topicPath(entry.topic.slug, entry.locale)))}" />`
    );
    alternates.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(absoluteUrl(topicPath(xDefault.topic.slug, xDefault.locale)))}" />`);
    for (const entry of entries) {
      urls.push([
        '  <url>',
        `    <loc>${escapeXml(absoluteUrl(topicPath(entry.topic.slug, entry.locale)))}</loc>`,
        ...alternates,
        '  </url>',
      ].join('\n'));
    }
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
  for (const gallery of getPublishedGalleries()) {
    urls.push([
      '  <url>',
      `    <loc>${escapeXml(absoluteUrl(galleryUrl(gallery.slug)))}</loc>`,
      `    <lastmod>${escapeXml(sqliteDateToIso(gallery.updated_at) || gallery.published_at)}</lastmod>`,
      '  </url>',
    ].join('\n'));
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
  const topics = configuredLocales.flatMap(locale => getTopics(locale).map(topic =>
    `- [${escapeMarkdownLabel(topic.name)}](${absoluteUrl(topicPath(topic.slug, locale))}): ${locale}; ${topic.count} ${topic.count === 1 ? 'article' : 'articles'}`
  ));
  const galleries = getPublishedGalleries().map(gallery =>
    `- [${escapeMarkdownLabel(gallery.name)}](${absoluteUrl(`${galleryUrl(gallery.slug)}.md`)}): ${gallery.description || `${gallery.author} photo collection`}`
  );
  return [
    `# ${blog.title}`,
    '',
    `> ${seoCopy(defaultLocale).description.replace(/\s+/g, ' ')}`,
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
    '## Photography Collections',
    '',
    ...(galleries.length ? galleries : ['- 暂无公开摄影合集。']),
    '',
    '## Topics',
    '',
    ...(topics.length ? topics : ['- 暂无主题页面。']),
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
  const gallerySections = getPublishedGalleries().map(row => {
    const gallery = getGalleryBySlug(row.slug);
    return renderGalleryMarkdown(gallery, absoluteUrl(galleryUrl(gallery.slug)));
  });
  const introduction = [
    `# ${blog.title} — Full Content`,
    '',
    `> ${seoCopy(defaultLocale).description.replace(/\s+/g, ' ')}`,
  ].join('\n');
  return [introduction, ...articleSections, ...pageSections, ...gallerySections].join('\n\n---\n\n');
}

function renderPostMarkdown(post, canonicalUrl) {
  const summary = String(post.summary || '').trim();
  return [
    `# ${post.title}`,
    '',
    ...(summary ? [`> ${summary.replace(/\s*\n\s*/g, ' ')}`, ''] : []),
    `- Language: ${post.rendered_locale || post.locale}`,
    `- Published: ${formatDate(post.published_at)}`,
    `- Author: ${post.author || 'GuoJing'}`,
    ...(post.category ? [`- Category: ${post.category}`] : []),
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

function renderGalleryMarkdown(gallery, canonicalUrl) {
  return [
    `# ${gallery.name}`,
    '',
    ...(gallery.description ? [`> ${gallery.description.replace(/\s*\n\s*/g, ' ')}`, ''] : []),
    `- Type: Photography Collection`,
    `- Published: ${formatDate(gallery.published_at)}`,
    `- Author: ${gallery.author}`,
    `- Photos: ${gallery.photos.length}`,
    `- Canonical: ${canonicalUrl}`,
    '',
    ...gallery.photos.flatMap((photo, index) => [
      `## Photo ${index + 1}`,
      '',
      `![${escapeMarkdownLabel(photo.description || `${gallery.name} photo ${index + 1}`)}](${absoluteUrl(photo.image_url)})`,
      ...(photo.description ? ['', photo.description] : []),
      ...(photo.taken_at ? ['', `Taken: ${formatDate(photo.taken_at)}`] : []),
      '',
    ]),
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
  const currentUrl = new URL(currentPath, 'http://afterimage.local');
  const pathname = currentUrl.pathname;
  if (pathname === '/') return homePath(locale, parseHomePage(currentUrl.searchParams.get('page')) || 1);
  if (pathname === '/account') return accountUrl(locale);
  if (pathname === '/account/reset') return accountResetUrl(locale);
  if (pathname === '/archive') return archivePath(locale);
  if (pathname === '/topics') return topicsPath(locale);
  const topicMatch = pathname.match(/^\/topics\/([^/]+)$/);
  if (topicMatch) return topicPath(topicMatch[1], locale);
  if (/^\/galleries\/?$/.test(pathname)) return '/galleries';
  if (/^\/gallery\/[^/]+\/?$/.test(pathname)) return pathname.replace(/\/$/, '');
  const postMatch = pathname.match(/^\/post\/[^/]+\/([^/]+)$/);
  if (postMatch) return `/post/${encodeURIComponent(locale)}/${postMatch[1]}`;
  const pageMatch = pathname.match(/^\/page\/[^/]+\/([^/]+)$/);
  if (pageMatch) return `/page/${encodeURIComponent(locale)}/${pageMatch[1]}`;
  return locale === defaultLocale ? '/' : `/?lang=${encodeURIComponent(locale)}`;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
}

function pickLocale(req) {
  const selectedLocale = getSelectedLocale(req);
  if (selectedLocale) return selectedLocale;
  const queryLocale = normalizeLocale(req.query.lang);
  return configuredLocales.includes(queryLocale) ? queryLocale : defaultLocale;
}

function getSelectedLocale(req) {
  const cookieLocale = normalizeLocale(parseCookies(req.headers.cookie)['afterimage.locale']);
  return isAvailableLocale(cookieLocale) ? cookieLocale : null;
}

function isAvailableLocale(locale) {
  if (!locale) return false;
  if (configuredLocales.includes(locale)) return true;
  return Boolean(db.prepare(`
    SELECT locale FROM post_translations WHERE locale = ?
    UNION
    SELECT locale FROM page_translations WHERE locale = ?
    LIMIT 1
  `).get(locale, locale));
}

function renderMarkdown(markdown) {
  const html = sanitizeHtml(marked.parse(markdown || ''), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'figure', 'figcaption']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      div: ['class'],
      span: ['class'],
      img: ['src', 'alt', 'title', 'loading', 'decoding'],
    },
    allowedClasses: { div: ['image-stack'], span: ['image-row'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      img: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          alt: String(attribs.alt || '').trim() || imageAltFromUrl(attribs.src),
          loading: 'lazy',
          decoding: 'async',
        },
      }),
    },
  });
  return html.replace(/<img\b[^>]*>/i, tag => {
    const prioritized = tag.replace(/\sloading="[^"]*"/, '');
    return prioritized.replace('<img', '<img loading="eager" fetchpriority="high"');
  });
}

function imageAltFromUrl(value) {
  try {
    const pathname = new URL(String(value || ''), `${siteUrl}/`).pathname;
    const filename = decodeURIComponent(path.basename(pathname)).replace(/\.[A-Za-z0-9]{2,5}$/, '')
      .replace(/-[a-f0-9]{12}$/i, '')
      .replace(/^[a-f0-9-]{24,}$/i, '');
    const label = filename.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return label || 'Photography image';
  } catch {
    return 'Photography image';
  }
}

function isImageOnlyParagraph(token) {
  return token.tokens.length > 0 && token.tokens.every(item =>
    item.type === 'image' || (item.type === 'text' && !item.raw.trim())
  );
}

function getPublishedPosts(locale, limit = homePageSize, offset = 0) {
  const rows = db.prepare(`
    SELECT p.*, COALESCE(chosen.title, fallback.title) AS title,
      COALESCE(chosen.summary, fallback.summary, '') AS summary,
      COALESCE(chosen.body, fallback.body, '') AS body,
      CASE WHEN chosen.id IS NULL THEN ? ELSE ? END AS rendered_locale
    FROM posts p
    LEFT JOIN post_translations chosen ON chosen.post_id = p.id AND chosen.locale = ?
    LEFT JOIN post_translations fallback ON fallback.post_id = p.id AND fallback.locale = ?
    WHERE p.status = 'published' AND COALESCE(chosen.id, fallback.id) IS NOT NULL
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(defaultLocale, locale, locale, defaultLocale, limit, offset);
  return rows.map(withLocales);
}

function countPublishedPosts(locale) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS total
    FROM posts p
    LEFT JOIN post_translations chosen ON chosen.post_id = p.id AND chosen.locale = ?
    LEFT JOIN post_translations fallback ON fallback.post_id = p.id AND fallback.locale = ?
    WHERE p.status = 'published' AND COALESCE(chosen.id, fallback.id) IS NOT NULL
  `).get(locale, defaultLocale).total);
}

function getPublishedPostsByExactLocale(locale) {
  return db.prepare(`
    SELECT p.*, t.title, t.summary, t.body, t.locale AS rendered_locale
    FROM posts p
    JOIN post_translations t ON t.post_id = p.id AND t.locale = ?
    WHERE p.status = 'published'
    ORDER BY p.published_at DESC, p.id DESC
  `).all(locale).map(withPostMetadata);
}

function topicSlug(category) {
  return String(category || '').normalize('NFKC').toLocaleLowerCase('en')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'uncategorized';
}

function getTopics(locale) {
  const topics = new Map();
  for (const post of getPublishedPostsByExactLocale(locale)) {
    const name = String(post.category || '').trim();
    if (!name) continue;
    const slug = topicSlug(name);
    const topic = topics.get(slug) || { slug, name, count: 0, posts: [] };
    topic.count += 1;
    topic.posts.push(post);
    topics.set(slug, topic);
  }
  return [...topics.values()].sort((left, right) => left.name.localeCompare(right.name, locale));
}

function getTopic(slug, locale) {
  const normalizedSlug = topicSlug(slug);
  return getTopics(locale).find(topic => topic.slug === normalizedSlug) || null;
}

function getRelatedPosts(post, locale, limit = 4) {
  const category = String(post.category || '').trim().toLocaleLowerCase(locale);
  if (!category) return [];
  return getPublishedPostsByExactLocale(locale)
    .filter(item => item.id !== post.id && String(item.category || '').trim().toLocaleLowerCase(locale) === category)
    .slice(0, limit);
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
  withPostMetadata(post);
  post.availableLocales = db.prepare('SELECT locale FROM post_translations WHERE post_id = ? ORDER BY locale').all(post.id).map(row => row.locale);
  return post;
}

function withPostMetadata(post) {
  post.author = String(post.author || '').trim() || 'GuoJing';
  post.category = String(post.category || '').trim();
  return post;
}

function getPostForAdmin(id) {
  const base = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!base) return null;
  withPostMetadata(base);
  base.translationList = db.prepare(`
    SELECT locale, title, summary, body FROM post_translations
    WHERE post_id = ? ORDER BY CASE WHEN locale = ? THEN 0 ELSE 1 END, locale
  `).all(id, defaultLocale);
  if (!base.translationList.length) base.translationList.push({ locale: defaultLocale, title: '', summary: '', body: '' });
  return base;
}

function getPostDeliveryTranslation(post, locale) {
  const normalized = normalizeLocale(locale) || defaultLocale;
  const selected = post.translationList.find(item => item.locale === normalized)
    || post.translationList.find(item => item.locale === defaultLocale)
    || post.translationList[0];
  if (!selected) return null;
  return { ...post, ...selected, rendered_locale: selected.locale };
}

async function deliverPostToUser(post, user) {
  const translatedPost = getPostDeliveryTranslation(post, user.locale);
  if (!translatedPost) return false;
  const locale = translatedPost.rendered_locale;
  try {
    await sendPostEmail({
      to: user.email,
      blog,
      post: translatedPost,
      articleUrl: absoluteUrl(postUrl(locale, post.slug)),
      preferencesUrl: absoluteUrl(`/subscribe?lang=${encodeURIComponent(user.locale || locale)}`),
      bodyHtml: absolutizeFeedHtml(renderMarkdown(translatedPost.body)),
    });
    subscriptionStore.recordSuccess(post.id, user, locale);
    return true;
  } catch (error) {
    subscriptionStore.recordFailure(post.id, user, locale);
    console.error(`文章邮件发送失败（post=${post.id}, user=${user.id}）：`, error);
    return false;
  }
}

function deliveryResultCopy(query) {
  if (query.error === 'draft') return { type: 'error', text: '草稿不能推送，请先发布文章。' };
  if (query.error === 'mail') return { type: 'error', text: '邮件功能尚未配置或启用。' };
  if (query.error === 'busy') return { type: 'error', text: '这篇文章正在推送，请稍后刷新查看结果。' };
  if (query.force === 'sent') return { type: 'success', text: '已向该用户强制重发。' };
  if (query.force === 'failed') return { type: 'error', text: '强制重发失败，请检查服务端日志。' };
  if (query.sent !== undefined) {
    const sent = Math.max(0, Number(query.sent) || 0);
    const failed = Math.max(0, Number(query.failed) || 0);
    const skipped = Math.max(0, Number(query.skipped) || 0);
    return {
      type: failed ? 'error' : 'success',
      text: `推送完成：成功 ${sent}，失败 ${failed}，已发送跳过 ${skipped}。`,
    };
  }
  return null;
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
    author: 'GuoJing',
    category: POST_CATEGORIES[0],
    translationList: defaultPostEditorLocales.map(locale => ({ locale, title: '', summary: '', body: '' })),
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
  return {
    slug: body.slug || '',
    status: body.status || 'draft',
    published_at: body.published_at || '',
    author: String(body.author || '').trim() || 'GuoJing',
    category: String(body.category || '').trim(),
    translationList,
  };
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
  const author = String(data.author || '').trim() || 'GuoJing';
  const category = normalizePostCategory(data.category);
  if (author.length > 100) throw new Error('INVALID_AUTHOR');
  if (!category) throw new Error('INVALID_CATEGORY');
  let postId = id;
  if (id) {
    db.prepare('UPDATE posts SET slug = ?, status = ?, published_at = ?, author = ?, category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(slug, status, publishedAt, author, category, id);
  } else {
    postId = Number(db.prepare('INSERT INTO posts (slug, status, published_at, author, category) VALUES (?, ?, ?, ?, ?)').run(slug, status, publishedAt, author, category).lastInsertRowid);
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

function getGalleriesForAdmin() {
  return db.prepare(`
    SELECT g.*, cover.image_url AS cover_image_url,
      (SELECT COUNT(*) FROM gallery_photos WHERE gallery_id = g.id) AS photo_count
    FROM galleries g
    LEFT JOIN gallery_photos cover ON cover.id = g.cover_photo_id AND cover.gallery_id = g.id
    ORDER BY g.published_at DESC, g.id DESC
  `).all().map(withGalleryDefaults);
}

function getPublishedGalleries() {
  return db.prepare(`
    SELECT id, slug, name, description, author, published_at, updated_at
    FROM galleries
    ORDER BY published_at DESC, id DESC
  `).all();
}

function getGalleriesForPublic() {
  const galleries = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM gallery_photos WHERE gallery_id = g.id) AS photo_count
    FROM galleries g
    ORDER BY g.published_at DESC, g.id DESC
  `).all().map(withGalleryDefaults);
  const previewPhotos = db.prepare(`
    SELECT id, image_url, description, taken_at, position
    FROM gallery_photos
    WHERE gallery_id = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, position ASC, id ASC
    LIMIT 3
  `);
  for (const gallery of galleries) {
    gallery.preview_photos = previewPhotos.all(gallery.id, Number(gallery.cover_photo_id) || -1);
  }
  return galleries;
}

function getGalleryBySlug(slug) {
  const gallery = db.prepare('SELECT * FROM galleries WHERE slug = ?').get(String(slug || ''));
  if (!gallery) return null;
  withGalleryDefaults(gallery);
  gallery.photos = db.prepare(`
    SELECT id, image_url, description, taken_at, position
    FROM gallery_photos
    WHERE gallery_id = ?
    ORDER BY position ASC, id ASC
  `).all(gallery.id);
  return gallery;
}

function getGalleryForAdmin(id) {
  const gallery = db.prepare('SELECT * FROM galleries WHERE id = ?').get(id);
  if (!gallery) return null;
  withGalleryDefaults(gallery);
  gallery.photos = db.prepare(`
    SELECT id, image_url, description, taken_at, position
    FROM gallery_photos
    WHERE gallery_id = ?
    ORDER BY position ASC, id ASC
  `).all(id);
  return gallery;
}

function withGalleryDefaults(gallery) {
  gallery.slug = String(gallery.slug || '').trim();
  gallery.name = String(gallery.name || '').trim();
  gallery.description = String(gallery.description || '').trim();
  gallery.author = String(gallery.author || '').trim() || 'GuoJing';
  gallery.theme_settings = parseStoredGallerySettings(gallery.settings_json);
  gallery.related_articles_text = gallery.theme_settings.relatedArticles.join('\n');
  gallery.settings_json = JSON.stringify(gallery.theme_settings);
  return gallery;
}

function emptyGallery() {
  return {
    slug: '',
    name: '',
    description: '',
    author: 'GuoJing',
    published_at: currentLocalDateTime(),
    cover_photo_id: null,
    theme_settings: defaultGallerySettings(),
    related_articles_text: '',
    settings_json: JSON.stringify(defaultGallerySettings()),
    photos: [],
  };
}

function currentLocalDateTime() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function galleryFromBody(body, persisted = null) {
  const themeSettings = gallerySettingsFromBody(body, false);
  themeSettings.relatedArticles = normalizeGalleryRelatedUrls(body.related_urls, false);
  const gallery = {
    ...(persisted || emptyGallery()),
    slug: String(body.slug || ''),
    name: String(body.name || ''),
    description: String(body.description || ''),
    author: String(body.author || '').trim() || 'GuoJing',
    published_at: String(body.published_at || ''),
    cover_photo_id: body.cover_photo_id ? Number(body.cover_photo_id) : null,
    theme_settings: themeSettings,
    related_articles_text: String(body.related_urls || ''),
    settings_json: JSON.stringify(themeSettings),
  };
  if (persisted?.photos) {
    const descriptions = submittedPhotoValues(body, 'photo_description');
    const takenTimes = submittedPhotoValues(body, 'photo_taken_at');
    gallery.photos = persisted.photos.map(photo => ({
      ...photo,
      description: descriptions.get(photo.id) ?? photo.description,
      taken_at: takenTimes.get(photo.id) ?? photo.taken_at,
    }));
  }
  return gallery;
}

const persistGallery = db.transaction((id, data) => {
  const slug = String(data.slug || '').trim().replace(/^\/+|\/+$/g, '');
  const name = String(data.name || '').trim();
  const description = String(data.description || '').trim();
  const author = String(data.author || '').trim() || 'GuoJing';
  const publishedAt = normalizeOptionalDate(data.published_at, false);
  const settingsJson = normalizeGallerySettingsJson(data);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) throw new Error('INVALID_GALLERY_SLUG');
  if (!name || name.length > 160) throw new Error('INVALID_GALLERY_NAME');
  if (description.length > 5000) throw new Error('INVALID_GALLERY_DESCRIPTION');
  if (author.length > 100) throw new Error('INVALID_AUTHOR');

  let galleryId = id;
  if (galleryId) {
    const result = db.prepare(`
      UPDATE galleries
      SET slug = ?, name = ?, description = ?, author = ?, published_at = ?, settings_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(slug, name, description, author, publishedAt, settingsJson, galleryId);
    if (!result.changes) throw new Error('GALLERY_NOT_FOUND');
  } else {
    galleryId = Number(db.prepare(`
      INSERT INTO galleries (slug, name, description, author, published_at, settings_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(slug, name, description, author, publishedAt, settingsJson).lastInsertRowid);
  }

  const photoIds = arrayValue(data.photo_id).map(Number).filter(Number.isInteger);
  const descriptions = arrayValue(data.photo_description);
  const takenTimes = arrayValue(data.photo_taken_at);
  const existingIds = new Set(db.prepare('SELECT id FROM gallery_photos WHERE gallery_id = ?').all(galleryId).map(row => row.id));
  const updatePhoto = db.prepare(`
    UPDATE gallery_photos
    SET description = ?, taken_at = ?, position = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND gallery_id = ?
  `);
  photoIds.forEach((photoId, index) => {
    if (!existingIds.has(photoId)) throw new Error('INVALID_GALLERY_PHOTO');
    const photoDescription = String(descriptions[index] || '').trim();
    if (photoDescription.length > 1000) throw new Error('INVALID_PHOTO_DESCRIPTION');
    const takenAt = normalizeOptionalDate(takenTimes[index], true);
    updatePhoto.run(photoDescription, takenAt, index, photoId, galleryId);
  });

  const coverPhotoId = data.cover_photo_id ? Number(data.cover_photo_id) : null;
  if (coverPhotoId !== null && !existingIds.has(coverPhotoId)) throw new Error('INVALID_GALLERY_COVER');
  db.prepare('UPDATE galleries SET cover_photo_id = ? WHERE id = ?').run(coverPhotoId, galleryId);
  return galleryId;
});

function saveGallery(id, data) {
  return persistGallery(id, data);
}

function defaultGallerySettings(theme = 'masonry') {
  return { theme, options: { ...galleryThemeDefaults[theme] }, relatedArticles: [] };
}

function parseStoredGallerySettings(value) {
  try {
    return normalizeGallerySettingsObject(JSON.parse(String(value || '{}')), false);
  } catch {
    return defaultGallerySettings();
  }
}

function normalizeGallerySettingsJson(data) {
  if (data.gallery_theme !== undefined) {
    const settings = gallerySettingsFromBody(data, true);
    settings.relatedArticles = normalizeGalleryRelatedUrls(data.related_urls, true);
    return JSON.stringify(settings);
  }
  try {
    return JSON.stringify(normalizeGallerySettingsObject(JSON.parse(String(data.settings_json || '{}')), true));
  } catch (error) {
    if (error.message?.startsWith('INVALID_GALLERY_')) throw error;
    throw new Error('INVALID_GALLERY_THEME');
  }
}

function gallerySettingsFromBody(data, strict) {
  const theme = String(data.gallery_theme || 'masonry').trim();
  if (!galleryThemeIds.has(theme)) {
    if (strict) throw new Error('INVALID_GALLERY_THEME');
    return defaultGallerySettings();
  }
  const prefix = `theme_${theme}_`;
  const options = {};
  if (theme === 'masonry') {
    options.columnsDesktop = galleryInteger(data[`${prefix}columns_desktop`], 4, 2, 6, strict);
    options.columnsTablet = galleryInteger(data[`${prefix}columns_tablet`], 3, 1, 4, strict);
    options.gap = galleryInteger(data[`${prefix}gap`], 16, 0, 48, strict);
    options.showCaptions = data[`${prefix}show_captions`] === '1';
  } else if (theme === 'grid') {
    options.columnsDesktop = galleryInteger(data[`${prefix}columns_desktop`], 4, 2, 6, strict);
    options.columnsTablet = galleryInteger(data[`${prefix}columns_tablet`], 2, 1, 4, strict);
    options.gap = galleryInteger(data[`${prefix}gap`], 12, 0, 48, strict);
    options.aspectRatio = galleryChoice(data[`${prefix}aspect_ratio`], '3:2', ['natural', '1:1', '4:3', '3:2', '16:9'], strict);
    options.imageFit = galleryChoice(data[`${prefix}image_fit`], 'cover', ['cover', 'contain'], strict);
  } else if (theme === 'fade') {
    options.autoplay = data[`${prefix}autoplay`] === '1';
    options.intervalMs = galleryInteger(data[`${prefix}interval_ms`], 5000, 2000, 15000, strict);
    options.transitionMs = galleryInteger(data[`${prefix}transition_ms`], 900, 200, 3000, strict);
    options.imageFit = galleryChoice(data[`${prefix}image_fit`], 'contain', ['cover', 'contain'], strict);
    options.showThumbnails = data[`${prefix}show_thumbnails`] === '1';
  } else {
    options.targetRowHeight = galleryInteger(data[`${prefix}target_row_height`], 320, 160, 600, strict);
    options.maxRowHeight = galleryInteger(data[`${prefix}max_row_height`], 480, 200, 900, strict);
    options.gap = galleryInteger(data[`${prefix}gap`], 10, 0, 40, strict);
    options.lastRow = galleryChoice(data[`${prefix}last_row`], 'left', ['left', 'center', 'justify'], strict);
    options.showCaptions = data[`${prefix}show_captions`] === '1';
    if (strict && options.maxRowHeight < options.targetRowHeight) throw new Error('INVALID_GALLERY_THEME_OPTIONS');
  }
  return { theme, options };
}

function normalizeGallerySettingsObject(settings, strict) {
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
    if (strict) throw new Error('INVALID_GALLERY_THEME');
    return defaultGallerySettings();
  }
  if (strict && settings.theme !== undefined && !galleryThemeIds.has(settings.theme)) throw new Error('INVALID_GALLERY_THEME');
  const theme = galleryThemeIds.has(settings.theme) ? settings.theme : 'masonry';
  const source = settings.options && !Array.isArray(settings.options) && typeof settings.options === 'object' ? settings.options : {};
  const normalizedSource = { ...galleryThemeDefaults[theme], ...source };
  const data = { gallery_theme: theme };
  const prefix = `theme_${theme}_`;
  for (const [key, value] of Object.entries(normalizedSource)) {
    const formKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    data[`${prefix}${formKey}`] = typeof value === 'boolean' ? (value ? '1' : undefined) : value;
  }
  const normalized = gallerySettingsFromBody(data, strict);
  normalized.relatedArticles = normalizeGalleryRelatedUrls(settings.relatedArticles, strict);
  return normalized;
}

function normalizeGalleryRelatedUrls(value, strict) {
  const values = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  const urls = [];
  for (const item of values) {
    const url = normalizeGalleryRelatedUrl(item);
    if (!url) {
      if (strict && String(item || '').trim()) throw new Error('INVALID_GALLERY_RELATED_URLS');
      continue;
    }
    if (!urls.includes(url)) urls.push(url);
    if (urls.length > 20) {
      if (strict) throw new Error('INVALID_GALLERY_RELATED_URLS');
      return urls.slice(0, 20);
    }
  }
  return urls;
}

function normalizeGalleryRelatedUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.length > 2048 || /[\u0000-\u001F\u007F]/.test(url)) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return url;
  } catch {
    // Invalid and unsafe URLs use the shared validation message below.
  }
  return null;
}

function galleryInteger(value, fallback, min, max, strict) {
  if ((value === undefined || value === '') && !strict) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    if (strict) throw new Error('INVALID_GALLERY_THEME_OPTIONS');
    return fallback;
  }
  return number;
}

function galleryChoice(value, fallback, choices, strict) {
  if (choices.includes(value)) return value;
  if (strict) throw new Error('INVALID_GALLERY_THEME_OPTIONS');
  return fallback;
}

function ensureGallerySlugSchema() {
  const columns = new Set(db.prepare('PRAGMA table_info(galleries)').all().map(column => column.name));
  if (!columns.has('slug')) db.exec('ALTER TABLE galleries ADD COLUMN slug TEXT');
  const rows = db.prepare('SELECT id, slug FROM galleries ORDER BY id').all();
  const used = new Set();
  const updateSlug = db.prepare('UPDATE galleries SET slug = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of rows) {
      let slug = String(row.slug || '').trim();
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug) || used.has(slug)) {
        const base = `gallery-${row.id}`;
        slug = base;
        let suffix = 2;
        while (used.has(slug)) slug = `${base}-${suffix++}`;
        updateSlug.run(slug, row.id);
      }
      used.add(slug);
    }
  })();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS galleries_slug_unique ON galleries(slug)');
}

function normalizeOptionalDate(value, allowEmpty) {
  const source = String(value || '').trim();
  if (!source && allowEmpty) return null;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) throw new Error('INVALID_GALLERY_DATE');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(source) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(source)
    ? source.slice(0, 16)
    : date.toISOString();
}

function submittedPhotoValues(body, field) {
  const ids = arrayValue(body.photo_id).map(Number);
  const values = arrayValue(body[field]);
  return new Map(ids.map((id, index) => [id, String(values[index] || '')]));
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

function isNavigationActive(url, currentPath) {
  const navigationPath = internalNavigationPath(url);
  const requestPath = internalNavigationPath(currentPath);
  if (!navigationPath || !requestPath) return false;
  if (navigationPath === requestPath) return true;
  if (navigationPath === '/topics' && requestPath.startsWith('/topics/')) return true;
  if (navigationPath === '/galleries' && requestPath.startsWith('/gallery/')) return true;
  if (navigationPath === '/gallery' && (requestPath === '/galleries' || requestPath.startsWith('/gallery/'))) return true;

  const navigationContent = navigationPath.match(/^\/(post|page)\/[^/]+\/([^/]+)$/);
  const requestContent = requestPath.match(/^\/(post|page)\/[^/]+\/([^/]+)$/);
  return Boolean(
    navigationContent
    && requestContent
    && navigationContent[1] === requestContent[1]
    && navigationContent[2] === requestContent[2]
  );
}

function internalNavigationPath(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  const pathname = raw.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  return pathname || '/';
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect(`${adminBasePath}/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

function requireMember(req, res, next) {
  const currentUser = getCurrentUser(req);
  if (!currentUser) return res.redirect(`${accountUrl(res.locals.locale)}&required=subscribe`);
  res.locals.currentUser = currentUser;
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

function safeSecretEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function getCurrentUser(req) {
  const userId = Number(req.session?.userId);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const user = db.prepare(`
    SELECT id, username, email, nickname, avatar_url, membership_level, session_version, created_at
    FROM users
    WHERE id = ? AND status = 'active'
  `).get(userId);
  if (!user || user.session_version !== Number(req.session.userSessionVersion)) {
    delete req.session.userId;
    delete req.session.userSessionVersion;
    return null;
  }
  return user || null;
}

function accountUrl(locale) {
  return `/account?lang=${encodeURIComponent(normalizeLocale(locale) || defaultLocale)}`;
}

function accountResetUrl(locale) {
  return `/account/reset?lang=${encodeURIComponent(normalizeLocale(locale) || defaultLocale)}`;
}

function createPasswordResetRecord(userId, locale, { invalidateExisting = true } = {}) {
  const { token, tokenHash } = createPasswordResetToken();
  const expiresAt = Date.now() + 30 * 60 * 1000;
  const result = db.transaction(() => {
    if (invalidateExisting) {
      db.prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(userId);
    }
    return db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(userId, tokenHash, expiresAt);
  })();
  return {
    id: Number(result.lastInsertRowid),
    resetUrl: `${siteUrl}/account/reset?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(normalizeLocale(locale) || defaultLocale)}`,
  };
}

async function sendAdminPasswordReset(user, ip, locale) {
  if (!passwordResetSecurity.ready) return 'unavailable';
  try {
    passwordResetSecurity.consumeAdminRequest(user.email, ip);
  } catch (error) {
    if (error instanceof MemberRateLimitError) return 'limited';
    throw error;
  }

  const reset = createPasswordResetRecord(user.id, locale, { invalidateExisting: false });
  try {
    await passwordResetSecurity.sendResetEmail({ to: user.email, resetUrl: reset.resetUrl, locale });
    db.prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id != ? AND used_at IS NULL').run(user.id, reset.id);
    return 'sent';
  } catch (error) {
    db.prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(reset.id);
    console.error('管理员发送会员密码重置邮件失败：', error);
    return 'failed';
  }
}

function getUsersForAdmin() {
  return db.prepare(`
    SELECT id, username, email, nickname, avatar_url, membership_level, status, last_login_at, created_at, updated_at
    FROM users
    ORDER BY created_at DESC, id DESC
  `).all();
}

function getUserForAdmin(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare(`
    SELECT id, username, email, nickname, avatar_url, membership_level, status, last_login_at, created_at, updated_at
    FROM users
    WHERE id = ?
  `).get(id) || null;
}

function emptyManagedUser() {
  return { username: '', email: '', nickname: '', membership_level: 0, status: 'active', avatar_url: '' };
}

function managedUserFromBody(body = {}) {
  return {
    username: String(body.username || '').trim().toLowerCase(),
    email: normalizeEmail(body.email),
    nickname: String(body.nickname || '').trim(),
    membership_level: Number(body.membership_level),
    status: String(body.status || ''),
    avatar_url: '',
  };
}

function validateManagedUser(body) {
  return validateManagedUserFields(body);
}

function assertManagedUserUnique(user, excludedId = null) {
  const duplicateUsername = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND (? IS NULL OR id != ?) LIMIT 1')
    .get(user.username, excludedId, excludedId);
  if (duplicateUsername) throw Object.assign(new Error('MANAGED_USERNAME_EXISTS'), { code: 'MANAGED_USERNAME_EXISTS' });
  const duplicateEmail = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND (? IS NULL OR id != ?) LIMIT 1')
    .get(user.email, excludedId, excludedId);
  if (duplicateEmail) throw Object.assign(new Error('MANAGED_EMAIL_EXISTS'), { code: 'MANAGED_EMAIL_EXISTS' });
}

function unusablePasswordHash() {
  return `pending$${crypto.randomBytes(32).toString('base64url')}`;
}

function managedUserError(error) {
  const messages = {
    INVALID_MANAGED_USERNAME: '登录名只能使用 3–32 位英文字母。',
    INVALID_MANAGED_EMAIL: '请输入有效的邮箱地址。',
    INVALID_MANAGED_NICKNAME: '昵称不能为空，且不能超过 20 个字符。',
    INVALID_MANAGED_LEVEL: '会员等级只能选择 0–5。',
    INVALID_MANAGED_STATUS: '请选择有效的用户状态。',
    MANAGED_USERNAME_EXISTS: '这个登录名已经被使用。',
    MANAGED_EMAIL_EXISTS: '这个邮箱已经注册。',
  };
  return messages[error?.code] || '用户信息保存失败，请检查后重试。';
}

function renderAdminUserForm(req, res, { user, isNew, error = null }) {
  const resetMessages = {
    sent: '密码重置邮件已发送。链接将在 30 分钟后失效。',
    failed: '用户已保存，但邮件发送失败，请稍后重试。',
    limited: '发送过于频繁，同一用户至少间隔 2 分钟。',
    unavailable: '邮件功能尚未配置，暂时不能发送密码重置邮件。',
    blocked: '该用户已被封禁，不能发送有效的密码重置链接。',
  };
  return res.render('admin/user-form', {
    user,
    isNew,
    error,
    csrf: req.session.csrf,
    saved: req.query.saved === '1',
    created: req.query.created === '1',
    resetMessage: resetMessages[req.query.reset] || null,
    resetError: ['failed', 'limited', 'unavailable', 'blocked'].includes(req.query.reset),
    passwordResetAvailable: passwordResetSecurity.ready,
  });
}

function findValidPasswordReset(tokenHash) {
  if (!/^[a-f0-9]{64}$/.test(String(tokenHash || ''))) return null;
  return db.prepare(`
    SELECT password_reset_tokens.id, password_reset_tokens.user_id, users.username, users.email
    FROM password_reset_tokens
    JOIN users ON users.id = password_reset_tokens.user_id
    WHERE password_reset_tokens.token_hash = ?
      AND password_reset_tokens.used_at IS NULL
      AND password_reset_tokens.expires_at > ?
      AND users.status = 'active'
    LIMIT 1
  `).get(tokenHash, Date.now()) || null;
}

function getPendingPasswordReset(req) {
  return findValidPasswordReset(req.session?.pendingPasswordReset);
}

function validMemberCsrf(req) {
  const supplied = String(req.body?.csrf || '');
  return Boolean(req.session.memberCsrf && safeEqual(supplied, req.session.memberCsrf));
}

function renderAccount(req, res, {
  mode = ['register', 'forgot'].includes(req.query.mode) ? req.query.mode : 'login',
  errorCode = null,
  fields = {},
  retryAfterSeconds = 0,
  resetAvailable = false,
} = {}) {
  if (!req.session.memberCsrf) req.session.memberCsrf = createLoginCsrf();
  const copy = accountCopy(res.locals.locale);
  const currentUser = getCurrentUser(req);
  const storedRetry = Math.max(0, Math.ceil((Number(req.session.registrationNextSendAt || 0) - Date.now()) / 1000));
  return res.render('account', {
    copy,
    mode,
    error: errorCode ? (copy.errors[errorCode] || copy.errors.INVALID_REGISTRATION) : null,
    fields,
    memberCsrf: req.session.memberCsrf,
    currentUser,
    subscribeCopyLabel: subscribeCopy(res.locals.locale).title,
    registrationAvailable: registrationSecurity.ready,
    passwordResetAvailable: passwordResetSecurity.ready,
    resetAvailable,
    retryAfterSeconds: Math.max(retryAfterSeconds, storedRetry),
    registered: req.query.registered === '1',
    passwordReset: req.query.reset === '1',
    resetRequestSent: req.query.sent === '1',
  });
}

function memberCodeResponse(req, res, wantsJson, errorCode, fields = {}) {
  const copy = accountCopy(res.locals.locale);
  const message = copy.errors[errorCode] || copy.errors.CODE_SEND_FAILED;
  if (wantsJson) return res.json({ ok: false, message, retryAfterSeconds: 0 });
  return renderAccount(req, res, { mode: 'register', errorCode, fields });
}

function handleMemberRateLimit(req, res, error, mode, fields = {}) {
  if (!(error instanceof MemberRateLimitError)) throw error;
  res.set('Retry-After', String(error.retryAfterSeconds));
  return renderAccount(req, res.status(429), { mode, errorCode: 'TOO_MANY', retryAfterSeconds: error.retryAfterSeconds, fields });
}

function consumeMemberRegistrationAttempt(req, res, next) {
  try {
    registrationSecurity.consumeRegistrationAttempt(req.ip);
    next();
  } catch (error) {
    handleMemberRateLimit(req, res, error, 'register');
  }
}

function parseAvatarUpload(req, res, next) {
  avatarUpload.single('avatar')(req, res, error => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return renderAccount(req, res.status(413), { mode: 'register', errorCode: 'AVATAR_TOO_LARGE', fields: memberFormFields(req.body) });
    }
    console.warn('头像上传解析失败：', error.message);
    return renderAccount(req, res.status(400), { mode: 'register', errorCode: 'INVALID_AVATAR', fields: memberFormFields(req.body) });
  });
}

function clearRegistrationChallenge(req) {
  registrationSecurity.invalidateChallenge(req.session.registrationChallenge);
  delete req.session.registrationChallenge;
  delete req.session.registrationEmail;
  delete req.session.registrationNextSendAt;
}

function memberFormFields(body = {}) {
  return {
    username: String(body.username || ''),
    email: String(body.email || ''),
    nickname: String(body.nickname || ''),
  };
}

function subscribeCopy(locale) {
  if (String(locale).startsWith('ja')) return {
    title: '配信設定', eyebrow: 'SUBSCRIBE', lead: 'AFTERIMAGE から届くメールを選択できます。配信先は登録済みのメールアドレスです。', defaultNote: 'すべての配信は初期状態でオンです。不要な項目だけスイッチをオフにしてください。',
    email: '配信先', save: '設定を保存', saved: '配信設定を保存しました。', back: 'アカウントに戻る',
    newPosts: '新しい記事', newPostsDescription: '新しい記事を公開した際に、記事本文をメールでお届けします。',
    newsletter: 'ニュースレター', newsletterDescription: '写真、制作ノート、サイトからのお知らせをまとめてお届けします。', reserved: '準備中',
    events: 'イベントのお知らせ', eventsDescription: '展示、トーク、その他のイベント情報をお届けします。',
  };
  if (String(locale).startsWith('en')) return {
    title: 'Email subscriptions', eyebrow: 'SUBSCRIBE', lead: 'Choose which emails you would like to receive from AFTERIMAGE. We will use the email address already attached to your account.', defaultNote: 'All email types are on by default. Turn a switch off to opt out of that category.',
    email: 'Delivered to', save: 'Save preferences', saved: 'Your subscription preferences have been saved.', back: 'Back to account',
    newPosts: 'New articles', newPostsDescription: 'Receive a beautifully formatted email when a new article is published.',
    newsletter: 'Newsletter', newsletterDescription: 'Occasional notes about photography, ongoing work, and updates from the site.', reserved: 'Coming soon',
    events: 'Event updates', eventsDescription: 'News about exhibitions, talks, and other AFTERIMAGE events.',
  };
  return {
    title: '邮件订阅', eyebrow: 'SUBSCRIBE', lead: '选择你希望从 AFTERIMAGE 收到的邮件。我们会直接使用会员账号绑定的邮箱。', defaultNote: '所有邮件默认开启；关闭开关后，系统只记录你不希望接收的类型。',
    email: '接收邮箱', save: '保存订阅设置', saved: '订阅设置已保存。', back: '返回会员中心',
    newPosts: '新文章推送', newPostsDescription: '新文章发布后，通过排版完整的邮件收到文章内容。',
    newsletter: 'Newsletter', newsletterDescription: '不定期收到摄影、创作手记与网站近况。', reserved: '功能准备中',
    events: '活动推送', eventsDescription: '收到展览、分享会以及其他 AFTERIMAGE 活动信息。',
  };
}

function accountCopy(locale) {
  if (String(locale).startsWith('ja')) return {
    login: 'ログイン', register: '新規登録', account: 'アカウント', logout: 'ログアウト',
    loginLead: 'メールアドレスまたはログイン名でログイン', identifier: 'メールアドレスまたはログイン名', password: 'パスワード', rememberMe: '30日間ログイン状態を保持する', loginButton: 'ログイン',
    chooseFile: '画像を選択', noFileChosen: '選択されていません', memberPromo: 'AFTERIMAGE のメンバーになると、会員向けのお知らせやサイトの最新情報を確認でき、新しい記事、写真プロジェクト、厳選したコンテンツを定期メールで受け取れます。',
    forgotPassword: 'パスワードをお忘れですか？', forgotTitle: 'パスワードを忘れた場合', forgotLead: '登録済みのメールアドレスへ再設定リンクを送信します。', sendResetLink: '再設定リンクを送信', resetSent: '登録済みの場合、再設定リンクを送信しました。メールをご確認ください。',
    resetTitle: 'パスワードを再設定', resetLead: '新しい安全なパスワードを入力してください。', newPassword: '新しいパスワード', resetButton: 'パスワードを変更', resetSuccess: 'パスワードを変更しました。新しいパスワードでログインしてください。',
    noAccount: 'アカウントをお持ちでないですか？', createAccount: '新規登録', haveAccount: 'すでにアカウントをお持ちですか？', backToLogin: 'ログインへ',
    username: 'ログイン名', usernameHint: '半角英字のみ、3〜32文字', email: 'メールアドレス', nickname: 'ニックネーム',
    passwordHint: '12文字以上で、大文字・小文字・数字・記号を含めてください', passwordConfirm: 'パスワード（確認）', avatar: 'プロフィール画像（任意）', avatarHint: 'JPEG、PNG、WebP、AVIF。最大1 MiB。',
    code: '6桁の確認コード', sendCode: '確認コードを送信', sendingCode: '送信中…', codeSent: '確認コードを送信しました。5分以内に入力してください。', registerButton: '登録する',
    welcome: 'ようこそ', level: '会員レベル', registered: '登録が完了しました。', tooMany: '操作が多すぎます。しばらくしてから再試行してください。', secondsUntilResend: seconds => `${seconds}秒後に再送できます`,
    errors: {
      EXPIRED_FORM: 'ページの有効期限が切れました。更新して再試行してください。', INVALID_LOGIN: 'ログイン情報が正しくありません。', INVALID_USERNAME: 'ログイン名は3〜32文字の半角英字で入力してください。', INVALID_EMAIL: '有効なメールアドレスを入力してください。', INVALID_NICKNAME: 'ニックネームは1〜20文字で入力してください。', PASSWORD_MISMATCH: 'パスワードが一致しません。', WEAK_PASSWORD: 'パスワードは12文字以上で、大文字・小文字・数字・記号を含め、ログイン名やメールアドレスの一部を含めないでください。', USERNAME_EXISTS: 'このログイン名はすでに使用されています。', EMAIL_EXISTS: 'このメールアドレスはすでに登録されています。', INVALID_CODE: '確認コードが正しくありません。', EXPIRED_CODE: '確認コードの有効期限が切れました。もう一度送信してください。', MAIL_UNAVAILABLE: '現在、メール機能をご利用いただけません。', CODE_SEND_FAILED: '確認コードを送信できませんでした。後でもう一度お試しください。', TOO_MANY: '試行回数が多すぎます。しばらくしてから再試行してください。', AVATAR_TOO_LARGE: 'プロフィール画像は1 MiB以下にしてください。', INVALID_AVATAR: '対応していない画像形式です。', REGISTRATION_FAILED: '登録できませんでした。新しい確認コードで再試行してください。', INVALID_REGISTRATION: '入力内容を確認してください。', INVALID_RESET_TOKEN: 'この再設定リンクは無効、使用済み、または期限切れです。', RESET_FAILED: 'パスワードを変更できませんでした。後でもう一度お試しください。',
    },
  };
  if (String(locale).startsWith('en')) return {
    login: 'Login', register: 'Register', account: 'Account', logout: 'Log out',
    loginLead: 'Sign in with your email or login name', identifier: 'Email or login name', password: 'Password', rememberMe: 'Remember me for 30 days', loginButton: 'Login',
    chooseFile: 'Choose image', noFileChosen: 'No image selected', memberPromo: 'Join AFTERIMAGE to follow member news and site updates, discover new stories and photography projects, and receive occasional curated emails.',
    forgotPassword: 'Forgot your password?', forgotTitle: 'Forgot password', forgotLead: 'We will send a reset link to your registered email address.', sendResetLink: 'Send reset link', resetSent: 'If that address is registered, a reset link has been sent. Check your email.',
    resetTitle: 'Reset password', resetLead: 'Choose a new, secure password.', newPassword: 'New password', resetButton: 'Change password', resetSuccess: 'Your password was changed. Log in with your new password.',
    noAccount: 'No account yet?', createAccount: 'Create one', haveAccount: 'Already have an account?', backToLogin: 'Back to login',
    username: 'Login name', usernameHint: 'English letters only, 3–32 characters', email: 'Email', nickname: 'Nickname',
    passwordHint: 'At least 12 characters with uppercase, lowercase, number, and symbol', passwordConfirm: 'Confirm password', avatar: 'Avatar (optional)', avatarHint: 'JPEG, PNG, WebP, or AVIF. Maximum 1 MiB.',
    code: '6-digit verification code', sendCode: 'Send code', sendingCode: 'Sending…', codeSent: 'Verification code sent. Enter it within 5 minutes.', registerButton: 'Create account',
    welcome: 'Welcome', level: 'Membership level', registered: 'Your account has been created.', tooMany: 'Too many attempts. Please try again later.', secondsUntilResend: seconds => `Send again in ${seconds}s`,
    errors: {
      EXPIRED_FORM: 'This page has expired. Refresh and try again.', INVALID_LOGIN: 'The login details are incorrect.', INVALID_USERNAME: 'Use 3–32 English letters for the login name.', INVALID_EMAIL: 'Enter a valid email address.', INVALID_NICKNAME: 'Nickname must be between 1 and 20 characters.', PASSWORD_MISMATCH: 'The passwords do not match.', WEAK_PASSWORD: 'Use at least 12 characters with uppercase, lowercase, number, and symbol, without your login name or email name.', USERNAME_EXISTS: 'That login name is already in use.', EMAIL_EXISTS: 'That email address is already registered.', INVALID_CODE: 'The verification code is incorrect.', EXPIRED_CODE: 'The verification code has expired. Send a new one.', MAIL_UNAVAILABLE: 'Email features are temporarily unavailable.', CODE_SEND_FAILED: 'The verification code could not be sent. Try again later.', TOO_MANY: 'Too many attempts. Please try again later.', AVATAR_TOO_LARGE: 'The avatar must be no larger than 1 MiB.', INVALID_AVATAR: 'That image format is not supported.', REGISTRATION_FAILED: 'Registration failed. Request a new code and try again.', INVALID_REGISTRATION: 'Check the information you entered.', INVALID_RESET_TOKEN: 'This reset link is invalid, expired, or has already been used.', RESET_FAILED: 'The password could not be changed. Please try again later.',
    },
  };
  return {
    login: '登录', register: '注册', account: '会员中心', logout: '退出登录',
    loginLead: '使用邮箱或登录名登录', identifier: '邮箱或登录名', password: '密码', rememberMe: '30 天内记住我', loginButton: '登录',
    chooseFile: '选择图片', noFileChosen: '未选择图片', memberPromo: '成为 AFTERIMAGE 会员，可以查看会员消息和站点动态，及时了解新文章、摄影项目与精选内容，并定期收到会员邮件。',
    forgotPassword: '忘记密码？', forgotTitle: '忘记密码', forgotLead: '我们会向注册邮箱发送密码重置链接。', sendResetLink: '发送重置链接', resetSent: '如果该邮箱已经注册，重置链接已发送，请检查邮件。',
    resetTitle: '重新设置密码', resetLead: '请输入一个新的安全密码。', newPassword: '新密码', resetButton: '修改密码', resetSuccess: '密码已经修改，请使用新密码登录。',
    noAccount: '还没有账号？', createAccount: '立即注册', haveAccount: '已经有账号？', backToLogin: '返回登录',
    username: '登录名', usernameHint: '仅限英文字母，3–32 位', email: '邮箱', nickname: '昵称',
    passwordHint: '至少 12 位，并同时包含大小写字母、数字和符号', passwordConfirm: '确认密码', avatar: '头像（非必填）', avatarHint: '支持 JPEG、PNG、WebP、AVIF，最大 1 MiB。',
    code: '6 位邮箱验证码', sendCode: '发送验证码', sendingCode: '正在发送…', codeSent: '验证码已发送，请在 5 分钟内填写。', registerButton: '完成注册',
    welcome: '欢迎', level: '会员等级', registered: '账号注册成功。', tooMany: '操作过于频繁，请稍后再试。', secondsUntilResend: seconds => `${seconds} 秒后可重新发送`,
    errors: {
      EXPIRED_FORM: '页面已过期，请刷新后重试。', INVALID_LOGIN: '邮箱、登录名或密码不正确。', INVALID_USERNAME: '登录名只能使用 3–32 位英文字母。', INVALID_EMAIL: '请输入有效的邮箱地址。', INVALID_NICKNAME: '昵称长度必须为 1–20 个字符。', PASSWORD_MISMATCH: '两次输入的密码不一致。', WEAK_PASSWORD: '密码至少 12 位，必须包含大小写字母、数字和符号，并且不能包含登录名或邮箱名称。', USERNAME_EXISTS: '这个登录名已经被使用。', EMAIL_EXISTS: '这个邮箱已经注册。', INVALID_CODE: '邮箱验证码不正确。', EXPIRED_CODE: '验证码已失效，请重新发送。', MAIL_UNAVAILABLE: '邮件功能暂时不可用，请稍后再试。', CODE_SEND_FAILED: '验证码发送失败，请稍后再试。', TOO_MANY: '尝试次数过多，请稍后再试。', AVATAR_TOO_LARGE: '头像不能超过 1 MiB。', INVALID_AVATAR: '头像格式不支持。', REGISTRATION_FAILED: '注册失败，请重新获取验证码后再试。', INVALID_REGISTRATION: '请检查注册信息。', INVALID_RESET_TOKEN: '这个重置链接无效、已经使用或已经过期。', RESET_FAILED: '密码修改失败，请稍后再试。',
    },
  };
}

function createLoginCsrf() {
  return crypto.randomBytes(24).toString('base64url');
}

function validLoginCsrf(req) {
  const supplied = String(req.body?.csrf || '');
  return Boolean(req.session.loginCsrf && safeEqual(supplied, req.session.loginCsrf));
}

function renderAdminLogin(req, res, { error = null, retryAfterSeconds = 0 } = {}) {
  if (!req.session.loginCsrf) req.session.loginCsrf = createLoginCsrf();
  const challengeId = req.session.pendingAdminChallenge;
  const awaitingCode = adminLoginSecurity.hasActiveChallenge(challengeId);
  if (!awaitingCode && challengeId) delete req.session.pendingAdminChallenge;
  return res.render('admin/login', {
    error,
    stage: awaitingCode ? 'code' : 'password',
    loginCsrf: req.session.loginCsrf,
    retryAfterSeconds,
  });
}

function handleLoginRateLimit(req, res, error) {
  if (!(error instanceof AdminLoginRateLimitError)) throw error;
  res.set('Retry-After', String(error.retryAfterSeconds));
  return renderAdminLogin(req, res.status(429), {
    error: `尝试次数过多，请在 ${formatRetryTime(error.retryAfterSeconds)}后重试。`,
    retryAfterSeconds: error.retryAfterSeconds,
  });
}

function formatRetryTime(seconds) {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
}

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

function waitForMinimumDuration(startedAt, minimumMs) {
  const remaining = Math.max(0, minimumMs - (Date.now() - startedAt));
  return new Promise(resolve => setTimeout(resolve, remaining));
}

function friendlyError(error) {
  if (String(error.message).includes('UNIQUE constraint failed')) return '这个 URL 已经被使用';
  if (error.message === 'INVALID_SLUG') return 'URL 只能包含英文字母、数字、连字符和下划线';
  if (error.message === 'INVALID_AUTHOR') return '作者名称不能超过 100 个字符';
  if (error.message === 'INVALID_CATEGORY') return '请选择有效的文章分类';
  if (error.message === 'INVALID_GALLERY_NAME') return 'Gallery 名称不能为空，且不能超过 160 个字符';
  if (error.message === 'INVALID_GALLERY_SLUG') return 'Gallery URL 只能包含英文字母、数字、连字符和下划线';
  if (error.message === 'INVALID_GALLERY_DESCRIPTION') return 'Gallery 描述不能超过 5000 个字符';
  if (error.message === 'INVALID_GALLERY_THEME') return '请选择有效的 Gallery 皮肤';
  if (error.message === 'INVALID_GALLERY_THEME_OPTIONS') return '皮肤参数超出允许范围，请检查后重试';
  if (error.message === 'INVALID_GALLERY_RELATED_URLS') return '关联文章每行填写一个站内 / 开头地址或完整 HTTP/HTTPS 地址，最多 20 个';
  if (error.message === 'INVALID_GALLERY_DATE') return '请输入有效的日期和时间';
  if (error.message === 'INVALID_GALLERY_PHOTO') return 'Gallery 中包含无效的照片，请刷新页面后重试';
  if (error.message === 'INVALID_PHOTO_DESCRIPTION') return '单张照片描述不能超过 1000 个字符';
  if (error.message === 'INVALID_GALLERY_COVER') return '封面必须选择当前 Gallery 中的照片';
  if (error.message === 'GALLERY_NOT_FOUND') return '这个 Gallery 已经不存在';
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
