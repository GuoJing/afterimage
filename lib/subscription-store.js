export class SubscriptionStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        locale TEXT NOT NULL DEFAULT 'zh',
        new_posts INTEGER NOT NULL DEFAULT 0 CHECK (new_posts IN (0, 1)),
        newsletter INTEGER NOT NULL DEFAULT 0 CHECK (newsletter IN (0, 1)),
        events INTEGER NOT NULL DEFAULT 0 CHECK (events IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS user_subscriptions_new_posts
      ON user_subscriptions(new_posts, user_id);

      CREATE TABLE IF NOT EXISTS post_email_deliveries (
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        locale TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        sent_at TEXT,
        send_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (post_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS post_email_deliveries_post
      ON post_email_deliveries(post_id, sent_at);
    `);

    this.getPreferenceStatement = db.prepare(`
      SELECT locale, new_posts, newsletter, events, updated_at
      FROM user_subscriptions
      WHERE user_id = ?
    `);
    this.savePreferenceStatement = db.prepare(`
      INSERT INTO user_subscriptions (user_id, locale, new_posts, newsletter, events)
      VALUES (@userId, @locale, @newPosts, @newsletter, @events)
      ON CONFLICT(user_id) DO UPDATE SET
        locale = excluded.locale,
        new_posts = excluded.new_posts,
        newsletter = excluded.newsletter,
        events = excluded.events,
        updated_at = CURRENT_TIMESTAMP
    `);
    this.deliveryUsersStatement = db.prepare(`
      SELECT u.id, u.username, u.email, u.nickname, u.avatar_url,
        s.locale, s.new_posts, s.newsletter, s.events,
        d.sent_at, COALESCE(d.send_count, 0) AS send_count, COALESCE(d.last_error, '') AS last_error,
        COALESCE(d.recipient_email, '') AS recipient_email
      FROM user_subscriptions s
      JOIN users u ON u.id = s.user_id AND u.status = 'active'
      LEFT JOIN post_email_deliveries d ON d.post_id = ? AND d.user_id = u.id
      WHERE s.new_posts = 1
      ORDER BY CASE WHEN d.sent_at IS NULL THEN 0 ELSE 1 END, u.created_at ASC, u.id ASC
    `);
    this.recipientStatement = db.prepare(`
      SELECT u.id, u.username, u.email, u.nickname, u.avatar_url, s.locale
      FROM user_subscriptions s
      JOIN users u ON u.id = s.user_id AND u.status = 'active'
      WHERE u.id = ? AND s.new_posts = 1
      LIMIT 1
    `);
    this.successStatement = db.prepare(`
      INSERT INTO post_email_deliveries
        (post_id, user_id, locale, recipient_email, sent_at, send_count, last_error)
      VALUES (@postId, @userId, @locale, @email, CURRENT_TIMESTAMP, 1, '')
      ON CONFLICT(post_id, user_id) DO UPDATE SET
        locale = excluded.locale,
        recipient_email = excluded.recipient_email,
        sent_at = CURRENT_TIMESTAMP,
        send_count = post_email_deliveries.send_count + 1,
        last_error = '',
        updated_at = CURRENT_TIMESTAMP
    `);
    this.failureStatement = db.prepare(`
      INSERT INTO post_email_deliveries
        (post_id, user_id, locale, recipient_email, sent_at, send_count, last_error)
      VALUES (@postId, @userId, @locale, @email, NULL, 0, '发送失败')
      ON CONFLICT(post_id, user_id) DO UPDATE SET
        locale = excluded.locale,
        recipient_email = excluded.recipient_email,
        last_error = '发送失败',
        updated_at = CURRENT_TIMESTAMP
    `);
  }

  getPreferences(userId, fallbackLocale = 'zh') {
    return this.getPreferenceStatement.get(userId) || {
      locale: fallbackLocale,
      new_posts: 0,
      newsletter: 0,
      events: 0,
      updated_at: null,
    };
  }

  savePreferences(userId, preferences) {
    this.savePreferenceStatement.run({
      userId,
      locale: preferences.locale,
      newPosts: preferences.newPosts ? 1 : 0,
      newsletter: preferences.newsletter ? 1 : 0,
      events: preferences.events ? 1 : 0,
    });
    return this.getPreferences(userId, preferences.locale);
  }

  getDeliveryUsers(postId) {
    return this.deliveryUsersStatement.all(postId);
  }

  getRecipient(userId) {
    return this.recipientStatement.get(userId) || null;
  }

  recordSuccess(postId, user, locale) {
    this.successStatement.run({ postId, userId: user.id, locale, email: user.email });
  }

  recordFailure(postId, user, locale) {
    this.failureStatement.run({ postId, userId: user.id, locale, email: user.email });
  }
}
