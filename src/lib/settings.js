/**
 * 默认设置与提示词模板。
 * 模板占位符统一使用 {{name}} 形式，可在扩展设置页里自定义。
 *
 * 文案本身按语言放在 locales/{zh,en}.js 里，这里只做按当前界面语言取值，
 * 保证「默认模板」也跟着浏览器语言走（用户自定义过的模板永远原样使用）。
 */

import { getLocale, has, t } from './i18n.js';

export function defaultPromptTemplate(locale = getLocale()) {
  // 中文报告里存的 prompt 一直是中文模板；只有英文界面才换成英文模板
  return has('prompt.default', locale) ? t('prompt.default', {}, locale) : t('prompt.default', {}, 'zh');
}

export const DEFAULT_PROMPT_TEMPLATE = defaultPromptTemplate('zh');

export const DEFAULT_SETTINGS = {
  // 'auto' = 跟随浏览器语言；'zh' / 'en' = 用户手动指定
  language: 'auto',
  // 空字符串表示「跟随界面语言使用内置模板」；用户改过才存具体文本
  promptTemplate: '',
  includeEvidence: true,
  includeWarnings: true,
  maskByDefault: true,
};

/** 占位符列表（label 随语言变化，key 不变） */
export function promptPlaceholders(locale = getLocale()) {
  return [
    { key: 'origin', sample: 'https://example.com' },
    { key: 'host', sample: 'example.com' },
    { key: 'url', sample: 'https://example.com/dashboard' },
    { key: 'title', sample: 'Dashboard' },
    { key: 'mechanism', sample: 'Cookie session' },
    { key: 'mechanism_short', sample: 'Cookie session' },
    { key: 'confidence', sample: '86' },
    { key: 'credential_kind', sample: 'Session cookie' },
    { key: 'headers', sample: 'Cookie: sid=...' },
    { key: 'query_block', sample: '## URL parameters' },
    { key: 'raw', sample: 'sid=...' },
    { key: 'expires', sample: '2026-01-01 12:00:00' },
    { key: 'analyzed_at', sample: '2025-06-01 09:30:00' },
    { key: 'evidence_block', sample: '## Evidence' },
    { key: 'warnings_block', sample: '## Caveats' },
  ].map((item) => ({
    ...item,
    label: has(`placeholder.${item.key}`, locale) ? t(`placeholder.${item.key}`, {}, locale) : item.key,
  }));
}

export const PROMPT_PLACEHOLDERS = promptPlaceholders('zh');

export function kindLabel(kind, locale = getLocale()) {
  const key = `cred.kind.${kind}`;
  return has(key, locale) ? t(key, {}, locale) : kind || '';
}

export const KIND_LABELS = {
  cookie: '会话 Cookie',
  bearer: 'Bearer Token',
  basic: 'HTTP Basic 凭证',
  'api-key': 'API Key',
  'custom-header': '自定义 Token 请求头',
  none: '未识别',
};
