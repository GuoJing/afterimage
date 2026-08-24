import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminLoginRateLimitError, createAdminLoginSecurity } from '../lib/admin-login-security.js';

test('验证码成功后只能使用一次', async t => {
  let currentTime = 1_000_000;
  const deliveries = [];
  const security = createAdminLoginSecurity({
    recipient: 'private@example.com',
    mailConfigured: true,
    deliver: async message => deliveries.push(message),
    now: () => currentTime,
    generateCode: () => '123456',
  });
  t.after(() => security.dispose());

  const challenge = await security.issueCode('203.0.113.10');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].to, 'private@example.com');
  assert.equal(security.verifyCode(challenge.id, '203.0.113.10', '000000').status, 'invalid');
  assert.equal(security.verifyCode(challenge.id, '203.0.113.10', '123456').status, 'ok');
  assert.equal(security.verifyCode(challenge.id, '203.0.113.10', '123456').status, 'missing');
  currentTime += 1;
});

test('验证码十分钟过期并绑定请求 IP', async t => {
  let currentTime = 2_000_000;
  const security = createAdminLoginSecurity({
    recipient: 'private@example.com',
    mailConfigured: true,
    deliver: async () => {},
    now: () => currentTime,
    generateCode: () => '654321',
  });
  t.after(() => security.dispose());

  const first = await security.issueCode('203.0.113.20');
  assert.equal(security.verifyCode(first.id, '203.0.113.21', '654321').status, 'invalid');
  assert.equal(security.verifyCode(first.id, '203.0.113.20', '654321').status, 'ok');

  currentTime += 60_000;
  const second = await security.issueCode('203.0.113.20');
  currentTime += 10 * 60 * 1000;
  assert.equal(security.verifyCode(second.id, '203.0.113.20', '654321').status, 'expired');
});

test('密码、发信和验证码验证均有后端限流', async t => {
  let currentTime = 3_000_000;
  const security = createAdminLoginSecurity({
    recipient: 'private@example.com',
    mailConfigured: true,
    deliver: async () => {},
    now: () => currentTime,
    generateCode: () => '111111',
  });
  t.after(() => security.dispose());

  for (let index = 0; index < 8; index += 1) security.consumePasswordAttempt('203.0.113.30');
  assert.throws(() => security.consumePasswordAttempt('203.0.113.30'), AdminLoginRateLimitError);

  await security.issueCode('203.0.113.31');
  await assert.rejects(() => security.issueCode('203.0.113.31'), AdminLoginRateLimitError);

  const challenge = await security.issueCode('203.0.113.32');
  for (let index = 0; index < 5; index += 1) security.verifyCode(challenge.id, '203.0.113.33', '000000');
  for (let index = 0; index < 5; index += 1) security.verifyCode(challenge.id, '203.0.113.33', '000000');
  assert.throws(() => security.verifyCode(challenge.id, '203.0.113.33', '000000'), AdminLoginRateLimitError);
});
