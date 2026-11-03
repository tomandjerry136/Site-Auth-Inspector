/**
 * 把分析结果格式化成两种可复制的文本：
 *   1) copies.raw    —— 纯认证值（直接贴进请求头 / Cookie / curl）
 *   2) copies.prompt —— 带 Prompt 的认证方式（把认证上下文交给 LLM 或其他工具）
 * 同时给出 copies.headers（推荐请求头），供界面单独复制。
 */

import { isPlausibleExp } from './analyzer.js';
import { getLocale, localizeEvidence, localizeMechanismName, localizeWarning, t } from './i18n.js';
import { DEFAULT_SETTINGS, defaultPromptTemplate, kindLabel } from './settings.js';

/** ISO 时间 → 本地可读时间 */
export function formatTime(iso, locale = getLocale()) {
  if (!iso) return t('exp.unknown', {}, locale);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/** ISO 时间 → 相对时间（用于“上次分析”） */
export function formatRelative(iso) {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  const locale = getLocale();
  if (diff < 60_000) return t('rel.justNow', {}, locale);
  if (diff < 3_600_000) return t('rel.minutesAgo', { count: Math.floor(diff / 60_000) }, locale);
  if (diff < 86_400_000) return t('rel.hoursAgo', { count: Math.floor(diff / 3_600_000) }, locale);
  if (diff < 7 * 86_400_000) return t('rel.daysAgo', { count: Math.floor(diff / 86_400_000) }, locale);
  return formatTime(iso, locale);
}

const PLACEHOLDER_VALUE = /^(undefined|null|nil|none|nan)$/i;

/** 过滤掉空值 / 占位值的凭证（例如 SDK 发出的 "Bearer undefined"） */
export function isUsableCredential(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  const bare = text.replace(/^(bearer|basic)\s+/i, '').trim();
  if (PLACEHOLDER_VALUE.test(bare)) return false;
  if (bare.length < 6) return false;
  return true;
}

export function headersToText(headers) {
  return (Array.isArray(headers) ? headers : [])
    .filter((header) => header && header.name && isUsableCredential(header.value))
    .map((h) => `${h.name}: ${h.value}`)
    .join('\n');
}

/** 凭证过期时间描述 */
export function expiresText(result, locale = getLocale()) {
  const auth = result?.auth || {};
  if (auth.kind === 'cookie') {
    if (auth.expiresAt) {
      const sessionItems = (auth.items || []).filter((item) => item.session);
      const base = formatTime(auth.expiresAt, locale);
      return sessionItems.length > 0 ? t('exp.partialSession', { time: base }, locale) : base;
    }
    return t('exp.sessionCookie', {}, locale);
  }
  if (isPlausibleExp(auth.token?.claims?.exp)) {
    return formatTime(new Date(auth.token.claims.exp * 1000).toISOString(), locale);
  }
  if (auth.kind === 'bearer' || auth.kind === 'custom-header') return t('exp.tokenNone', {}, locale);
  if (auth.kind === 'api-key') return t('exp.apiKey', {}, locale);
  if (auth.kind === 'basic') return t('exp.basic', {}, locale);
  return t('exp.unknown', {}, locale);
}

function evidenceBlock(result, includeEvidence, locale) {
  if (!includeEvidence) return '';
  const list = (Array.isArray(result?.evidence) ? result.evidence : []).map((item) =>
    localizeEvidence(item, locale),
  );
  if (list.length === 0) return '';
  const lines = list.slice(0, 12).map((item, index) => {
    const detail = item.detail ? t('prompt.evidenceDetail', { detail: item.detail }, locale) : '';
    return `${index + 1}. ${item.title}${detail}`;
  });
  return [t('prompt.evidenceHeader', {}, locale), ...lines, ''].join('\n');
}

function warningsBlock(result, includeWarnings, locale) {
  if (!includeWarnings) return '';
  const list = (Array.isArray(result?.warnings) ? result.warnings : []).map((item) =>
    localizeWarning(item, locale),
  );
  if (list.length === 0) return '';
  return [
    t('prompt.warningsHeader', {}, locale),
    ...list.map((item) => `- [${t(`level.${item.level}`, {}, locale)}] ${item.text}`),
    '',
  ].join('\n');
}

export function buildPromptVars(result, settings, locale = getLocale()) {
  const auth = result?.auth || {};
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const mechanism = auth.mechanismId
    ? localizeMechanismName(auth.mechanismId, locale) || auth.mechanism
    : auth.mechanism;
  let host = result?.host || '';
  if (!host && result?.origin) {
    try {
      host = new URL(result.origin).host;
    } catch {
      host = result.origin;
    }
  }
  const headers = headersToText(result?.headers);
  return {
    origin: result?.origin || '',
    host,
    url: result?.url || '',
    title: result?.title || '',
    mechanism: mechanism || t('mech.unknown.short', {}, locale),
    mechanism_short: auth.mechanismShort || t('mech.unknown.short', {}, locale),
    confidence: String(auth.confidence ?? 0),
    credential_kind: kindLabel(auth.kind, locale),
    headers: headers || t('prompt.noHeaders', {}, locale),
    query_block: queryBlock(result, locale),
    raw: auth.raw || t('prompt.noRaw', {}, locale),
    expires: expiresText(result, locale),
    analyzed_at: formatTime(result?.analyzedAt, locale),
    evidence_block: evidenceBlock(result, merged.includeEvidence, locale),
    warnings_block: warningsBlock(result, merged.includeWarnings, locale),
  };
}

/** 简单 {{key}} 替换，未知占位符保留原样，便于用户排查模板。 */
export function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
    return match;
  });
}

export function buildPrompt(result, settings, locale = getLocale()) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // 只有“没自定义过”的模板才跟随界面语言；用户改过的模板原样保留
  const custom = merged.promptTemplate && merged.promptTemplate !== DEFAULT_SETTINGS.promptTemplate;
  const template = custom ? merged.promptTemplate : defaultPromptTemplate(locale);
  return renderTemplate(template, buildPromptVars(result, merged, locale))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** URL 参数（GET 认证）单独成段，方便直接拼到请求 URL 上 */
function queryBlock(result, locale = getLocale()) {
  const query = (Array.isArray(result?.queryOptions) ? result.queryOptions : []).filter(
    (item) => item && item.name && item.value,
  );
  if (query.length === 0) return '';
  return [t('prompt.queryHeader', {}, locale), ...query.map((item) => `- ${item.name}=${item.value}`), ''].join('\n');
}

/** 给分析结果补充 copies 字段（后台与测试共用）。 */
export function attachCopies(result, settings, locale = getLocale()) {
  const headers = headersToText(result?.headers);
  return {
    ...result,
    copies: {
      raw: result?.auth?.raw || '',
      prompt: buildPrompt({ ...result, headers: result?.headers || [] }, settings, locale),
      headers,
    },
  };
}
