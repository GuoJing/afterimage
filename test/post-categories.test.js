import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePostCategory, POST_CATEGORIES } from '../lib/post-categories.js';

test('文章分类以固定顺序和大小写保存', () => {
  assert.deepEqual(POST_CATEGORIES, ['Post', 'HOWILEARN', 'Interview', 'Friends']);
  for (const category of POST_CATEGORIES) assert.equal(normalizePostCategory(category), category);
});

test('文章分类拒绝空值、未知值和错误大小写', () => {
  assert.equal(normalizePostCategory(''), null);
  assert.equal(normalizePostCategory('Photography'), null);
  assert.equal(normalizePostCategory('post'), null);
  assert.equal(normalizePostCategory('HowILearn'), null);
});
