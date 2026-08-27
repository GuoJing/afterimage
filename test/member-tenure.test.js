import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMemberDate, formatMemberTenure } from '../lib/member-tenure.js';

const now = Date.parse('2026-08-27T12:00:00Z');

test('SQLite UTC registration dates are localized correctly', () => {
  assert.equal(formatMemberDate('2026-08-27 02:30:00', 'zh'), '2026年8月27日');
  assert.equal(formatMemberDate('2026-08-27 02:30:00', 'en'), 'August 27, 2026');
  assert.equal(formatMemberDate('2026-08-27 02:30:00', 'ja'), '2026年8月27日');
  assert.match(formatMemberDate('2026-08-27 02:30:00', 'zh', { includeTime: true }), /10:30/);
});

test('member tenure uses friendly localized copy', () => {
  assert.equal(formatMemberTenure('2026-08-27 02:30:00', 'zh', now), '今天刚刚加入我们');
  assert.equal(formatMemberTenure('2026-08-17 12:00:00', 'en', now), 'With us for 10 days');
  assert.equal(formatMemberTenure('2026-05-27 12:00:00', 'ja', now), '登録から 3 か月');
  assert.equal(formatMemberTenure('2024-06-27 12:00:00', 'zh', now), '已经和我们一起 2 年 2 个月了');
});

test('invalid registration dates render as empty text', () => {
  assert.equal(formatMemberDate('invalid', 'zh'), '');
  assert.equal(formatMemberTenure('', 'en', now), '');
});
