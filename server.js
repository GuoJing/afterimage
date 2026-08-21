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
if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET)) {
  throw new Error('生产环境必须设置 ADMIN_PASSWORD 和 SESSION_SECRET');
}
const defaultLocale = normalizeLocale(process.env.DEFAULT_LOCALE || 'zh');
const configuredLocales = [...new Set((process.env.BLOG_LOCALES || 'zh,en').split(',').map(normalizeLocale).filter(Boolean))];
if (!configuredLocales.includes(defaultLocale)) configuredLocales.unshift(defaultLocale);

const localeNames = new Intl.DisplayNames([defaultLocale], { type: 'language' });
const blog = {
  title: process.env.BLOG_TITLE || 'AFTERIMAGE PHOTOGRAPHY',
  description: process.env.BLOG_DESCRIPTION || '一个关于摄影、观看与生活的个人博客。',
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
  res.locals.blog = blog;
  res.locals.locale = locale;
  res.locals.locales = configuredLocales.map(code => ({ code, name: localeNames.of(code) || code }));
  res.locals.langQuery = locale === defaultLocale ? '' : `?lang=${encodeURIComponent(locale)}`;
  res.locals.currentPath = req.path;
  res.locals.formatDate = value => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
  next();
});

app.get('/', (req, res) => {
  const posts = getPublishedPosts(res.locals.locale);
  res.render('home', { posts, renderMarkdown });
});

app.get('/posts/:slug', (req, res) => {
  const post = getPostBySlug(req.params.slug, res.locals.locale);
  if (!post || post.status !== 'published') return res.status(404).render('not-found');
  res.render('post', { post, renderMarkdown });
});

app.get('/language/:locale', (req, res) => {
  const locale = normalizeLocale(req.params.locale);
  if (configuredLocales.includes(locale)) {
    res.cookie('afterimage.locale', locale, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000 });
  }
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//')
    ? req.query.next
    : '/';
  res.redirect(next);
});

app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const supplied = String(req.body.password || '');
  const expected = process.env.ADMIN_PASSWORD || 'change-me-now';
  if (!safeEqual(supplied, expected)) {
    return res.status(401).render('admin/login', { error: '密码不正确' });
  }
  req.session.regenerate(error => {
    if (error) return res.status(500).send('无法创建登录会话');
    req.session.isAdmin = true;
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.redirect('/admin');
  });
});

app.post('/admin/logout', requireAdmin, requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAdmin, (req, res) => {
  const posts = db.prepare(`
    SELECT p.*, COALESCE(t.title, p.slug) AS title,
      (SELECT group_concat(locale, ', ') FROM post_translations WHERE post_id = p.id) AS translation_locales
    FROM posts p
    LEFT JOIN post_translations t ON t.post_id = p.id AND t.locale = ?
    ORDER BY COALESCE(p.published_at, p.created_at) DESC
  `).all(defaultLocale);
  res.render('admin/index', { posts, csrf: req.session.csrf });
});

app.get('/admin/posts/new', requireAdmin, (req, res) => {
  res.render('admin/form', { post: emptyPost(), error: null, csrf: req.session.csrf, isNew: true });
});

app.post('/admin/posts', requireAdmin, requireCsrf, (req, res) => {
  try {
    const postId = savePost(null, req.body);
    res.redirect(`/admin/posts/${postId}/edit?saved=1`);
  } catch (error) {
    res.status(400).render('admin/form', { post: postFromBody(req.body), error: friendlyError(error), csrf: req.session.csrf, isNew: true });
  }
});

app.get('/admin/posts/:id/edit', requireAdmin, (req, res) => {
  const post = getPostForAdmin(Number(req.params.id));
  if (!post) return res.status(404).render('not-found');
  res.render('admin/form', { post, error: null, csrf: req.session.csrf, isNew: false, saved: req.query.saved === '1' });
});

app.post('/admin/posts/:id', requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  try {
    savePost(id, req.body);
    res.redirect(`/admin/posts/${id}/edit?saved=1`);
  } catch (error) {
    res.status(400).render('admin/form', { post: { ...postFromBody(req.body), id }, error: friendlyError(error), csrf: req.session.csrf, isNew: false });
  }
});

app.post('/admin/posts/:id/delete', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(Number(req.params.id));
  res.redirect('/admin');
});

app.use((req, res) => res.status(404).render('not-found'));

app.listen(port, () => {
  console.log(`Afterimage Blog: http://localhost:${port}`);
  console.log(`Admin: http://localhost:${port}/admin`);
  if (!process.env.ADMIN_PASSWORD) console.warn('警告：当前后台密码是 change-me-now，请在 .env 中设置 ADMIN_PASSWORD。');
  if (!process.env.SESSION_SECRET) console.warn('警告：未设置 SESSION_SECRET，服务重启后登录会话会失效。');
});

function normalizeLocale(value) {
  return String(value || '').trim().toLowerCase().split(/[-_]/)[0].replace(/[^a-z0-9]/g, '');
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
    WHERE p.slug = ?
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
  base.translations = Object.fromEntries(db.prepare('SELECT * FROM post_translations WHERE post_id = ?').all(id).map(row => [row.locale, row]));
  return base;
}

function emptyPost() {
  return { slug: '', status: 'draft', published_at: new Date().toISOString().slice(0, 16), translations: {} };
}

function postFromBody(body) {
  const translations = {};
  for (const locale of configuredLocales) translations[locale] = {
    title: body[`title_${locale}`] || '', summary: body[`summary_${locale}`] || '', body: body[`body_${locale}`] || '',
  };
  return { slug: body.slug || '', status: body.status || 'draft', published_at: body.published_at || '', translations };
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
  for (const locale of configuredLocales) {
    const title = String(data[`title_${locale}`] || '').trim();
    const summary = String(data[`summary_${locale}`] || '').trim();
    const body = String(data[`body_${locale}`] || '').trim();
    if (!title && !summary && !body) {
      db.prepare('DELETE FROM post_translations WHERE post_id = ? AND locale = ?').run(postId, locale);
      continue;
    }
    if (!title) throw new Error(`MISSING_TITLE:${locale}`);
    db.prepare(`
      INSERT INTO post_translations (post_id, locale, title, summary, body) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(post_id, locale) DO UPDATE SET title=excluded.title, summary=excluded.summary, body=excluded.body
    `).run(postId, locale, title, summary, body);
  }
  if (!db.prepare('SELECT 1 FROM post_translations WHERE post_id = ? AND locale = ?').get(postId, defaultLocale)) {
    throw new Error('MISSING_DEFAULT');
  }
  return postId;
});

function savePost(id, data) {
  return persistPost(id, data);
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
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
  if (error.message === 'MISSING_DEFAULT') return `必须填写默认语言（${defaultLocale}）的内容`;
  if (error.message.startsWith('MISSING_TITLE:')) return `填写了翻译内容时，标题不能为空（${error.message.split(':')[1]}）`;
  return '保存失败，请检查输入内容';
}
