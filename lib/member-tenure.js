const DAY_MS = 24 * 60 * 60 * 1000;

export function formatMemberDate(value, locale = 'zh', { includeTime = false, timeZone = 'Asia/Shanghai' } = {}) {
  const date = parseDatabaseDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), includeTime ? {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone,
  } : {
    year: 'numeric', month: 'long', day: 'numeric', timeZone,
  }).format(date);
}

export function formatMemberTenure(value, locale = 'zh', now = Date.now()) {
  const joinedAt = parseDatabaseDate(value);
  const currentTime = now instanceof Date ? now.getTime() : Number(now);
  if (!joinedAt || !Number.isFinite(currentTime)) return '';

  const days = Math.max(0, Math.floor((currentTime - joinedAt.getTime()) / DAY_MS));
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const language = String(locale).toLowerCase();

  if (language.startsWith('ja')) {
    if (days < 1) return '今日、仲間になりました';
    if (days < 30) return `登録から ${days} 日`;
    if (years < 1) return `登録から ${Math.floor(days / 30)} か月`;
    return `登録から ${years} 年${months ? ` ${months} か月` : ''}`;
  }
  if (language.startsWith('en')) {
    if (days < 1) return 'Joined us today';
    if (days < 30) return `With us for ${days} ${plural(days, 'day')}`;
    if (years < 1) {
      const totalMonths = Math.floor(days / 30);
      return `With us for ${totalMonths} ${plural(totalMonths, 'month')}`;
    }
    return `With us for ${years} ${plural(years, 'year')}${months ? ` and ${months} ${plural(months, 'month')}` : ''}`;
  }
  if (days < 1) return '今天刚刚加入我们';
  if (days < 30) return `已经和我们一起 ${days} 天了`;
  if (years < 1) return `已经和我们一起 ${Math.floor(days / 30)} 个月了`;
  return `已经和我们一起 ${years} 年${months ? ` ${months} 个月` : ''}了`;
}

function parseDatabaseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const source = String(value || '').trim();
  if (!source) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(source)
    ? `${source.replace(' ', 'T')}Z`
    : source;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function intlLocale(locale) {
  const language = String(locale).toLowerCase();
  if (language.startsWith('ja')) return 'ja-JP';
  if (language.startsWith('en')) return 'en-US';
  return 'zh-CN';
}

function plural(value, unit) {
  return value === 1 ? unit : `${unit}s`;
}
