/**
 * 扩展内置的中英文本地化。
 *
 * 语言来源：优先 `chrome.i18n.getUILanguage()`（跟随浏览器界面语言），
 * 在普通页面 / Node 测试中回退到 `navigator.language` / 默认中文。
 *
 * 约定：
 *  - 界面静态文案：HTML 里写 `data-i18n="key"`，加载时调用 applyI18n()
 *  - JS 动态文案：t('key', { name: 'x' })
 *  - 分析报告（机制名、判断依据、提示）以中文存库，渲染时用 localize* 转成当前语言；
 *    这样同一份报告在切换语言后也能正确显示。
 */

import { zh } from './locales/zh.js';
import { en } from './locales/en.js';

export const LOCALES = ['zh', 'en'];
const DICTS = { zh, en };

/** 浏览器界面语言 → 支持的 locale（目前 zh / en，其余一律英文） */
export function resolveLocale(raw) {
  const value = String(raw || '');
  return /^zh\b|^zh-/i.test(value) ? 'zh' : 'en';
}

/** 设置里的 language（auto / zh / en）→ 实际 locale */
export function resolveLanguageSetting(value) {
  if (value === 'zh' || value === 'en') return value;
  return detectLocale();
}

/** 应用设置里的语言（auto 时跟随浏览器），并刷新页面静态文案 */
export function applyLanguageSetting(value) {
  return setLocale(resolveLanguageSetting(value));
}

export function detectLocale() {
  // 调试/预览用：扩展页面可以加 ?lang=en 强制语言（正常使用时不存在该参数）
  try {
    if (typeof location !== 'undefined' && location?.search) {
      const forced = new URLSearchParams(location.search).get('lang');
      if (forced) return resolveLocale(forced);
    }
  } catch {
    /* 忽略 */
  }
  try {
    const fromChrome = globalThis.chrome?.i18n?.getUILanguage?.();
    if (fromChrome) return resolveLocale(fromChrome);
  } catch {
    /* 忽略 */
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.language) return resolveLocale(navigator.language);
  } catch {
    /* 忽略 */
  }
  // 检测不到时回退中文（扩展原本的默认语言）
  return 'zh';
}

let fixedLocale = null;

export function getLocale() {
  return fixedLocale || detectLocale();
}

export function setLocale(locale) {
  fixedLocale = resolveLocale(locale);
  if (typeof document !== 'undefined') applyI18n(document);
  return fixedLocale;
}

function interpolate(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (match, name) =>
    params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** 取一条文案；缺 key 时回退中文，再回退 key 本身，便于发现漏翻 */
export function t(key, params = {}, locale = getLocale()) {
  const dict = DICTS[locale] || DICTS.zh;
  const value = dict[key] ?? DICTS.zh[key];
  if (value === undefined) return key;
  return interpolate(value, params);
}

/** 是否有某条文案（动态 id 用） */
export function has(key, locale = getLocale()) {
  return Object.prototype.hasOwnProperty.call(DICTS[locale] || DICTS.zh, key);
}

/** 把 HTML 里的 data-i18n* 全部替换为当前语言 */
export function applyI18n(root = typeof document !== 'undefined' ? document : null) {
  if (!root) return;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : 'en';
    const title = document.querySelector('title[data-i18n]');
    if (title) document.title = t(title.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n-html]')) {
    element.innerHTML = t(element.dataset.i18nHtml);
  }
  for (const element of root.querySelectorAll('[data-i18n-placeholder]')) {
    element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder));
  }
  for (const element of root.querySelectorAll('[data-i18n-title]')) {
    element.setAttribute('title', t(element.dataset.i18nTitle));
  }
  for (const element of root.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  }
}

// ---------------------------------------------------------------------------
// 分析报告本地化
// ---------------------------------------------------------------------------

const MECHANISM_IDS = [
  'session-cookie',
  'jwt-cookie',
  'bearer-token',
  'oauth2-oidc',
  'token-header',
  'api-key',
  'basic-auth',
  'saml-sso',
  'cas-sso',
  'ntlm',
  'unknown',
];

/** 机制名称 / 简述 / 描述（中文报告存的是中文，英文界面实时翻译） */
export function localizeMechanism(mechanismId, locale = getLocale()) {
  if (!MECHANISM_IDS.includes(mechanismId)) return null;
  if (locale === 'zh') return null; // 报告里已有中文
  return {
    name: t(`mech.${mechanismId}.name`, {}, locale),
    short: t(`mech.${mechanismId}.short`, {}, locale),
    description: t(`mech.${mechanismId}.desc`, {}, locale),
  };
}

/** 机制名称（英文界面用；中文界面报告里已经有中文） */
export function localizeMechanismName(mechanismId, locale = getLocale()) {
  const localized = localizeMechanism(mechanismId, locale);
  return localized ? localized.name : null;
}

/** 凭证标签（如「会话 Cookie（2 个）」） */
export function localizeCredentialLabel(kind, count, locale = getLocale()) {
  if (locale === 'zh') return null;
  if (kind === 'cookie') {
    return count > 0
      ? t('cred.cookieCount', { count }, locale)
      : t('cred.cookie', {}, locale);
  }
  const key = `cred.kind.${kind}`;
  return has(key, locale) ? t(key, {}, locale) : null;
}

/** 判断依据 / 提示：报告里以中文存储，英文界面用 id + params 重新渲染 */
export function localizeEvidence(entry, locale = getLocale()) {
  if (!entry || locale === 'zh') return entry;
  const titleKey = `ev.${entry.id}.title`;
  const detailKey = `ev.${entry.id}.detail`;
  if (!has(titleKey, locale) && !has(detailKey, locale)) return entry;
  return {
    ...entry,
    title: has(titleKey, locale) ? t(titleKey, entry.params, locale) : entry.title,
    detail: has(detailKey, locale) ? t(detailKey, entry.params, locale) : entry.detail,
  };
}

/** 请求头备注（会话 Cookie / CSRF 防护头 / 应用上下文头…） */
export function localizeHeaderNote(noteKey, fallback, locale = getLocale()) {
  if (!noteKey) return fallback;
  const key = `note.${noteKey}`;
  return has(key, locale) ? t(key, {}, locale) : fallback;
}

/** 凭证来源（浏览器 Cookie / 请求头 / 登录响应体…） */
export function localizeSourceLabel(sourceKey, fallback, locale = getLocale()) {
  if (!sourceKey) return fallback;
  const key = `source.${sourceKey}`;
  return has(key, locale) ? t(key, {}, locale) : fallback;
}

export function localizeWarning(entry, locale = getLocale()) {
  if (!entry || locale === 'zh') return entry;
  const key = `warn.${entry.id}.text`;
  return has(key, locale) ? { ...entry, text: t(key, entry.params, locale) } : entry;
}

/** 过期时间等描述文案 */
export function localizeExpires(value, locale = getLocale()) {
  if (!value || locale === 'zh') return value;
  const key = `exp.${value.key}`;
  return has(key, locale) ? t(key, value.params || {}, locale) : value.text || '';
}
