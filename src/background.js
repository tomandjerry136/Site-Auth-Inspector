/**
 * 后台 Service Worker：
 *  - 管理「按站点启用」的权限与动态注入脚本
 *  - 响应 popup 的启用 / 停用 / 分析请求
 *  - 采集 Cookie，调用分析引擎，保存结果（凭证只进 session storage）
 */

import { analyze } from './lib/analyzer.js';
import { attachCopies } from './lib/format.js';
import {
  applyLanguageSetting,
  getLocale,
  has,
  localizeCredentialLabel,
  localizeEvidence,
  localizeMechanism,
  localizeWarning,
  t,
} from './lib/i18n.js';
import {
  buildCandidates,
  buildCustomCopies,
  getSavedSelection,
  normalizeSelection,
} from './lib/customize.js';
import {
  getSettings,
  getSites,
  getSite,
  upsertSite,
  removeSite,
  getReport,
  setReport,
  clearReport,
  getReportMeta,
  setReportMeta,
  clearReportMeta,
  getFlow,
  setFlow,
  clearFlow,
} from './lib/state.js';

const HOOK_PATH = 'src/injected/hook.js';
const COLLECTOR_PATH = 'src/injected/collector.js';
/**
 * 工具栏状态提示：
 *  - 已启用 / 已分析 → 换成右下角带绿点的图标，不再用 "ON" 文字角标压住小图标；
 *  - 需要用户注意（例如没有权限）→ 仍然用一个小 "!" 角标，避免用户漏看。
 */
const ICON_ON = {
  16: 'icons/icon16-on.png',
  32: 'icons/icon32-on.png',
  48: 'icons/icon48-on.png',
  128: 'icons/icon128-on.png',
};
const ICON_OFF = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};
const BADGE_COLOR = '#4f46e5';
const ACTIVE_BADGE_COLOR = '#10b981';
/** 「记录登录过程」的有效期：过期后不再显示页面内悬浮框，避免长期打扰 */
const FLOW_TTL_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  // 首次安装时把默认设置写入本地存储，便于设置页展示与修改
  getSettings()
    .then((settings) => chrome.storage.local.set({ settings }))
    .catch(() => {})
    .finally(() => syncAllSites());
});

chrome.runtime.onStartup.addListener(() => {
  syncAllSites();
});

chrome.permissions.onRemoved.addListener((removed) => {
  handlePermissionsRemoved(removed).catch(() => {});
});

chrome.permissions.onAdded.addListener(() => {
  syncAllSites();
});

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => {
      console.error('[auth-inspector]', error);
      sendResponse({ ok: false, code: 'INTERNAL', error: error?.message || String(error) });
    });
  return true;
});

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') return { ok: false, code: 'BAD_MESSAGE' };
  await ensureLocale();

  switch (message.type) {
    case 'CA_PAGE_READY': {
      // 内容脚本在页面加载时通知，用于点亮扩展图标角标
      const site = await getSite(message.host);
      if (site && sender.tab?.id != null) {
        const granted = await filterGranted(site.patterns || []);
        if (granted.length > 0) await setBadge(sender.tab.id, '', { active: true });
      }
      return { ok: true };
    }
    case 'CA_GET_STATE':
      return buildState(message.host, message.origin, message.tabId);
    case 'CA_ENABLE_SITE':
      return enableSite(message);
    case 'CA_DISABLE_SITE':
      return disableSite(message.host, message.origin);
    case 'CA_ANALYZE':
      return runAnalysis(message, sender);
    case 'CA_ARM':
      return armFlow(message);
    case 'CA_DISARM':
      return disarmFlow(message);
    case 'CA_ENSURE_OVERLAY':
      return ensureOverlay(message);
    case 'CA_OPEN_REPORT':
      return openReport(message);
    case 'CA_GET_CUSTOMIZE':
      return getCustomize(message);
    case 'CA_SAVE_CUSTOMIZE':
      return saveCustomize(message);
    case 'CA_OPEN_CUSTOMIZE':
      return openCustomize(message);
    case 'CA_OVERLAY_STRINGS':
      return getOverlayStrings();
    case 'CA_GET_SITES':
      return { ok: true, sites: await getSites() };
    default:
      return { ok: false, code: 'UNKNOWN_MESSAGE', error: t('err.unknownMessage', { type: message.type }) };
  }
}

// ---------------------------------------------------------------------------
// 启用 / 停用
// ---------------------------------------------------------------------------

async function enableSite(message) {
  const host = message.host;
  if (!host) return { ok: false, code: 'BAD_HOST', error: t('err.badHost') };

  const patterns =
    Array.isArray(message.patterns) && message.patterns.length > 0
      ? message.patterns.filter((p) => typeof p === 'string')
      : defaultPatterns(host);
  const granted = await filterGranted(patterns);
  if (granted.length === 0) {
    return {
      ok: false,
      code: 'NO_PERMISSION',
      error: t('err.permissionDenied'),
    };
  }

  const origin = typeof message.origin === 'string' && message.origin ? message.origin : `https://${host}`;
  const site = await upsertSite(host, {
    host,
    origin,
    patterns: granted,
    granted: true,
    enabledAt: new Date().toISOString(),
  });

  await registerHost(host, granted);
  await setFlow(host, { armed: true, armedAt: new Date().toISOString() });
  if (message.tabId != null) {
    await setBadge(message.tabId, '', { active: true });
    // 立即注入到当前页面：不用刷新也能开始记录并显示悬浮框
    await injectCollectors(message.tabId);
  }

  const state = await buildState(host, origin);
  return { ...state, site };
}

async function disableSite(host, origin) {
  const site = await getSite(host);
  await unregisterHost(host);
  if (site?.patterns?.length) {
    try {
      await chrome.permissions.remove({ origins: site.patterns });
    } catch {
      /* 权限可能已被用户移除 */
    }
  }
  await removeSite(host);
  await clearReport(host);
  await clearReportMeta(host);
  await clearFlow(host);
  await clearAllBadges();
  const state = await buildState(host, origin || '');
  return { ...state, ok: true };
}

// ---------------------------------------------------------------------------
// 分析
// ---------------------------------------------------------------------------

function localizeReportForDisplay(report, locale) {
  const auth = report.auth || {};
  const mechanism = localizeMechanism(auth.mechanismId, locale);
  const label = localizeCredentialLabel(auth.kind, (auth.items || []).length, locale);
  return {
    ...report,
    auth: {
      ...auth,
      mechanism: mechanism?.name || auth.mechanism,
      mechanismShort: mechanism?.short || auth.mechanismShort,
      description: mechanism?.description || auth.description,
      label: label || auth.label,
    },
    evidence: (report.evidence || []).map((item) => localizeEvidence(item, locale)),
    warnings: (report.warnings || []).map((item) => localizeWarning(item, locale)),
  };
}

async function runAnalysis(message, sender) {
  const { host } = message;
  const tabId = message.tabId ?? sender?.tab?.id;
  const site = await getSite(host);
  if (!site) return { ok: false, code: 'NOT_ENABLED', error: t('err.notEnabled') };

  const granted = await filterGranted(site.patterns || []);
  if (granted.length === 0) {
    return { ok: false, code: 'NO_PERMISSION', error: t('err.noPermission') };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, code: 'NO_TAB', error: t('err.noTab') };
  }
  if (tab.status === 'loading') {
    return { ok: false, code: 'PAGE_LOADING', error: t('err.pageLoading') };
  }

  const tabUrl = tab.url || '';
  let parsed;
  try {
    parsed = new URL(tabUrl);
  } catch {
    return { ok: false, code: 'BAD_URL', error: t('err.badUrl') };
  }
  if (parsed.host !== host) {
    return { ok: false, code: 'TAB_CHANGED', error: t('err.tabChanged') };
  }

  const collected = await requestCollection(tabId);
  const cookies = mergeDocumentCookies(await readCookies(host), collected?.documentCookies, parsed);

  const report = analyze({
    page: {
      url: tabUrl,
      origin: parsed.origin,
      host,
      title: tab.title || '',
      referrer: collected?.page?.referrer || '',
      path: parsed.pathname,
      loginPageLikely: Boolean(collected?.page?.loginPageLikely),
    },
    cookies,
    storage: collected?.storage,
    requests: collected?.requests,
    hints: collected?.hints,
  });

  const settings = await getSettings();
  const full = attachCopies(report, settings);
  await setReport(host, full);

  const meta = {
    analyzedAt: full.analyzedAt,
    mechanism: full.auth.mechanism,
    mechanismId: full.auth.mechanismId,
    mechanismShort: full.auth.mechanismShort,
    confidence: full.auth.confidence,
    kind: full.auth.kind,
    host,
    origin: full.origin,
  };
  await setReportMeta(host, meta);
  await upsertSite(host, { lastAnalyzedAt: full.analyzedAt });

  if (tabId != null) await setBadge(tabId, '', { active: true });

  // 识别到凭证 → 本次记录结束（页面右下角的悬浮框随之隐藏）；
  // 没识别到 → 自动回到记录状态，方便用户继续登录后再试（悬浮框保持显示，而不是闪一下）
  const recognized = Boolean(full.auth && full.auth.kind !== 'none');
  if (recognized) {
    await setFlow(host, { armed: false, finishedAt: new Date().toISOString() });
  } else if (!(await isArmed(host))) {
    await setFlow(host, { armed: true, armedAt: new Date().toISOString() });
  }

  const locale = getLocale();
  return {
    ok: true,
    // 存储里始终是中文原文；返回给页面的展示副本按当前语言本地化（悬浮框直接用它）
    report: locale === 'zh' ? full : localizeReportForDisplay(full, locale),
    meta,
    collected: Boolean(collected),
    armed: await isArmed(host),
  };
}

/**
 * 向页面要数据；如果页面是“启用之前”打开的，采集脚本还没注入，就即时补注入再试一次。
 */
async function requestCollection(tabId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'CA_COLLECT' }, { frameId: 0 });
      if (response?.ok) return response;
    } catch {
      /* 没有接收方，进入补注入 */
    }
    if (attempt === 0) await injectCollectors(tabId);
  }
  return null;
}

async function injectCollectors(tabId) {
  const target = { tabId, frameIds: [0] };
  try {
    await chrome.scripting.executeScript({
      target,
      files: [HOOK_PATH],
      world: 'MAIN',
      injectImmediately: true,
    });
  } catch {
    /* 页面可能禁止注入 */
  }
  try {
    await chrome.scripting.executeScript({ target, files: [COLLECTOR_PATH] });
  } catch {
    /* 忽略 */
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/**
 * chrome.cookies 读不到父域名（.example.com）或没授权的 Cookie；document.cookie 能补上非 HttpOnly 的部分。
 * 同名时以 chrome.cookies 为准（它有 HttpOnly / 过期时间等完整信息）。
 */
function mergeDocumentCookies(fromChrome, fromDocument, url) {
  const merged = Array.isArray(fromChrome) ? [...fromChrome] : [];
  const seen = new Set(merged.map((cookie) => cookie.name));
  const list = Array.isArray(fromDocument) ? fromDocument : [];
  for (const item of list) {
    if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') continue;
    if (!item.name || seen.has(item.name)) continue;
    seen.add(item.name);
    merged.push({
      name: item.name,
      value: item.value,
      domain: url ? url.hostname : '',
      path: '/',
      httpOnly: false,
      secure: Boolean(url && url.protocol === 'https:'),
      session: true,
      sameSite: 'unspecified',
    });
    if (merged.length >= 120) break;
  }
  return merged;
}

async function readCookies(host) {
  const seen = new Map();
  // chrome.cookies 的 domain 参数不接受端口（localhost:3000 要写成 localhost）
  const hostname = host.replace(/:\d+$/, '');
  const queries = [{ domain: hostname }, { url: `https://${host}/` }, { url: `http://${host}/` }];
  for (const query of queries) {
    try {
      const list = await chrome.cookies.getAll(query);
      for (const cookie of list) {
        seen.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie);
      }
    } catch {
      /* 权限不足时跳过该查询 */
    }
  }
  return [...seen.values()];
}

async function armFlow(message) {
  const host = message.host;
  const site = await getSite(host);
  if (!site) return { ok: false, code: 'NOT_ENABLED', error: t('err.notEnabled') };
  const granted = await filterGranted(site.patterns || []);
  if (granted.length === 0) {
    return { ok: false, code: 'NO_PERMISSION', error: t('err.noPermission') };
  }
  await registerHost(host, granted);
  await setFlow(host, { armed: true, armedAt: new Date().toISOString() });
  const tabId = message.tabId ?? null;
  if (tabId != null) {
    await setBadge(tabId, '', { active: true });
    await injectCollectors(tabId);
  }
  return buildState(host, site.origin);
}

async function disarmFlow(message) {
  const host = message.host;
  if (!host) return { ok: false, code: 'BAD_HOST', error: t('err.badHost') };
  await setFlow(host, { armed: false, stoppedAt: new Date().toISOString() });
  return { ok: true };
}

async function openReport(message) {
  const host = message.host;
  if (!host) return { ok: false, code: 'BAD_HOST', error: t('err.badHost') };
  const url = `${chrome.runtime.getURL('src/popup.html')}?host=${encodeURIComponent(host)}`;
  await chrome.tabs.create({ url });
  return { ok: true };
}

let localeReady = null;

/** 语言设置可能被改过：按存储里的设置同步一次（有缓存） */
function ensureLocale() {
  if (!localeReady) {
    localeReady = getSettings()
      .then((settings) => applyLanguageSetting(settings.language))
      .catch(() => {});
  }
  return localeReady;
}

/** 设置变化后让缓存失效，下一条消息重新读取 */
function invalidateLocale() {
  localeReady = null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) invalidateLocale();
});

// 悬浮框需要的内容脚本不能 import 模块，由后台按当前语言下发（{name} → $1/$2）
const OVERLAY_STRINGS = [
  ['overlayRecording', 'overlay.recording'],
  ['overlayRecordingText', 'overlay.recordingText'],
  ['overlayRecordingCount', 'overlay.recordingCount'],
  ['overlayPill', 'overlay.pill'],
  ['overlayFinishPill', 'overlay.finishPill'],
  ['overlayFinish', 'overlay.finish'],
  ['overlayAnalyzing', 'overlay.analyzing'],
  ['overlayAnalyzingText', 'overlay.analyzingText'],
  ['overlayUnknownTitle', 'overlay.unknownTitle'],
  ['overlayUnknownText', 'overlay.unknownText'],
  ['overlayContinue', 'overlay.continue'],
  ['overlayDetails', 'overlay.details'],
  ['overlayDone', 'overlay.done'],
  ['overlayConfidence', 'overlay.confidence'],
  ['overlayEmptyCred', 'overlay.emptyCred'],
  ['overlayShowFull', 'overlay.showFull'],
  ['overlayHideFull', 'overlay.hideFull'],
  ['overlayCopyRaw', 'overlay.copyRaw'],
  ['overlayCopyPrompt', 'overlay.copyPrompt'],
  ['overlayRetry', 'overlay.retry'],
  ['overlayOpenReport', 'overlay.openReport'],
  ['overlayMulti', 'overlay.multi'],
  ['overlaySource', 'overlay.source'],
  ['overlayNoContent', 'overlay.noContent'],
  ['overlayCopyFailed', 'overlay.copyFailed'],
  ['overlayCopied', 'overlay.copied'],
  ['overlayPermissionRevoked', 'overlay.permissionRevoked'],
  ['overlayCollapse', 'overlay.collapse'],
  ['overlayExpand', 'overlay.expand'],
  ['overlayClose', 'overlay.close'],
  ['overlayStop', 'overlay.stopRecording'],
  ['overlayUnidentified', 'overlay.unidentified'],
];

async function getOverlayStrings() {
  // 悬浮框文案每次按最新设置解析，保证在设置页切换语言后立即生效
  const settings = await getSettings();
  applyLanguageSetting(settings.language);
  const locale = getLocale();
  const strings = {};
  for (const [messageKey, dictKey] of OVERLAY_STRINGS) {
    const text = has(dictKey, locale) ? t(dictKey, {}, locale) : '';
    let index = 0;
    strings[messageKey] = text.replace(/\{(\w+)\}/g, () => {
      index += 1;
      return `$${index}`;
    });
  }
  return { ok: true, locale, strings };
}

async function openCustomize(message) {
  const host = message.host;
  if (!host) return { ok: false, code: 'BAD_HOST', error: t('err.badHost') };
  const url = `${chrome.runtime.getURL('src/customize.html')}?host=${encodeURIComponent(host)}`;
  await chrome.tabs.create({ url });
  return { ok: true };
}

/** 打开自定义页时用：原始报告 + 候选项 + 已保存的选择 */
async function getCustomize(message) {
  const host = message.host;
  const report = await getReport(host);
  if (!report) return { ok: false, code: 'NO_REPORT', error: t('err.noReport') };
  return {
    ok: true,
    host,
    report,
    candidates: buildCandidates(report),
    selection: getSavedSelection(report),
  };
}

/** 保存自定义选择：结果写回会话报告，popup / 报告页立刻用新内容 */
async function saveCustomize(message) {
  const host = message.host;
  const report = await getReport(host);
  if (!report) return { ok: false, code: 'NO_REPORT', error: t('err.noReport') };

  const settings = await getSettings();
  const selection = normalizeSelection(report, message.selection);
  const copies = buildCustomCopies(report, selection, settings);

  const next = {
    ...report,
    custom: {
      selection,
      copies: { raw: copies.raw, prompt: copies.prompt, headers: copies.headers },
      headers: copies.report.headers,
      auth: {
        kind: copies.report.auth.kind,
        label: copies.report.auth.label,
        raw: copies.report.auth.raw,
        sourceLabel: t('source.custom'),
        sourceLabelKey: 'custom',
      },
      summary: copies.summary,
      savedAt: new Date().toISOString(),
    },
  };
  await setReport(host, next);
  return { ok: true, report: next, selection, summary: copies.summary };
}

function isArmedEntry(entry) {
  if (!entry || !entry.armed) return false;
  const age = Date.now() - Date.parse(entry.armedAt || 0);
  return Number.isFinite(age) ? age < FLOW_TTL_MS : true;
}

async function isArmed(host) {
  return isArmedEntry(await getFlow(host));
}

/**
 * 确保当前页面能显示悬浮框：
 * 旧页面（扩展更新前就打开的）没有采集脚本时，这里补注入一次。
 */
async function ensureOverlay(message) {
  const host = message.host;
  const tabId = message.tabId;
  const site = await getSite(host);
  if (!site) return { ok: false, code: 'NOT_ENABLED' };
  const granted = await filterGranted(site.patterns || []);
  if (granted.length === 0) return { ok: false, code: 'NO_PERMISSION' };

  const armed = await isArmed(host);
  let reachable = false;
  if (tabId != null) {
    reachable = await pingTab(tabId);
    if (!reachable) {
      // 页面可能是扩展更新前打开的：补注入一次（armed 时才会真正显示悬浮框）
      await injectCollectors(tabId);
      reachable = await pingTab(tabId);
    }
  }
  return { ok: true, reachable, armed };
}

async function pingTab(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'CA_PING' }, { frameId: 0 });
    return Boolean(pong && pong.ok && pong.overlay);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 状态 / 权限 / 脚本注册
// ---------------------------------------------------------------------------

async function buildState(host, origin, tabId) {
  const site = await getSite(host);
  const candidatePatterns = site?.patterns?.length ? site.patterns : defaultPatterns(host);
  const grantedPatterns = await filterGranted(candidatePatterns);
  const report = await getReport(host);
  const meta = await getReportMeta(host);
  const settings = await getSettings();

  // 兼容旧版本：站点已启用、但还没有记录状态 → 自动进入记录（否则悬浮框不会出现）
  let flowEntry = await getFlow(host);
  if (!flowEntry && site && grantedPatterns.length > 0) {
    flowEntry = await setFlow(host, { armed: true, armedAt: new Date().toISOString() });
  }
  const armed = isArmedEntry(flowEntry);

  return {
    ok: true,
    host,
    origin: origin || site?.origin || '',
    site: site ? { ...site, patterns: grantedPatterns } : null,
    granted: grantedPatterns.length > 0,
    grantedPatterns,
    enabled: Boolean(site) && grantedPatterns.length > 0,
    report,
    meta,
    flow: { armed },
    settings: {
      maskByDefault: settings.maskByDefault,
      includeEvidence: settings.includeEvidence,
      language: settings.language,
    },
  };
}

async function filterGranted(patterns) {
  const granted = [];
  for (const pattern of patterns || []) {
    if (typeof pattern !== 'string') continue;
    try {
      if (await chrome.permissions.contains({ origins: [pattern] })) granted.push(pattern);
    } catch {
      /* 非法 pattern 直接跳过 */
    }
  }
  return [...new Set(granted)];
}

function defaultPatterns(host) {
  const hostname = host.replace(/:\d+$/, '');
  const patterns = [`https://${host}/*`, `http://${host}/*`];
  // 非默认端口时补充不带端口的 pattern：chrome.cookies 按域名授权
  if (hostname !== host) patterns.push(`https://${hostname}/*`, `http://${hostname}/*`);
  return [...new Set(patterns)];
}

function scriptIdsForHost(host) {
  const safe = String(host).replace(/[^a-zA-Z0-9_-]/g, '_');
  return { hookId: `ca_hook_${safe}`, collectorId: `ca_collector_${safe}` };
}

async function registerHost(host, patterns) {
  if (!patterns || patterns.length === 0) return;
  const { hookId, collectorId } = scriptIdsForHost(host);
  // 端口场景下 permissions 里会包含不带端口的 pattern（为了读 Cookie），
  // 但内容脚本只应注入当前精确 origin，避免影响到同域其他端口。
  const exact = patterns.filter(
    (pattern) => pattern === `http://${host}/*` || pattern === `https://${host}/*`,
  );
  const matches = exact.length > 0 ? exact : patterns;
  await unregisterHost(host);
  await chrome.scripting.registerContentScripts([
    {
      id: hookId,
      matches,
      js: [HOOK_PATH],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false,
      persistAcrossSessions: true,
    },
    {
      id: collectorId,
      matches,
      js: [COLLECTOR_PATH],
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
}

async function unregisterHost(host) {
  const { hookId, collectorId } = scriptIdsForHost(host);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [hookId, collectorId] });
    const ids = existing.map((script) => script.id);
    if (ids.length > 0) await chrome.scripting.unregisterContentScripts({ ids });
  } catch {
    /* 未注册过，忽略 */
  }
}

async function syncAllSites() {
  const sites = await getSites();
  for (const [host, site] of Object.entries(sites)) {
    const granted = await filterGranted(site.patterns?.length ? site.patterns : defaultPatterns(host));
    if (granted.length === 0) {
      await unregisterHost(host);
      await upsertSite(host, { patterns: [], granted: false });
      await clearReport(host);
      continue;
    }
    if (granted.length !== (site.patterns || []).length) {
      await upsertSite(host, { patterns: granted, granted: true });
    }
    try {
      await registerHost(host, granted);
    } catch (error) {
      console.warn('[auth-inspector] 注册内容脚本失败', host, error);
    }
  }

  // 清理没有对应站点的脚本
  const knownIds = new Set(Object.keys(sites).flatMap((host) => Object.values(scriptIdsForHost(host))));
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const orphans = scripts
      .filter((script) => (script.id.startsWith('ca_hook_') || script.id.startsWith('ca_collector_')) && !knownIds.has(script.id))
      .map((script) => script.id);
    if (orphans.length > 0) await chrome.scripting.unregisterContentScripts({ ids: orphans });
  } catch {
    /* 忽略 */
  }
}

async function handlePermissionsRemoved(removed) {
  if (!removed?.origins?.length) return;
  const sites = await getSites();
  for (const [host, site] of Object.entries(sites)) {
    const still = await filterGranted(site.patterns || []);
    if (still.length === 0) {
      await unregisterHost(host);
      await upsertSite(host, { patterns: [], granted: false });
      await clearReport(host);
      await clearReportMeta(host);
    } else if (still.length !== (site.patterns || []).length) {
      await upsertSite(host, { patterns: still });
    }
  }
  await clearAllBadges();
}

// ---------------------------------------------------------------------------
// 角标
// ---------------------------------------------------------------------------

/**
 * 设置工具栏图标 + 角标：
 *  - active=true → 右下角带绿点的图标（不再用 "ON" 文字压住图标）
 *  - text 非空 → 只用于必须提醒的短标记（如 "!"）
 */
const lastIcon = new Map();
const iconCache = new Map();

/**
 * 图标以 imageData 形式设置：部分环境（无头 Chrome、个别打包方式）
 * 会用 "Could not load action icon" 拒绝 path 形式，而 imageData 稳定可用。
 */
async function loadIconImageData(active) {
  const key = active ? 'on' : 'off';
  if (iconCache.has(key)) return iconCache.get(key);
  const paths = active ? ICON_ON : ICON_OFF;
  const imageData = {};
  await Promise.all(
    Object.entries(paths).map(async ([size, path]) => {
      const response = await fetch(chrome.runtime.getURL(path));
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      imageData[size] = context.getImageData(0, 0, bitmap.width, bitmap.height);
    }),
  );
  iconCache.set(key, imageData);
  return imageData;
}

/**
 * 设置工具栏状态：
 *  1) 图标切成绿色（已启用）/ 蓝色（未启用）盾牌；
 *  2) 万一图标切不过去，退回一个很小的绿色圆点角标（不再用 "ON" 文字盖住图标）。
 */
async function setBadge(tabId, text = '', options = {}) {
  const active = options.active ?? Boolean(text);
  let iconApplied = false;
  try {
    const imageData = await loadIconImageData(active);
    await chrome.action.setIcon({ tabId, imageData });
    iconApplied = true;
    lastIcon.set(tabId, { active, at: Date.now() });
  } catch (error) {
    console.warn('[auth-inspector] 设置工具栏图标失败，改用小角标', tabId, error?.message || error);
    try {
      // 再退回文件路径方式试一次
      await chrome.action.setIcon({ tabId, path: active ? ICON_ON : ICON_OFF });
      iconApplied = true;
      lastIcon.set(tabId, { active, at: Date.now() });
    } catch {
      /* 两种方式都不行时用角标兜底 */
    }
  }

  try {
    let badgeText = text || '';
    if (!badgeText && active && !iconApplied) badgeText = '●';
    const color = badgeText === '●' ? ACTIVE_BADGE_COLOR : BADGE_COLOR;
    if (badgeText) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text: badgeText });
  } catch {
    /* 标签页可能已关闭 */
  }

  // 悬停提示：录制中 / 已启用 都能从提示里看到
  try {
    const name = chrome.runtime.getManifest().name;
    if (active) {
      let host = '';
      try {
        host = new URL((await chrome.tabs.get(tabId))?.url || '').host;
      } catch {
        /* 标签页可能已关闭 */
      }
      const armed = host ? await isArmed(host) : false;
      const state = armed ? t('popup.recording') : t('popup.status.enabled');
      await chrome.action.setTitle({ tabId, title: `${state} · ${name}` });
    } else {
      await chrome.action.setTitle({ tabId, title: name });
    }
  } catch {
    /* 忽略 */
  }
}

/** 页面加载 / 切换标签页 / 扩展启动时都同步一次图标 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  syncTabIcon(tabId, tab).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => syncTabIcon(tabId, tab))
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.tabs
    .query({})
    .then((tabs) => Promise.all(tabs.map((tab) => syncTabIcon(tab.id, tab)).filter(Boolean)))
    .catch(() => {});
});

async function syncTabIcon(tabId, tab) {
  // 没有 host 权限时 Chrome 不提供 tab.url：说明当前页不在已启用站点上，回到普通图标
  if (!tab?.url) {
    await setBadge(tabId, '', { active: false });
    return;
  }
  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    await setBadge(tabId, '', { active: false });
    return;
  }
  const site = await getSite(parsed.host);
  if (!site) {
    await setBadge(tabId, '', { active: false });
    return;
  }
  const granted = await filterGranted(site.patterns || []);
  await setBadge(tabId, '', { active: granted.length > 0 });
}

async function clearAllBadges() {
  try {
    const tabs = await chrome.tabs.query({});
    // 逐个标签页按当前站点状态重置，避免停用 A 站时把 B 站的绿图标也清掉
    await Promise.all(tabs.map((tab) => (tab.id != null ? syncTabIcon(tab.id, tab) : null)));
  } catch {
    /* 忽略 */
  }
}