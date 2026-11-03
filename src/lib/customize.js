/**
 * 高级自定义：用户从报告里挑选「请求头 / Cookie / URL 参数」，可编辑值、加自定义项，
 * 再生成三份可复制文本（纯内容 / 用法说明 / 请求头）。
 *
 * 纯函数，扩展页面与 Node 测试共用；report 保持原样，用户选择单独存在 report.custom 里。
 */

import { attachCopies, headersToText } from './format.js';
import { getLocale, localizeHeaderNote, t } from './i18n.js';

export const SELECTION_LIMIT = 60;
const VALUE_LIMIT = 8192;

/** 来源标签（随界面语言变化） */
export function sourceLabels(locale = getLocale()) {
  return {
    header: t('customize.source.header', {}, locale),
    cookie: t('customize.source.cookie', {}, locale),
    query: t('customize.source.query', {}, locale),
  };
}

export const SOURCE_LABELS = sourceLabels('zh');

function normalizeName(value) {
  return String(value ?? '').trim().slice(0, 256);
}

function normalizeValue(value) {
  return String(value ?? '').slice(0, VALUE_LIMIT);
}

/** 从报告整理出候选项；默认勾选「扩展推荐」的那些 */
export function buildCandidates(report) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.source}:${normalizeName(item.name).toLowerCase()}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({
      id: key,
      source: item.source,
      name: normalizeName(item.name),
      value: normalizeValue(item.value),
      note: String(item.note || '').slice(0, 120),
      enabled: Boolean(item.enabled),
    });
  };

  // 推荐的请求头（Cookie 拆成独立的 Cookie 项，便于精确勾选）
  for (const header of report?.headers || []) {
    if (/^cookie$/i.test(header.name)) continue;
    push({
      source: 'header',
      name: header.name,
      value: header.value,
      note: header.note || '',
      noteKey: header.noteKey || '',
      enabled: true,
    });
  }

  // 推荐 Cookie 集合
  const recommendedCookies = new Set(
    (report?.headers || [])
      .filter((header) => /^cookie$/i.test(header.name))
      .flatMap((header) =>
        String(header.value || '')
          .split(';')
          .map((part) => part.split('=')[0].trim())
          .filter(Boolean),
      ),
  );

  for (const cookie of Array.isArray(report?.cookieOptions) ? report.cookieOptions : []) {
    push({
      source: 'cookie',
      name: cookie.name,
      value: cookie.value,
      note: cookie.httpOnly ? 'HttpOnly' : '',
      noteKey: cookie.httpOnly ? 'httpOnly' : '',
      enabled: recommendedCookies.has(cookie.name),
    });
  }
  for (const name of recommendedCookies) {
    if (!items.some((item) => item.source === 'cookie' && item.name === name)) {
      push({
        source: 'cookie',
        name,
        value: '',
        note: '来自推荐请求头',
        noteKey: 'fromHeader',
        enabled: true,
      });
    }
  }

  // URL 里出现的 Token（GET 认证）
  for (const query of Array.isArray(report?.queryOptions) ? report.queryOptions : []) {
    push({
      source: 'query',
      name: query.name,
      value: query.value,
      note: '出现在 URL 里',
      noteKey: 'fromQuery',
      enabled: Boolean(query.selected),
    });
  }

  return items;
}

/** 用户选择 → 清洗后的选择（去掉空项、限制数量、统一字段） */
export function normalizeSelection(report, selection) {
  if (!Array.isArray(selection)) return buildCandidates(report);
  const items = [];
  const seen = new Set();
  for (const raw of selection.slice(0, SELECTION_LIMIT)) {
    if (!raw || typeof raw !== 'object') continue;
    const source = raw.source === 'cookie' || raw.source === 'query' ? raw.source : 'header';
    const name = normalizeName(raw.name);
    const value = normalizeValue(raw.value);
    if (!name) continue;
    const id = `${source}:${name.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      source,
      name,
      value,
      note: String(raw.note || '').slice(0, 120),
      noteKey: String(raw.noteKey || '').slice(0, 60),
      enabled: raw.enabled !== false,
    });
  }
  return items;
}

/** 用选择重新组装 headers / auth / queryOptions，供现有格式化逻辑复用 */
export function buildCustomReport(report, selection) {
  const items = normalizeSelection(report, selection).filter(
    (item) => item.enabled && item.name && String(item.value || '').trim(),
  );

  const headerItems = items.filter((item) => item.source === 'header');
  const cookieItems = items.filter((item) => item.source === 'cookie');
  const queryItems = items.filter((item) => item.source === 'query');

  const headers = headerItems.map((item) => ({
    name: item.name,
    value: item.value,
    note: item.note || '',
  }));

  if (cookieItems.length > 0) {
    const cookieValue = cookieItems.map((item) => `${item.name}=${item.value}`).join('; ');
    const existing = headers.find((header) => /^cookie$/i.test(header.name));
    if (existing) existing.value = `${existing.value}; ${cookieValue}`;
    else headers.push({ name: 'Cookie', value: cookieValue, note: '会话 Cookie' });
  }

  // 主凭证：只认真正的认证头（Authorization / X-*-Token / X-API-Key…），
  // CSRF、租户、时区这类上下文头不能当作凭证。
  const isCredentialHeader = (name) => {
    const lower = String(name).toLowerCase();
    if (/csrf|xsrf|tenant|app-id|channel|region|timezone|requested-with|trace/.test(lower)) return false;
    return (
      /^authorization$/.test(lower) ||
      /(^|[-_])(token|key|auth|session|jwt|secret)([-_]|$)/.test(lower) ||
      /^x-.*(token|key)$/.test(lower)
    );
  };
  const primaryHeader =
    headerItems.find((item) => isCredentialHeader(item.name)) ||
    (cookieItems.length === 0 ? headerItems[0] : null);

  const auth = { ...(report?.auth || {}), items: [], token: null, expiresAt: null };
  if (primaryHeader) {
    const bearer = /^bearer\s+/i.exec(primaryHeader.value);
    const basic = /^basic\s+/i.exec(primaryHeader.value);
    auth.kind = bearer ? 'bearer' : basic ? 'basic' : /^authorization$/i.test(primaryHeader.name) ? 'custom-header' : 'api-key';
    auth.label = t('customize.labelCustom', { name: primaryHeader.name });
    auth.headerName = primaryHeader.name;
    const locale = getLocale();
    auth.mechanism = bearer
      ? t('mech.bearer-token.name', {}, locale)
      : basic
        ? t('mech.basic-auth.name', {}, locale)
        : t('customize.mechanismHeader', { name: primaryHeader.name }, locale);
    auth.mechanismShort = bearer
      ? t('mech.bearer-token.short', {}, locale)
      : basic
        ? t('mech.basic-auth.short', {}, locale)
        : primaryHeader.name;
    auth.raw = bearer
      ? primaryHeader.value.replace(/^bearer\s+/i, '').trim()
      : basic
        ? primaryHeader.value.replace(/^basic\s+/i, '').trim()
        : primaryHeader.value;
  } else if (cookieItems.length > 0) {
    auth.kind = 'cookie';
    const locale = getLocale();
    auth.label = t('cred.cookieCount', { count: cookieItems.length }, locale);
    auth.mechanism = t('mech.session-cookie.name', {}, locale);
    auth.mechanismShort = t('mech.session-cookie.short', {}, locale);
    auth.raw = cookieItems.map((item) => `${item.name}=${item.value}`).join('; ');
    auth.items = cookieItems.map((item) => ({ name: item.name, value: item.value }));
    auth.headerName = 'Cookie';
  } else if (queryItems.length > 0) {
    auth.kind = 'none';
    const locale = getLocale();
    auth.label = t('customize.labelQuery', {}, locale);
    auth.mechanism = t('customize.mechanismQuery', {}, locale);
    auth.mechanismShort = t('customize.mechanismQueryShort', {}, locale);
    auth.raw = '';
  } else {
    auth.kind = 'none';
    const locale = getLocale();
    auth.label = t('mech.unknown.short', {}, locale);
    auth.mechanism = t('mech.unknown.name', {}, locale);
    auth.mechanismShort = t('mech.unknown.short', {}, locale);
    auth.raw = '';
  }

  const queryOptions = queryItems.map((item) => ({ name: item.name, value: item.value, selected: true }));

  return {
    ...report,
    auth,
    headers,
    queryOptions,
    // 自定义结果不再沿用原始判断依据，避免与所选内容相互矛盾
    evidence: [
      {
        id: 'custom-selection',
        level: 'info',
        title: t('ev.custom-selection.title'),
        detail: t('ev.custom-selection.detail', {
          headers: headerItems.length,
          cookies: cookieItems.length,
          query: queryItems.length,
        }),
        at: new Date().toISOString(),
      },
    ],
    warnings: [],
    custom: true,
  };
}

/** 生成三份文本 + 概览 */
export function buildCustomCopies(report, selection, settings) {
  const custom = buildCustomReport(report, selection);
  const withCopies = attachCopies(custom, settings);

  const enabled = normalizeSelection(report, selection).filter((item) => item.enabled);
  const queryItems = enabled.filter((item) => item.source === 'query' && String(item.value || '').trim());

  const rawParts = [];
  if (withCopies.auth?.raw) rawParts.push(withCopies.auth.raw);
  if (queryItems.length > 0) {
    rawParts.push(queryItems.map((item) => `${item.name}=${item.value}`).join('&'));
  }

  return {
    report: custom,
    raw: rawParts.join('\n'),
    headers: headersToText(custom.headers),
    prompt: withCopies.copies.prompt,
    summary: {
      headers: custom.headers.filter((header) => !/^cookie$/i.test(header.name)).length,
      cookies: enabled.filter((item) => item.source === 'cookie').length,
      query: queryItems.length,
      total: enabled.length,
    },
  };
}

/** 从已保存的报告里恢复上次的自定义选择 */
export function getSavedSelection(report) {
  const saved = report?.custom?.selection;
  if (Array.isArray(saved) && saved.length > 0) return normalizeSelection(report, saved);
  return buildCandidates(report);
}

/** 生成给 popup / 报告页展示的数据（有自定义时用自定义结果） */
export function resolveView(report, settings) {
  const selection = getSavedSelection(report);
  const copies = buildCustomCopies(report, selection, settings);
  return {
    selection,
    copies,
    headers: copies.report.headers,
    auth: copies.report.auth,
    summary: copies.summary,
  };
}