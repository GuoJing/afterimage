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
      status TEXT DEFAULT 'active', preferred_locale TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE posts (id INTEGER PRIMARY KEY);
    INSERT INTO users (id, username, email, nickname) VALUES (1, 'alice', 'alice@example.com', 'Alice');
    INSERT INTO users (id, username, email, nickname, status) VALUES (2, 'blocked', 'blocked@example.com', 'Blocked', 'disabled');
    INSERT INTO posts (id) VALUES (10);
  `);
  return db;
}

test('all subscription types are enabled by default without stored preference rows', () => {
  const db = createDatabase();
  const store = new SubscriptionStore(db, { defaultLocale: 'en' });
  assert.deepEqual(store.getPreferences(1), {
    new_posts: 1, newsletter: 1, events: 1,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_subscription_opt_outs').get().count, 0);
  const recipients = store.getDeliveryUsers(10);
  assert.deepEqual(recipients.map(user => user.username), ['alice']);
  assert.equal(recipients[0].locale, 'en');
  db.close();
});

test('saving preferences stores only opt-outs and removes them when re-enabled', () => {
  const db = createDatabase();
  const store = new SubscriptionStore(db);
  const saved = store.savePreferences(1, { newPosts: true, newsletter: true, events: false });
  assert.deepEqual({ newPosts: saved.new_posts, newsletter: saved.newsletter, events: saved.events }, {
    newPosts: 1, newsletter: 1, events: 0,
  });
  assert.deepEqual(db.prepare('SELECT subscription_type FROM user_subscription_opt_outs ORDER BY subscription_type').all(), [
    { subscription_type: 'events' },
  ]);
  store.savePreferences(1, { newPosts: false, newsletter: true, events: true });
  assert.deepEqual(db.prepare('SELECT subscription_type FROM user_subscription_opt_outs ORDER BY subscription_type').all(), [
    { subscription_type: 'new_posts' },
  ]);
  assert.equal(store.getDeliveryUsers(10).length, 0);
  assert.equal(store.getRecipient(1), null);
  db.close();
});

test('delivery language comes from the account and falls back to the configured default', () => {
  const db = createDatabase();
  const store = new SubscriptionStore(db, { defaultLocale: 'en' });
  assert.equal(store.getRecipient(1).locale, 'en');
  db.prepare("UPDATE users SET preferred_locale = 'ja' WHERE id = 1").run();
  assert.equal(store.getRecipient(1).locale, 'ja');
  assert.equal(store.getDeliveryUsers(10)[0].locale, 'ja');
  db.close();
});

test('successful deliveries persist and increment only on successful resend', () => {
  const db = createDatabase();
  const store = new SubscriptionStore(db, { defaultLocale: 'en' });
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
