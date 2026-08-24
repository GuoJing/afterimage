import crypto from 'node:crypto';
import { sendMail } from './mailer.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;

export class AdminLoginRateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super('登录请求过于频繁');
    this.name = 'AdminLoginRateLimitError';
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

export function createAdminLoginSecurity({
  recipient,
  mailConfigured,
  deliver = sendMail,
  now = () => Date.now(),
  generateCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0'),
} = {}) {
  const normalizedRecipient = String(recipient || '').trim();
  const recipientValid = isEmailAddress(normalizedRecipient);
  const pepper = crypto.randomBytes(32);
  const challenges = new Map();
  const passwordAttempts = new Map();
  const sendAttempts = new Map();
  const verifyAttempts = new Map();
  const sendCooldowns = new Map();
  const globalSendKey = 'global';

  const cleanupTimer = setInterval(cleanup, 60_000);
  cleanupTimer.unref();

  return {
    ready: Boolean(mailConfigured && recipientValid),
    configurationError: !mailConfigured
      ? '邮件发送尚未启用或配置不完整'
      : recipientValid ? null : 'ADMIN_2FA_EMAIL 未配置或不是有效邮箱地址',

    consumePasswordAttempt(ip) {
      enforceRate(passwordAttempts, ipKey(ip), 8, 15 * 60 * 1000);
    },

    async issueCode(ip) {
      const key = ipKey(ip);
      const currentTime = now();
      const lastSentAt = sendCooldowns.get(key) || 0;
      if (sendCooldowns.has(key) && currentTime - lastSentAt < 60_000) {
        throw new AdminLoginRateLimitError(Math.ceil((60_000 - (currentTime - lastSentAt)) / 1000));
      }
      enforceRate(sendAttempts, key, 3, 15 * 60 * 1000);
      enforceRate(sendAttempts, globalSendKey, 10, 60 * 60 * 1000);
      sendCooldowns.set(key, currentTime);

      const id = crypto.randomBytes(32).toString('base64url');
      const code = generateCode();
      if (!/^\d{6}$/.test(code)) throw new Error('验证码生成器必须返回 6 位数字');
      const expiresAt = currentTime + CODE_TTL_MS;

      await deliver({
        to: normalizedRecipient,
        subject: 'Afterimage 后台登录验证码',
        text: [
          `你的登录验证码是：${code}`,
          '',
          '验证码将在 10 分钟后失效，且只能使用一次。',
          '如果不是你发起的登录，请忽略这封邮件。',
        ].join('\n'),
        html: [
          '<p>你的 Afterimage 后台登录验证码是：</p>',
          `<p style="font-size:28px;font-weight:600;letter-spacing:6px">${code}</p>`,
          '<p>验证码将在 10 分钟后失效，且只能使用一次。</p>',
          '<p>如果不是你发起的登录，请忽略这封邮件。</p>',
        ].join(''),
      });

      challenges.set(id, {
        digest: digestCode(id, code),
        expiresAt,
        attemptsRemaining: CODE_MAX_ATTEMPTS,
        ipKey: key,
      });
      return { id, expiresAt };
    },

    hasActiveChallenge(id) {
      const challengeId = String(id || '');
      const challenge = challenges.get(challengeId);
      if (!challenge) return false;
      if (challenge.expiresAt <= now()) {
        challenges.delete(challengeId);
        return false;
      }
      return true;
    },

    verifyCode(id, ip, suppliedCode) {
      enforceRate(verifyAttempts, ipKey(ip), 10, 15 * 60 * 1000);
      const challengeId = String(id || '');
      const challenge = challenges.get(challengeId);
      if (!challenge) return { status: 'missing' };
      if (challenge.expiresAt <= now()) {
        challenges.delete(challengeId);
        return { status: 'expired' };
      }
      if (challenge.ipKey !== ipKey(ip)) return { status: 'invalid' };

      const candidate = String(suppliedCode || '').trim();
      const valid = /^\d{6}$/.test(candidate)
        && crypto.timingSafeEqual(challenge.digest, digestCode(challengeId, candidate));
      if (valid) {
        challenges.delete(challengeId);
        return { status: 'ok' };
      }

      challenge.attemptsRemaining -= 1;
      if (challenge.attemptsRemaining <= 0) {
        challenges.delete(challengeId);
        return { status: 'locked' };
      }
      return { status: 'invalid', attemptsRemaining: challenge.attemptsRemaining };
    },

    invalidateChallenge(id) {
      challenges.delete(String(id || ''));
    },

    dispose() {
      clearInterval(cleanupTimer);
    },
  };

  function digestCode(id, code) {
    return crypto.createHmac('sha256', pepper).update(`${id}:${code}`).digest();
  }

  function ipKey(ip) {
    return crypto.createHmac('sha256', pepper).update(String(ip || 'unknown')).digest('base64url');
  }

  function enforceRate(store, key, limit, windowMs) {
    const currentTime = now();
    const recent = (store.get(key) || []).filter(timestamp => timestamp > currentTime - windowMs);
    if (recent.length >= limit) {
      throw new AdminLoginRateLimitError(Math.ceil((recent[0] + windowMs - currentTime) / 1000));
    }
    recent.push(currentTime);
    store.set(key, recent);
  }

  function cleanup() {
    const currentTime = now();
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt <= currentTime) challenges.delete(id);
    }
    pruneRateStore(passwordAttempts, currentTime - 15 * 60 * 1000);
    pruneRateStore(verifyAttempts, currentTime - 15 * 60 * 1000);
    pruneRateStore(sendAttempts, currentTime - 60 * 60 * 1000);
    for (const [key, timestamp] of sendCooldowns) {
      if (timestamp <= currentTime - 60_000) sendCooldowns.delete(key);
    }
  }
}

function pruneRateStore(store, cutoff) {
  for (const [key, timestamps] of store) {
    const recent = timestamps.filter(timestamp => timestamp > cutoff);
    if (recent.length) store.set(key, recent);
    else store.delete(key);
  }
}

function isEmailAddress(value) {
  return value.length <= 320
    && !/[\r\n]/.test(value)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
