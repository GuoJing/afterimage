import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SubscriptionStore } from '../lib/subscription-store.js';

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT, email TEXT, nickname TEXT, avatar_url TEXT DEFAULT '',
      status TEXT DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE posts (id INTEGER PRIMARY KEY);
    INSERT INTO users (id, username, email, nickname) VALUES (1, 'alice', 'alice@example.com', 'Alice');
    INSERT INTO users (id, username, email, nickname, status) VALUES (2, 'blocked', 'blocked@example.com', 'Blocked', 'disabled');
    INSERT INTO posts (id) VALUES (10);
  `);
  return db;
}

test('subscription preferences persist independently', () => {
  const db = createDatabase();
  const store = new SubscriptionStore(db);
  assert.equal(store.getPreferences(1, 'ja').new_posts, 0);
  const saved = store.savePreferences(1, { locale: 'ja', newPosts: true, newsletter: true, events: false });
  assert.deepEqual({ locale: saved.locale, newPosts: saved.new_posts, newsletter: saved.newsletter, events: saved.events }, {
    locale: 'ja', newPosts: 1, newsletter: 1, events: 0,
  });
  db.close();
});

test('successful deliveries persist and increment only on successful resend', () => {
  const db = createDatabase();
  const store = new SubscriptionStore(db);
  store.savePreferences(1, { locale: 'en', newPosts: true, newsletter: false, events: false });
  store.savePreferences(2, { locale: 'zh', newPosts: true, newsletter: false, events: false });
  const recipients = store.getDeliveryUsers(10);
  assert.equal(recipients.length, 1, 'disabled members must not receive mail');
  store.recordSuccess(10, recipients[0], 'en');
  assert.equal(store.getDeliveryUsers(10)[0].send_count, 1);
  assert.ok(store.getDeliveryUsers(10)[0].sent_at);
  store.recordFailure(10, recipients[0], 'en');
  assert.equal(store.getDeliveryUsers(10)[0].send_count, 1);
  assert.ok(store.getDeliveryUsers(10)[0].sent_at, 'a later force-send failure must not erase prior success');
  store.recordSuccess(10, recipients[0], 'en');
  assert.equal(store.getDeliveryUsers(10)[0].send_count, 2);
  db.close();
});
