import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteSessionStore } from '../lib/sqlite-session-store.js';

test('SQLite Session Store 在进程重建后保留会员和管理员状态', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'afterimage-session-'));
  const databasePath = path.join(directory, 'sessions.db');
  let currentTime = Date.parse('2026-08-25T00:00:00.000Z');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let db = new Database(databasePath);
  let store = new SqliteSessionStore({ db, now: () => currentTime, cleanupIntervalMs: 60_000 });
  await setSession(store, 'member-session', {
    cookie: { expires: new Date(currentTime + 60_000).toISOString() },
    userId: 7,
    userSessionVersion: 0,
  });
  await setSession(store, 'admin-session', {
    cookie: { expires: new Date(currentTime + 60_000).toISOString() },
    isAdmin: true,
    csrf: 'secure-token',
  });
  store.dispose();
  db.close();

  db = new Database(databasePath);
  store = new SqliteSessionStore({ db, now: () => currentTime, cleanupIntervalMs: 60_000 });
  t.after(() => { store.dispose(); db.close(); });
  assert.equal((await getSession(store, 'member-session')).userId, 7);
  assert.equal((await getSession(store, 'admin-session')).isAdmin, true);
  assert.equal(await storeLength(store), 2);

  await destroySession(store, 'admin-session');
  assert.equal(await getSession(store, 'admin-session'), null);
  currentTime += 60_001;
  assert.equal(await getSession(store, 'member-session'), null);
  assert.equal(await storeLength(store), 0);
});

test('SQLite Session Store 支持续期且拒绝异常 Session ID', async t => {
  const db = new Database(':memory:');
  let currentTime = 1_000_000;
  const store = new SqliteSessionStore({ db, ttlMs: 30_000, now: () => currentTime, cleanupIntervalMs: 60_000 });
  t.after(() => { store.dispose(); db.close(); });

  await setSession(store, 'touch-session', { cookie: {}, userId: 3 });
  currentTime += 20_000;
  await touchSession(store, 'touch-session', { cookie: {} });
  currentTime += 20_000;
  assert.equal((await getSession(store, 'touch-session')).userId, 3);
  db.prepare('INSERT INTO sessions (sid, sess, expires_at, updated_at) VALUES (?, ?, ?, ?)').run('broken-session', '{invalid', currentTime + 60_000, currentTime);
  assert.equal(await getSession(store, 'broken-session'), null);
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE sid = ?').get('broken-session'), undefined);
  await assert.rejects(() => setSession(store, '', { cookie: {} }), /Session ID/);
});

function setSession(store, sid, value) {
  return new Promise((resolve, reject) => store.set(sid, value, error => error ? reject(error) : resolve()));
}

function getSession(store, sid) {
  return new Promise((resolve, reject) => store.get(sid, (error, value) => error ? reject(error) : resolve(value)));
}

function touchSession(store, sid, value) {
  return new Promise((resolve, reject) => store.touch(sid, value, error => error ? reject(error) : resolve()));
}

function destroySession(store, sid) {
  return new Promise((resolve, reject) => store.destroy(sid, error => error ? reject(error) : resolve()));
}

function storeLength(store) {
  return new Promise((resolve, reject) => store.length((error, value) => error ? reject(error) : resolve(value)));
}
