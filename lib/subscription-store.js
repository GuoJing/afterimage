const SUBSCRIPTION_TYPES = ['new_posts', 'newsletter', 'events'];

export class SubscriptionStore {
  constructor(db, { defaultLocale = 'zh' } = {}) {
    this.db = db;
    this.defaultLocale = defaultLocale;
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_subscription_opt_outs (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_type TEXT NOT NULL CHECK (subscription_type IN ('new_posts', 'newsletter', 'events')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, subscription_type)
      );
      CREATE INDEX IF NOT EXISTS user_subscription_opt_outs_type
      ON user_subscription_opt_outs(subscription_type, user_id);
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
    this.getOptOutsStatement = db.prepare('SELECT subscription_type FROM user_subscription_opt_outs WHERE user_id = ?');
    this.addOptOutStatement = db.prepare(`
      INSERT OR IGNORE INTO user_subscription_opt_outs (user_id, subscription_type) VALUES (?, ?)
    `);
    this.removeOptOutStatement = db.prepare(`
      DELETE FROM user_subscription_opt_outs WHERE user_id = ? AND subscription_type = ?
    `);
    this.savePreferencesTransaction = db.transaction((userId, preferences) => {
      const enabledByType = {
        new_posts: Boolean(preferences.newPosts),
        newsletter: Boolean(preferences.newsletter),
        events: Boolean(preferences.events),
      };
      for (const type of SUBSCRIPTION_TYPES) {
        if (enabledByType[type]) this.removeOptOutStatement.run(userId, type);
        else this.addOptOutStatement.run(userId, type);
      }
    });
    this.deliveryUsersStatement = db.prepare(`
      SELECT u.id, u.username, u.email, u.nickname, u.avatar_url,
        COALESCE(NULLIF(u.preferred_locale, ''), ?) AS locale, 1 AS new_posts,
        CASE WHEN EXISTS (
          SELECT 1 FROM user_subscription_opt_outs o
          WHERE o.user_id = u.id AND o.subscription_type = 'newsletter'
        ) THEN 0 ELSE 1 END AS newsletter,
        CASE WHEN EXISTS (
          SELECT 1 FROM user_subscription_opt_outs o
          WHERE o.user_id = u.id AND o.subscription_type = 'events'
        ) THEN 0 ELSE 1 END AS events,
        d.sent_at, COALESCE(d.send_count, 0) AS send_count, COALESCE(d.last_error, '') AS last_error,
        COALESCE(d.recipient_email, '') AS recipient_email
      FROM users u
      LEFT JOIN post_email_deliveries d ON d.post_id = ? AND d.user_id = u.id
      WHERE u.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM user_subscription_opt_outs o
          WHERE o.user_id = u.id AND o.subscription_type = 'new_posts'
        )
      ORDER BY CASE WHEN d.sent_at IS NULL THEN 0 ELSE 1 END, u.created_at ASC, u.id ASC
    `);
    this.recipientStatement = db.prepare(`
      SELECT u.id, u.username, u.email, u.nickname, u.avatar_url,
        COALESCE(NULLIF(u.preferred_locale, ''), ?) AS locale
      FROM users u
      WHERE u.id = ? AND u.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM user_subscription_opt_outs o
          WHERE o.user_id = u.id AND o.subscription_type = 'new_posts'
        )
      LIMIT 1
    `);
    this.successStatement = db.prepare(`
      INSERT INTO post_email_deliveries
        (post_id, user_id, locale, recipient_email, sent_at, send_count, last_error)
      VALUES (@postId, @userId, @locale, @email, CURRENT_TIMESTAMP, 1, '')
      ON CONFLICT(post_id, user_id) DO UPDATE SET
        locale = excluded.locale, recipient_email = excluded.recipient_email,
        sent_at = CURRENT_TIMESTAMP, send_count = post_email_deliveries.send_count + 1,
        last_error = '', updated_at = CURRENT_TIMESTAMP
    `);
    this.failureStatement = db.prepare(`
      INSERT INTO post_email_deliveries
        (post_id, user_id, locale, recipient_email, sent_at, send_count, last_error)
      VALUES (@postId, @userId, @locale, @email, NULL, 0, '发送失败')
      ON CONFLICT(post_id, user_id) DO UPDATE SET
        locale = excluded.locale, recipient_email = excluded.recipient_email,
        last_error = '发送失败', updated_at = CURRENT_TIMESTAMP
    `);
  }

  getPreferences(userId) {
    const optOuts = new Set(this.getOptOutsStatement.all(userId).map(row => row.subscription_type));
    return {
      new_posts: optOuts.has('new_posts') ? 0 : 1,
      newsletter: optOuts.has('newsletter') ? 0 : 1,
      events: optOuts.has('events') ? 0 : 1,
    };
  }

  savePreferences(userId, preferences) {
    this.savePreferencesTransaction(userId, preferences);
    return this.getPreferences(userId);
  }

  getDeliveryUsers(postId) {
    return this.deliveryUsersStatement.all(this.defaultLocale, postId);
  }

  getRecipient(userId) {
    return this.recipientStatement.get(this.defaultLocale, userId) || null;
  }

  recordSuccess(postId, user, locale) {
    this.successStatement.run({ postId, userId: user.id, locale, email: user.email });
  }

  recordFailure(postId, user, locale) {
    this.failureStatement.run({ postId, userId: user.id, locale, email: user.email });
  }
}
