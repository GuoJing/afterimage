import sanitizeHtml from 'sanitize-html';

const MESSAGE_LIMIT = 2000;
const AUTHOR_LIMIT = 40;
const SUBMISSION_INTERVAL_MS = 60_000;

export class GuestbookValidationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export class GuestbookStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS guestbook_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
        ip_hash TEXT NOT NULL,
        submitted_at INTEGER NOT NULL,
        reviewed_at INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS guestbook_messages_status_time
      ON guestbook_messages(status, submitted_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS guestbook_messages_ip_time
      ON guestbook_messages(ip_hash, submitted_at DESC);
    `);
    this.recentSubmission = db.prepare(`
      SELECT 1 FROM guestbook_messages
      WHERE ip_hash = ? AND submitted_at > ?
      LIMIT 1
    `);
    this.insertMessage = db.prepare(`
      INSERT INTO guestbook_messages (user_id, author_name, content, ip_hash, submitted_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.submitTransaction = db.transaction(message => {
      if (this.recentSubmission.get(message.ipHash, message.now - SUBMISSION_INTERVAL_MS)) {
        throw new GuestbookValidationError('RATE_LIMIT');
      }
      return Number(this.insertMessage.run(
        message.userId,
        message.authorName,
        message.content,
        message.ipHash,
        message.now,
      ).lastInsertRowid);
    });
  }

  submit({ userId = null, authorName, content, ipHash, now = Date.now() }) {
    const safeAuthorName = sanitizeGuestbookAuthor(authorName);
    const safeContent = sanitizeGuestbookContent(content);
    const normalizedIpHash = String(ipHash || '').trim();
    if (!normalizedIpHash) throw new GuestbookValidationError('INVALID_REQUEST');
    return this.submitTransaction({
      userId: Number.isInteger(Number(userId)) && Number(userId) > 0 ? Number(userId) : null,
      authorName: safeAuthorName,
      content: safeContent,
      ipHash: normalizedIpHash,
      now: Number(now),
    });
  }

  countApproved() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM guestbook_messages WHERE status = 'approved'").get().count;
  }

  getApproved(limit, offset) {
    return this.db.prepare(`
      SELECT id, author_name, content, submitted_at
      FROM guestbook_messages
      WHERE status = 'approved'
      ORDER BY submitted_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  getAll() {
    return this.db.prepare(`
      SELECT m.id, m.user_id, m.author_name, m.content, m.status, m.submitted_at, m.reviewed_at,
        u.username AS account_username
      FROM guestbook_messages m
      LEFT JOIN users u ON u.id = m.user_id
      ORDER BY CASE m.status WHEN 'pending' THEN 0 ELSE 1 END, m.submitted_at DESC, m.id DESC
    `).all();
  }

  approve(id, now = Date.now()) {
    return this.db.prepare(`
      UPDATE guestbook_messages
      SET status = 'approved', reviewed_at = ?
      WHERE id = ?
    `).run(Number(now), Number(id)).changes > 0;
  }

  delete(id) {
    return this.db.prepare('DELETE FROM guestbook_messages WHERE id = ?').run(Number(id)).changes > 0;
  }
}

export function sanitizeGuestbookAuthor(value) {
  const source = normalizePlainText(value, false);
  const sanitized = stripMarkup(source).replace(/\s+/g, ' ').trim();
  if (!sanitized || Array.from(sanitized).length > AUTHOR_LIMIT) {
    throw new GuestbookValidationError('INVALID_AUTHOR');
  }
  return sanitized;
}

export function sanitizeGuestbookContent(value) {
  const source = normalizePlainText(value, true);
  if (!source) throw new GuestbookValidationError('EMPTY_CONTENT');
  if (Array.from(source).length > MESSAGE_LIMIT) throw new GuestbookValidationError('CONTENT_TOO_LONG');
  const sanitized = stripMarkup(source)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!sanitized) throw new GuestbookValidationError('UNSAFE_CONTENT');
  return sanitized;
}

function normalizePlainText(value, allowNewlines) {
  let text = String(value || '').normalize('NFKC').replace(/\r\n?/g, '\n');
  text = text.replace(allowNewlines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '');
  return text.trim();
}

function stripMarkup(value) {
  return sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
  });
}

export const guestbookLimits = {
  author: AUTHOR_LIMIT,
  content: MESSAGE_LIMIT,
  intervalMs: SUBMISSION_INTERVAL_MS,
};
