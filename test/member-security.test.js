import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationSecurity, hashPassword, MemberRateLimitError, validateMemberFields, verifyPassword } from '../lib/member-security.js';

test('会员字段与强密码规则', () => {
  const fields = validateMemberFields({
    username: 'Alice',
    email: 'Alice@Example.com',
    nickname: '爱丽丝',
    password: 'Moonlight-Camera-2026!',
    passwordConfirm: 'Moonlight-Camera-2026!',
  });
  assert.equal(fields.username, 'alice');
  assert.equal(fields.email, 'alice@example.com');
  assert.equal(fields.nickname, '爱丽丝');
  assert.throws(() => validateMemberFields({ username: 'alice1', email: 'a@example.com', nickname: 'A', password: 'Moonlight-Camera-2026!', passwordConfirm: 'Moonlight-Camera-2026!' }), { code: 'INVALID_USERNAME' });
  assert.throws(() => validateMemberFields({ username: 'alice', email: 'a@example.com', nickname: 'A', password: 'short', passwordConfirm: 'short' }), { code: 'WEAK_PASSWORD' });
  assert.throws(() => validateMemberFields({ username: 'alice', email: 'a@example.com', nickname: 'A', password: 'Password-2026!', passwordConfirm: 'Password-2026!' }), { code: 'WEAK_PASSWORD' });
  assert.throws(() => validateMemberFields({ username: 'alice', email: 'a@example.com', nickname: 'A', password: 'Safe-Password-2026!', passwordConfirm: 'different' }), { code: 'PASSWORD_MISMATCH' });
});

test('密码使用带随机盐的 scrypt 哈希并可安全验证', async () => {
  const first = await hashPassword('Safe-Password-2026!');
  const second = await hashPassword('Safe-Password-2026!');
  assert.match(first, /^scrypt\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('Safe-Password-2026!', first), true);
  assert.equal(await verifyPassword('Wrong-Password-2026!', first), false);
  assert.equal(await verifyPassword('anything', null), false);
});

test('注册验证码五分钟过期、一次性使用并限制两分钟重发', async t => {
  let currentTime = 10_000_000;
  const deliveries = [];
  const security = createRegistrationSecurity({
    mailConfigured: true,
    deliver: async message => deliveries.push(message),
    now: () => currentTime,
    generateCode: () => '246810',
  });
  t.after(() => security.dispose());

  const first = await security.issueCode('reader@example.com', '203.0.113.50', 'zh');
  assert.equal(deliveries.length, 1);
  await assert.rejects(() => security.issueCode('reader@example.com', '203.0.113.50', 'zh'), MemberRateLimitError);
  assert.equal(security.verifyCode(first.id, 'other@example.com', '203.0.113.50', '246810').status, 'invalid');
  assert.equal(security.verifyCode(first.id, 'reader@example.com', '203.0.113.50', '246810').status, 'ok');
  assert.equal(security.verifyCode(first.id, 'reader@example.com', '203.0.113.50', '246810').status, 'missing');

  currentTime += 2 * 60 * 1000;
  const second = await security.issueCode('reader@example.com', '203.0.113.50', 'en');
  currentTime += 5 * 60 * 1000;
  assert.equal(security.verifyCode(second.id, 'reader@example.com', '203.0.113.50', '246810').status, 'expired');
});
