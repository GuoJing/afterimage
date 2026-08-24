import assert from 'node:assert/strict';
import test from 'node:test';
import { createPasswordResetSecurity, createPasswordResetToken, createRegistrationSecurity, hashPassword, hashPasswordResetToken, isMemberEmail, MemberRateLimitError, sendRegistrationAdminNotification, validateManagedUserFields, validateMemberFields, validateNewPassword, verifyPassword } from '../lib/member-security.js';

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
  assert.equal(isMemberEmail('valid.reader+photo@example.co.jp'), true);
  assert.equal(isMemberEmail('.invalid@example.com'), false);
  assert.equal(isMemberEmail('invalid..reader@example.com'), false);
  assert.equal(isMemberEmail('reader@example'), false);
  assert.throws(() => validateMemberFields({ username: 'alice', email: 'not-an-email', nickname: 'A', password: 'Moonlight-Camera-2026!', passwordConfirm: 'Moonlight-Camera-2026!' }), { code: 'INVALID_EMAIL' });
  assert.throws(() => validateMemberFields({ username: 'alice', email: 'a@example.com', nickname: '中'.repeat(21), password: 'Moonlight-Camera-2026!', passwordConfirm: 'Moonlight-Camera-2026!' }), { code: 'INVALID_NICKNAME' });
  assert.equal(validateMemberFields({ username: 'alice', email: 'a@example.com', nickname: '📷'.repeat(20), password: 'Moonlight-Camera-2026!', passwordConfirm: 'Moonlight-Camera-2026!' }).nickname, '📷'.repeat(20));
  assert.throws(() => validateMemberFields({ username: 'alice1', email: 'a@example.com', nickname: 'A', password: 'Moonlight-Camera-2026!', passwordConfirm: 'Moonlight-Camera-2026!' }), { code: 'INVALID_USERNAME' });
  assert.throws(() => validateMemberFields({ username: 'alice', email: 'a@example.com', nickname: 'A', password: 'short', passwordConfirm: 'short' }), { code: 'WEAK_PASSWORD' });
  assert.throws(() => validateMemberFields({ username: 'alice', email: 'a@example.com', nickname: 'A', password: 'Password-2026!', passwordConfirm: 'Password-2026!' }), { code: 'WEAK_PASSWORD' });
  assert.throws(() => validateMemberFields({ username: 'alice', email: 'a@example.com', nickname: 'A', password: 'Safe-Password-2026!', passwordConfirm: 'different' }), { code: 'PASSWORD_MISMATCH' });
});

test('新会员注册通知只向配置的管理员邮箱发送安全审核信息', async () => {
  const deliveries = [];
  await sendRegistrationAdminNotification({
    to: 'owner@example.com',
    user: { id: 42, username: 'reader', email: 'reader@example.com', nickname: '<夜行者>' },
    reviewUrl: 'https://afterimage.photography/qiajigou/users/42/edit',
    registeredAt: new Date('2026-08-24T12:00:00.000Z'),
    deliver: async message => deliveries.push(message),
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].to, 'owner@example.com');
  assert.match(deliveries[0].text, /reader@example\.com/);
  assert.match(deliveries[0].text, /qiajigou\/users\/42\/edit/);
  assert.doesNotMatch(deliveries[0].html, /<夜行者>/);
  assert.match(deliveries[0].html, /&lt;夜行者&gt;/);
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

test('密码重置 token 使用 256 位随机值且数据库只需保存摘要', () => {
  const first = createPasswordResetToken();
  const second = createPasswordResetToken();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(hashPasswordResetToken(first.token), first.tokenHash);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.tokenHash, second.tokenHash);
  assert.equal(hashPasswordResetToken('too-short'), null);
});

test('重置密码沿用注册强密码规则', () => {
  assert.equal(isMemberEmail(' Reader@Example.com '), true);
  assert.equal(isMemberEmail('invalid'), false);
  assert.equal(validateNewPassword({
    username: 'reader',
    email: 'reader@example.com',
    password: 'Gallery-Night-2026!',
    passwordConfirm: 'Gallery-Night-2026!',
  }), 'Gallery-Night-2026!');
  assert.throws(() => validateNewPassword({ username: 'reader', email: 'reader@example.com', password: 'Gallery-Night-2026!', passwordConfirm: 'different' }), { code: 'PASSWORD_MISMATCH' });
  assert.throws(() => validateNewPassword({ username: 'reader', email: 'reader@example.com', password: 'Reader-Safe-2026!', passwordConfirm: 'Reader-Safe-2026!' }), { code: 'WEAK_PASSWORD' });
});

test('后台用户资料严格限制状态和 0–5 会员等级', () => {
  assert.deepEqual(validateManagedUserFields({
    username: 'Reader', email: 'Reader@Example.com', nickname: '读者', membership_level: '5', status: 'disabled',
  }), {
    username: 'reader', email: 'reader@example.com', nickname: '读者', membership_level: 5, status: 'disabled',
  });
  assert.throws(() => validateManagedUserFields({ username: 'reader1', email: 'reader@example.com', nickname: '读者', membership_level: 0, status: 'active' }), { code: 'INVALID_MANAGED_USERNAME' });
  assert.throws(() => validateManagedUserFields({ username: 'reader', email: 'reader@example.com', nickname: '日'.repeat(21), membership_level: 0, status: 'active' }), { code: 'INVALID_MANAGED_NICKNAME' });
  assert.throws(() => validateManagedUserFields({ username: 'reader', email: 'reader@example.com', nickname: '读者', membership_level: 6, status: 'active' }), { code: 'INVALID_MANAGED_LEVEL' });
  assert.throws(() => validateManagedUserFields({ username: 'reader', email: 'reader@example.com', nickname: '读者', membership_level: 0, status: 'blocked' }), { code: 'INVALID_MANAGED_STATUS' });
});

test('密码重置邮件按邮箱和 IP 限制两分钟重发', async t => {
  let currentTime = 20_000_000;
  const deliveries = [];
  const security = createPasswordResetSecurity({
    mailConfigured: true,
    deliver: async message => deliveries.push(message),
    now: () => currentTime,
  });
  t.after(() => security.dispose());

  security.consumeRequest('reader@example.com', '203.0.113.80');
  await security.sendResetEmail({ to: 'reader@example.com', resetUrl: 'https://example.com/account/reset?token=secret', locale: 'en' });
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].subject, /Reset/);
  await assert.rejects(async () => security.consumeRequest('reader@example.com', '203.0.113.80'), MemberRateLimitError);

  currentTime += 2 * 60 * 1000;
  assert.doesNotThrow(() => security.consumeRequest('reader@example.com', '203.0.113.80'));
  assert.doesNotThrow(() => security.consumeTokenAttempt('203.0.113.80'));
  assert.doesNotThrow(() => security.consumeAdminRequest('first@example.com', '203.0.113.90'));
  assert.doesNotThrow(() => security.consumeAdminRequest('second@example.com', '203.0.113.90'));
  assert.throws(() => security.consumeAdminRequest('first@example.com', '203.0.113.90'), MemberRateLimitError);
});
