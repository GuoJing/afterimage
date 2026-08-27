import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostEmail } from '../lib/post-email.js';

test('post email uses localized copy, safe metadata, article content, and copyright', () => {
  const message = createPostEmail({
    blog: { title: 'AFTERIMAGE', author: 'GuoJing' },
    post: { title: 'A <quiet> night', summary: 'Light & shadow', body: '', rendered_locale: 'en', author: 'GuoJing', published_at: '2026-08-27' },
    articleUrl: 'https://example.com/post/en/night',
    preferencesUrl: 'https://example.com/subscribe?lang=en',
    bodyHtml: '<p>The article.</p>',
    year: 2026,
  });
  assert.equal(message.subject, 'New article｜A <quiet> night');
  assert.match(message.html, /A &lt;quiet&gt; night/);
  assert.match(message.html, /<p>The article.<\/p>/);
  assert.match(message.html, /Read the full article/);
  assert.match(message.html, /© 2026 AFTERIMAGE\. All rights reserved\./);
  assert.match(message.text, /https:\/\/example\.com\/subscribe\?lang=en/);
});
