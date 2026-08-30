import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { GuestbookStore, GuestbookValidationError, sanitizeGuestbookContent } from '../lib/guestbook-store.js';

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    INSERT INTO users (id, username) VALUES (1, 'member');
  `);
  return db;
}

test('guestbook content is stored as safe plain text', () => {
  assert.equal(sanitizeGuestbookContent('<b>Hello</b><script>alert(1)</script><style>body{display:none}</style> world'), 'Hello world');
  assert.equal(sanitizeGuestbookContent('first\n\nsecond'), 'first\n\nsecond');
});

test('new messages remain pending and are invisible until approved', () => {
  const db = createDatabase();
  const store = new GuestbookStore(db);
  const id = store.submit({ userId: 1, authorName: 'Member', content: 'Hello', ipHash: 'ip-a', now: 100_000 });
  assert.equal(store.countApproved(), 0);
  assert.deepEqual(store.getApproved(10, 0), []);
  assert.equal(store.getAll()[0].status, 'pending');
  store.approve(id, 101_000);
  assert.equal(store.countApproved(), 1);
  assert.equal(store.getApproved(10, 0)[0].content, 'Hello');
  db.close();
});

test('one IP can submit only once per minute', () => {
  const db = createDatabase();
  const store = new GuestbookStore(db);
  store.submit({ authorName: 'Visitor', content: 'First', ipHash: 'ip-a', now: 100_000 });
  assert.throws(
    () => store.submit({ authorName: 'Visitor', content: 'Second', ipHash: 'ip-a', now: 159_999 }),
    error => error instanceof GuestbookValidationError && error.code === 'RATE_LIMIT',
  );
  assert.doesNotThrow(() => store.submit({ authorName: 'Visitor', content: 'Other IP', ipHash: 'ip-b', now: 159_999 }));
  assert.doesNotThrow(() => store.submit({ authorName: 'Visitor', content: 'After one minute', ipHash: 'ip-a', now: 160_000 }));
  db.close();
});

test('admin can delete a message', () => {
  const db = createDatabase();
  const store = new GuestbookStore(db);
  const id = store.submit({ authorName: 'Visitor', content: 'Remove me', ipHash: 'ip-a', now: 100_000 });
  assert.equal(store.delete(id), true);
  assert.equal(store.getAll().length, 0);
  db.close();
});
