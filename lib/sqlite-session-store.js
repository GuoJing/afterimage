import session from 'express-session';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const MAX_SESSION_BYTES = 64 * 1024;

export class SqliteSessionStore extends session.Store {
  constructor({ db, ttlMs = DEFAULT_TTL_MS, cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS, now = () => Date.now() } = {}) {
    super();
    if (!db || typeof db.prepare !== 'function') throw new TypeError('SqliteSessionStore 需要 better-sqlite3 数据库实例');
    this.db = db;
    this.ttlMs = ttlMs;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    `);
    this.statements = {
      get: db.prepare('SELECT sess, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(`
        INSERT INTO sessions (sid, sess, expires_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          sess = excluded.sess,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ?, updated_at = ? WHERE sid = ?'),
      clear: db.prepare('DELETE FROM sessions'),
      length: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    };
    this.pruneExpired();
    this.cleanupTimer = setInterval(() => this.pruneExpired(), cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  get(sid, callback) {
    try {
      const key = normalizeSid(sid);
      const row = this.statements.get.get(key);
      if (!row) return callback(null, null);
      if (row.expires_at <= this.now()) {
        this.statements.destroy.run(key);
        return callback(null, null);
      }
      let value;
      try {
        value = JSON.parse(row.sess);
      } catch {
        this.statements.destroy.run(key);
        return callback(null, null);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        this.statements.destroy.run(key);
        return callback(null, null);
      }
      return callback(null, value);
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      const key = normalizeSid(sid);
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_BYTES) throw new Error('Session 数据超过 64 KiB 限制');
      const currentTime = this.now();
      this.statements.set.run(key, serialized, sessionExpiresAt(value, currentTime, this.ttlMs), currentTime);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.statements.destroy.run(normalizeSid(sid));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    try {
      const currentTime = this.now();
      this.statements.touch.run(sessionExpiresAt(value, currentTime, this.ttlMs), currentTime, normalizeSid(sid));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clear(callback = () => {}) {
    try {
      this.statements.clear.run();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  length(callback) {
    try {
      callback(null, this.statements.length.get(this.now()).count);
    } catch (error) {
      callback(error);
    }
  }

  pruneExpired() {
    try {
      this.statements.prune.run(this.now());
    } catch (error) {
      this.emit('disconnect', error);
    }
  }

  dispose() {
    clearInterval(this.cleanupTimer);
  }
}

function normalizeSid(value) {
  const sid = String(value || '');
  if (!sid || sid.length > 512 || /[\u0000-\u001f\u007f]/.test(sid)) throw new Error('Session ID 无效');
  return sid;
}

function sessionExpiresAt(value, currentTime, ttlMs) {
  const rawExpires = value?.cookie?.expires;
  const expiresAt = rawExpires ? new Date(rawExpires).getTime() : NaN;
  return Number.isFinite(expiresAt) && expiresAt > currentTime ? expiresAt : currentTime + ttlMs;
}
