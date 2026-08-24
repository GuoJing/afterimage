import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { sendMail } from './mailer.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const REGISTRATION_CODE_TTL_MS = 5 * 60 * 1000;
const REGISTRATION_RESEND_MS = 2 * 60 * 1000;
const REGISTRATION_CODE_ATTEMPTS = 5;
const DUMMY_SALT = Buffer.from('afterimage-member-login-dummy-salt');
const DUMMY_HASH = Buffer.alloc(SCRYPT_KEY_LENGTH);

export class MemberRateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super('请求过于频繁');
    this.name = 'MemberRateLimitError';
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

export function validateMemberFields({ username, email, nickname, password, passwordConfirm }) {
  const normalized = {
    username: String(username || '').trim().toLowerCase(),
    email: normalizeEmail(email),
    nickname: String(nickname || '').trim(),
    password: String(password || ''),
  };

  if (!/^[a-z]{3,32}$/.test(normalized.username)) throw memberValidationError('INVALID_USERNAME');
  if (!isEmailAddress(normalized.email)) throw memberValidationError('INVALID_EMAIL');
  if (!normalized.nickname || normalized.nickname.length > 64 || /[\u0000-\u001f\u007f]/.test(normalized.nickname)) {
    throw memberValidationError('INVALID_NICKNAME');
  }
  if (normalized.password !== String(passwordConfirm || '')) throw memberValidationError('PASSWORD_MISMATCH');
  assertStrongPassword(normalized.password, normalized.username, normalized.email);
  return normalized;
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await derivePassword(String(password), salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password, encodedHash) {
  const parsed = parsePasswordHash(encodedHash);
  const salt = parsed?.salt || DUMMY_SALT;
  const expected = parsed?.hash || DUMMY_HASH;
  const derived = await derivePassword(String(password || ''), salt, parsed);
  return Boolean(parsed && expected.length === derived.length && crypto.timingSafeEqual(expected, derived));
}

export function createRegistrationSecurity({
  mailConfigured,
  deliver = sendMail,
  now = () => Date.now(),
  generateCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0'),
} = {}) {
  const pepper = crypto.randomBytes(32);
  const challenges = new Map();
  const sendAttempts = new Map();
  const sendCooldowns = new Map();
  const verificationAttempts = new Map();
  const registrationAttempts = new Map();
  const cleanupTimer = setInterval(cleanup, 60_000);
  cleanupTimer.unref();

  return {
    ready: Boolean(mailConfigured),

    consumeLoginAttempt(ip, identifier) {
      enforceRate(registrationAttempts, `login:${ipKey(ip)}`, 10, 15 * 60 * 1000);
      enforceRate(registrationAttempts, `login-id:${valueKey(identifier)}`, 10, 15 * 60 * 1000);
    },

    consumeRegistrationAttempt(ip) {
      enforceRate(registrationAttempts, `register:${ipKey(ip)}`, 8, 15 * 60 * 1000);
    },

    async issueCode(email, ip, locale = 'zh') {
      if (!mailConfigured) throw new Error('邮件发送未配置');
      const normalizedEmail = normalizeEmail(email);
      if (!isEmailAddress(normalizedEmail)) throw memberValidationError('INVALID_EMAIL');
      const currentTime = now();
      const ipRateKey = `send-ip:${ipKey(ip)}`;
      const emailRateKey = `send-email:${valueKey(normalizedEmail)}`;
      enforceCooldown(ipRateKey, currentTime);
      enforceCooldown(emailRateKey, currentTime);
      enforceRate(sendAttempts, ipRateKey, 3, 60 * 60 * 1000);
      enforceRate(sendAttempts, emailRateKey, 3, 60 * 60 * 1000);
      enforceRate(sendAttempts, 'send-global', 30, 60 * 60 * 1000);
      sendCooldowns.set(ipRateKey, currentTime);
      sendCooldowns.set(emailRateKey, currentTime);

      const id = crypto.randomBytes(32).toString('base64url');
      const code = generateCode();
      if (!/^\d{6}$/.test(code)) throw new Error('验证码生成器必须返回 6 位数字');
      const expiresAt = currentTime + REGISTRATION_CODE_TTL_MS;
      const copy = registrationEmailCopy(locale, code);

      await deliver({ to: normalizedEmail, subject: copy.subject, text: copy.text, html: copy.html });
      challenges.set(id, {
        digest: digestCode(id, code),
        emailKey: valueKey(normalizedEmail),
        expiresAt,
        attemptsRemaining: REGISTRATION_CODE_ATTEMPTS,
      });
      return { id, expiresAt, nextSendAt: currentTime + REGISTRATION_RESEND_MS };
    },

    verifyCode(id, email, ip, suppliedCode) {
      const ipRateKey = `verify-ip:${ipKey(ip)}`;
      enforceRate(verificationAttempts, ipRateKey, 12, 15 * 60 * 1000);
      const challengeId = String(id || '');
      const challenge = challenges.get(challengeId);
      if (!challenge) return { status: 'missing' };
      if (challenge.expiresAt <= now()) {
        challenges.delete(challengeId);
        return { status: 'expired' };
      }
      if (challenge.emailKey !== valueKey(normalizeEmail(email))) return { status: 'invalid' };

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
    return valueKey(String(ip || 'unknown'));
  }

  function valueKey(value) {
    return crypto.createHmac('sha256', pepper).update(String(value)).digest('base64url');
  }

  function enforceCooldown(key, currentTime) {
    const previous = sendCooldowns.get(key);
    if (previous !== undefined && currentTime - previous < REGISTRATION_RESEND_MS) {
      throw new MemberRateLimitError(Math.ceil((REGISTRATION_RESEND_MS - (currentTime - previous)) / 1000));
    }
  }

  function enforceRate(store, key, limit, windowMs) {
    const currentTime = now();
    const recent = (store.get(key) || []).filter(timestamp => timestamp > currentTime - windowMs);
    if (recent.length >= limit) throw new MemberRateLimitError(Math.ceil((recent[0] + windowMs - currentTime) / 1000));
    recent.push(currentTime);
    store.set(key, recent);
  }

  function cleanup() {
    const currentTime = now();
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt <= currentTime) challenges.delete(id);
    }
    pruneStore(sendAttempts, currentTime - 60 * 60 * 1000);
    pruneStore(verificationAttempts, currentTime - 15 * 60 * 1000);
    pruneStore(registrationAttempts, currentTime - 15 * 60 * 1000);
    for (const [key, timestamp] of sendCooldowns) {
      if (timestamp <= currentTime - REGISTRATION_RESEND_MS) sendCooldowns.delete(key);
    }
  }
}

function assertStrongPassword(password, username, email) {
  const length = [...password].length;
  const emailLocal = email.split('@')[0];
  const simplified = password.toLowerCase().replace(/[^a-z0-9]/g, '');
  const commonFragments = ['password', 'qwerty', 'letmein', 'welcome', 'afterimage', 'admin', '123456'];
  if (length < 12 || length > 128
    || !/[a-z]/.test(password)
    || !/[A-Z]/.test(password)
    || !/\d/.test(password)
    || !/[^A-Za-z0-9]/.test(password)
    || commonFragments.some(fragment => simplified.includes(fragment))
    || password.toLowerCase().includes(username)
    || (emailLocal.length >= 3 && password.toLowerCase().includes(emailLocal))) {
    throw memberValidationError('WEAK_PASSWORD');
  }
}

async function derivePassword(password, salt, parsed = null) {
  return scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: parsed?.N || SCRYPT_N,
    r: parsed?.r || SCRYPT_R,
    p: parsed?.p || SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

function parsePasswordHash(value) {
  const [algorithm, rawN, rawR, rawP, rawSalt, rawHash] = String(value || '').split('$');
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (algorithm !== 'scrypt' || N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return null;
  try {
    const salt = Buffer.from(rawSalt, 'base64url');
    const hash = Buffer.from(rawHash, 'base64url');
    if (salt.length !== 16 || hash.length !== SCRYPT_KEY_LENGTH) return null;
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}

function registrationEmailCopy(locale, code) {
  if (String(locale).startsWith('ja')) return {
    subject: 'AFTERIMAGE 登録確認コード',
    text: `登録確認コード：${code}\n\nこのコードは5分後に失効し、一度だけ使用できます。心当たりがない場合は、このメールを無視してください。`,
    html: `<p>登録確認コード：</p><p style="font-size:28px;font-weight:600;letter-spacing:6px">${code}</p><p>このコードは5分後に失効し、一度だけ使用できます。</p>`,
  };
  if (String(locale).startsWith('en')) return {
    subject: 'Your AFTERIMAGE registration code',
    text: `Your registration code is: ${code}\n\nIt expires in 5 minutes and can be used only once. If you did not request it, ignore this email.`,
    html: `<p>Your registration code is:</p><p style="font-size:28px;font-weight:600;letter-spacing:6px">${code}</p><p>It expires in 5 minutes and can be used only once.</p>`,
  };
  return {
    subject: 'AFTERIMAGE 注册验证码',
    text: `你的注册验证码是：${code}\n\n验证码将在 5 分钟后失效，且只能使用一次。如果不是你发起的注册，请忽略这封邮件。`,
    html: `<p>你的注册验证码是：</p><p style="font-size:28px;font-weight:600;letter-spacing:6px">${code}</p><p>验证码将在 5 分钟后失效，且只能使用一次。</p>`,
  };
}

function pruneStore(store, cutoff) {
  for (const [key, timestamps] of store) {
    const recent = timestamps.filter(timestamp => timestamp > cutoff);
    if (recent.length) store.set(key, recent);
    else store.delete(key);
  }
}

function isEmailAddress(value) {
  return value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value);
}

function memberValidationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
