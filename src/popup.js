/**
 * Popup 逻辑：站点状态 → 申请权限 → 引导登录/刷新 → 分析 → 复制两种文本。
 * 分析本身在后台完成，popup 只负责交互与展示。
 */

import { expiresText, formatRelative, formatTime } from './lib/format.js';
import { maskSecret } from './lib/mask.js';
import {
  applyI18n,
  applyLanguageSetting,
  getLocale,
  localizeCredentialLabel,
  localizeEvidence,
  localizeSourceLabel,
  localizeMechanism,
  localizeWarning,
  t,
} from './lib/i18n.js';

const PANEL_IDS = [
  'unsupported-panel',
  'enable-panel',
  'flow-panel',
  'loading-panel',
  'error-panel',
  'result-panel',
];

const app = {
  tab: null,
  host: '',
  origin: '',
  site: null,
  granted: false,
  grantedPatterns: [],
  enabled: false,
  report: null,
  meta: null,
  flow: { armed: false },
  settings: { maskByDefault: true },
  masked: true,
  busy: false,
  supported: true,
  reportOnly: false,
  overlayReady: null,
};

const $ = (id) => document.getElementById(id);

let toastTimer = null;

// ---------------------------------------------------------------------------
applyI18n();

// 启动
// ---------------------------------------------------------------------------
init();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    load().catch(() => {});
  }
});

async function init() {
  bindEvents();
  try {
    await bootstrap();
  } catch (error) {
    renderUnsupported(t('popup.loadFailed', { message: error?.message || error }));
  }
}

async function bootstrap() {
  const params = new URLSearchParams(location.search);
  const reportHost = params.get('host');
  if (reportHost) {
    app.reportOnly = true;
    app.host = reportHost;
    app.origin = `https://${reportHost}`;
    $('site-host').textContent = reportHost;
    $('site-origin').textContent = t('popup.reportOrigin');
    $('site-favicon').classList.add('hidden');
    $('site-status').dataset.state = 'granted';
    $('site-status').textContent = t('popup.report');
    await loadState();
    return;
  }

  const tab = await resolveTab();
  if (!tab) {
    renderUnsupported(t('popup.error.noTab'));
    return;
  }
  app.tab = tab;

  const rawUrl = tab.url || '';
  let parsed = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    renderUnsupported(t('popup.error.badUrl'));
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    renderUnsupported(t('popup.unsupportedScheme'));
    return;
  }
  if (isBlockedPage(parsed)) {
    renderUnsupported(t('popup.unsupportedWebStore'));
    return;
  }

  app.host = parsed.host;
  app.origin = parsed.origin;
  renderSiteHeader(parsed, tab);
  await loadState();
}

/** 调试用：打开 popup.html?tabId=123 可指定标签页（正常点击图标时不需要）。 */
async function resolveTab() {
  const params = new URLSearchParams(location.search);
  const debugTabId = Number(params.get('tabId'));
  if (Number.isInteger(debugTabId) && debugTabId > 0) {
    try {
      return await chrome.tabs.get(debugTabId);
    } catch {
      /* 回退到当前活动标签页 */
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isBlockedPage(parsed) {
  if (parsed.host === 'chromewebstore.google.com') return true;
  if (parsed.host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return true;
  return false;
}

function renderSiteHeader(parsed, tab) {
  $('site-host').textContent = parsed.host;
  $('site-host').title = parsed.host;
  $('site-origin').textContent = parsed.origin;
  $('site-origin').title = parsed.origin;
  if (tab.favIconUrl && /^(https?:|data:)/.test(tab.favIconUrl)) {
    $('site-favicon').src = tab.favIconUrl;
  }
}

function renderUnsupported(message) {
  app.supported = false;
  hideAllPanels();
  $('unsupported-text').textContent = message;
  $('site-status').dataset.state = 'off';
  $('site-status').textContent = t('popup.status.unsupported');
  $('disable-link').classList.add('hidden');
  show('unsupported-panel');
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
async function loadState() {
  const state = await chrome.runtime.sendMessage({
    type: 'CA_GET_STATE',
    host: app.host,
    origin: app.origin,
    tabId: app.tab?.id,
  });
  if (!state?.ok) throw new Error(state?.error || t('popup.error.state'));
  applyState(state);
  render();
  if (app.enabled) ensureOverlay();
}

/** 确认页面里真的挂上了悬浮框（扩展更新前打开的页面需要补注入）。 */
async function ensureOverlay() {
  if (app.reportOnly || !app.enabled || !app.tab?.id) {
    app.overlayReady = false;
    updateOverlayHint();
    return;
  }
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'CA_ENSURE_OVERLAY',
      host: app.host,
      tabId: app.tab.id,
    });
    app.overlayReady = Boolean(result?.ok && result.reachable);
  } catch {
    app.overlayReady = false;
  }
  updateOverlayHint();
}

function updateOverlayHint() {
  const hint = $('recording-count');
  if (!hint) return;
  if (!app.flow?.armed) {
    hint.textContent = t('popup.flow.canRestart');
    return;
  }
  if (app.overlayReady === null) {
    hint.textContent = t('popup.flow.overlayReady');
    return;
  }
  hint.textContent = app.overlayReady ? t('popup.flow.overlayReady') : t('popup.flow.overlayMissing');
}

function applyState(state) {
  app.site = state.site || null;
  app.granted = Boolean(state.granted);
  app.grantedPatterns = Array.isArray(state.grantedPatterns) ? state.grantedPatterns : [];
  app.enabled = Boolean(state.enabled);
  app.report = state.report || null;
  app.meta = state.meta || null;
  app.flow = state.flow || { armed: false };
  if (state.settings) app.settings = { ...app.settings, ...state.settings };
  app.masked = app.settings.maskByDefault !== false;
  if (app.settings.language) {
    applyLanguageSetting(app.settings.language);
    applyI18n();
  }
}

function render() {
  if (!app.supported) return;
  hideAllPanels();
  updateStatusPill();
  $('disable-link').classList.toggle('hidden', !app.enabled || app.reportOnly);
  renderToolbar();
  renderLastHint();

  if (app.reportOnly) {
    if (app.report) {
      show('result-panel');
      renderReport();
    } else {
      $('unsupported-text').textContent = t('popup.noReport');
      show('unsupported-panel');
    }
    return;
  }

  if (!app.granted) {
    show('enable-panel');
    $('enable-btn').textContent = app.site ? t('popup.enable.buttonRe') : t('popup.enable.button');
    $('enable-desc').textContent = app.site ? t('popup.enable.descRevoked') : t('popup.enable.desc');
    $('granted-hint').classList.add('hidden');
    $('enable-error').classList.add('hidden');
    return;
  }

  if (!app.enabled) {
    show('enable-panel');
    $('enable-btn').textContent = t('popup.enable.buttonFinish');
    $('granted-hint').classList.remove('hidden');
    $('enable-error').classList.add('hidden');
    return;
  }

  if (app.report) {
    show('result-panel');
    renderReport();
    return;
  }

  show('flow-panel');
  renderRecordingState();
}

function renderRecordingState() {
  const armed = Boolean(app.flow && app.flow.armed);
  $('recording-banner').classList.toggle('is-off', !armed);
  $('recording-title').textContent = armed ? t('popup.flow.recording') : t('popup.flow.notRecording');
  $('start-btn-row').classList.toggle('hidden', armed);
  $('analyze-btn').textContent = t('popup.flow.analyze');
  updateOverlayHint();
}

/**
 * 顶部工具栏：启用后一直可见；有分析结果时才显示「重新分析」。
 * 重新分析 = 重新开始记录 + 立刻分析一次，等价于把整个流程重来一遍。
 */
function renderToolbar() {
  // 「重新分析」挂在结果卡片头部：没有结果时整块结果区本来就不显示
  const visible = app.enabled && !app.reportOnly && Boolean(app.report);
  $('retry-btn').classList.toggle('hidden', !visible);
}

function updateStatusPill() {
  const pill = $('site-status');
  if (app.enabled) {
    pill.dataset.state = 'on';
    pill.textContent = t('popup.status.enabled');
  } else if (app.granted) {
    pill.dataset.state = 'granted';
    pill.textContent = t('popup.status.granted');
  } else {
    pill.dataset.state = 'off';
    pill.textContent = t('popup.status.off');
  }
}

function renderLastHint() {
  const element = $('last-hint');
  if (!app.meta) {
    element.classList.add('hidden');
    return;
  }
  const parts = [];
  if (app.meta.mechanismShort) parts.push(app.meta.mechanismShort);
  if (typeof app.meta.confidence === 'number') {
    parts.push(t('popup.result.confidenceOnly', { value: app.meta.confidence }));
  }
  if (app.meta.analyzedAt) parts.push(formatRelative(app.meta.analyzedAt));
  element.textContent = t('popup.result.lastHint', { summary: parts.join(' · ') });
  element.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 启用 / 停用
// ---------------------------------------------------------------------------
async function onEnable() {
  if (app.busy) return;
  const patterns = buildPatterns();
  $('enable-error').classList.add('hidden');
  $('enable-btn').disabled = false;

  // 权限已全部存在（例如之前授权过、但站点记录被清除）时直接完成启用，避免不必要的权限请求
  if (missingPatterns().length > 0) {
    const button = $('enable-btn');
    button.disabled = true;
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: patterns });
    } catch (error) {
      button.disabled = false;
      showEnableError(t('popup.error.permissionRequest', { message: error?.message || error }));
      return;
    }
    if (!granted) {
      button.disabled = false;
      showEnableError(
        t('popup.error.noPermission'),
      );
      return;
    }
  }

  // 不管权限是否已在，都重新注册脚本 + 重新开始记录，保证页面能显示悬浮框
  await finishEnable(patterns);
}

async function finishEnable(patterns) {
  const button = $('enable-btn');
  button.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({
      type: 'CA_ENABLE_SITE',
      host: app.host,
      origin: app.origin,
      patterns,
      tabId: app.tab?.id,
    });
    if (!state?.ok) {
      showEnableError(state?.error || t('popup.error.enableFailed'));
      return;
    }
    applyState(state);
    render();
    await ensureOverlay();
    if (app.overlayReady) {
      toast(t('popup.toast.enabledStarted'));
    } else {
      toast(t('popup.toast.enabledNoResponse'));
    }
  } catch (error) {
    showEnableError(String(error?.message || error));
  } finally {
    button.disabled = false;
  }
}

async function onDisable() {
  if (app.busy) return;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'CA_DISABLE_SITE',
      host: app.host,
      origin: app.origin,
    });
    if (!result?.ok) throw new Error(result?.error || t('popup.error.disableFailed'));

    // 以后台的真实状态为准（真实使用时权限已撤销 → 按钮回到「启用此网站」）
    app.report = null;
    app.meta = null;
    applyState({ ...result, report: null, meta: null });
    render();

    const revoked = !result.granted;
    toast(revoked ? t('popup.toast.disabledRevoked') : t('popup.toast.disabled'));
  } catch (error) {
    toast(t('popup.toast.disableFailed', { message: error?.message || error }));
  }
}

/** 当前站点需要、但还没有拿到的权限 pattern。 */
function missingPatterns() {
  const granted = new Set(app.grantedPatterns || []);
  return buildPatterns().filter((pattern) => !granted.has(pattern));
}

function buildPatterns() {
  const scheme = app.origin.startsWith('http://') ? 'http' : 'https';
  const hostname = app.host.replace(/:\d+$/, '');
  const patterns = [`${scheme}://${app.host}/*`];
  if (scheme === 'http') patterns.push(`https://${app.host}/*`);
  // Chrome 的 cookies API 按“域名”而不是“域名+端口”授权：
  // 非默认端口（如 localhost:3000）需要额外申请不带端口的 pattern，否则读不到 Cookie。
  if (hostname !== app.host) {
    patterns.push(`${scheme}://${hostname}/*`);
    if (scheme === 'http') patterns.push(`https://${hostname}/*`);
  }
  return [...new Set(patterns)];
}

function showEnableError(message) {
  const element = $('enable-error');
  element.textContent = message;
  element.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 分析
// ---------------------------------------------------------------------------
async function onAnalyze() {
  if (app.busy || !app.enabled) return;
  setBusy(true);
  hideAllPanels();
  show('loading-panel');

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'CA_ANALYZE',
      tabId: app.tab?.id,
      host: app.host,
      origin: app.origin,
    });
    if (!result?.ok) {
      renderAnalysisError(analyzeErrorMessage(result));
      return;
    }
    app.report = result.report;
    app.meta = result.meta || app.meta;
    app.flow = { armed: Boolean(result.armed) };
    app.masked = app.settings.maskByDefault !== false;
    render();
    toast(result.report?.auth?.kind === 'none' ? t('popup.toast.noCredential') : t('popup.toast.analyzed'));
  } catch (error) {
    renderAnalysisError(String(error?.message || error));
  } finally {
    setBusy(false);
  }
}

function analyzeErrorMessage(result) {
  switch (result?.code) {
    case 'NOT_ENABLED':
      return t('popup.error.notEnabled');
    case 'NO_PERMISSION':
      return t('popup.error.revoked');
    case 'TAB_CHANGED':
      return t('popup.error.tabChanged');
    case 'PAGE_LOADING':
      return t('popup.error.pageLoading');
    case 'NO_TAB':
      return t('popup.error.tabMissing');
    default:
      return result?.error || t('popup.error.analyzeGeneric');
  }
}

function renderAnalysisError(message) {
  hideAllPanels();
  $('error-text').textContent = message;
  show('error-panel');
}

function setBusy(busy) {
  app.busy = busy;
  $('progress').classList.toggle('hidden', !busy);
  for (const id of ['enable-btn', 'reload-btn', 'disable-link', 'suggested-btn', 'error-retry', 'retry-btn', 'customize-btn']) {
    const element = $(id);
    if (element) element.disabled = busy;
  }
  const analyze = $('analyze-btn');
  if (analyze) {
    analyze.disabled = busy;
    analyze.textContent = busy ? t('popup.analyzing') : t('popup.flow.analyze');
  }
}

async function onCustomize() {
  if (!app.host) return;
  const response = await chrome.runtime.sendMessage({ type: 'CA_OPEN_CUSTOMIZE', host: app.host });
  if (!response?.ok) toast(t('popup.toast.customizeFailed'));
}

async function onRetry() {
  if (app.busy || !app.enabled) return;
  // 直接分析当前页面：识别到凭证就结束，不打扰页面；
  // 没识别到（登录态过期）时后台会自动保持记录状态并亮出悬浮框。
  await onAnalyze();
}

async function onStartRecording() {
  if (app.busy) return;
  try {
    const state = await chrome.runtime.sendMessage({
      type: 'CA_ARM',
      host: app.host,
      origin: app.origin,
      tabId: app.tab?.id,
    });
    if (!state?.ok) throw new Error(state?.error || t('popup.error.armFailed'));
    applyState(state);
    render();
    await ensureOverlay();
    toast(app.overlayReady ? t('popup.toast.recordingStarted') : t('popup.toast.recordingStartedRefresh'));
  } catch (error) {
    toast(String(error?.message || error));
  }
}

async function onReload() {
  if (!app.tab?.id) {
    toast(t('popup.error.reloadFailed'));
    return;
  }
  try {
    await chrome.tabs.reload(app.tab.id);
    toast(t('popup.toast.reloaded'));
  } catch {
    toast(t('popup.error.reloadFailedManual'));
  }
}

// ---------------------------------------------------------------------------
// 结果渲染
// ---------------------------------------------------------------------------
/** 有「高级自定义」结果时优先用它，保证复制内容与界面一致 */
function customCopies() {
  return app.report?.custom?.copies || app.report?.copies || {};
}

function renderReport() {
  const report = app.report;
  if (!report) return;
  const custom = report.custom && report.custom.copies ? report.custom : null;
  const auth = custom?.auth ? { ...report.auth, ...custom.auth } : report.auth || {};
  const copies = custom?.copies || report.copies || {};
  const headerList = custom?.headers || report.headers || [];
  const raw = auth.raw || '';
  const confidence = Math.max(0, Math.min(100, Math.round(auth.confidence || 0)));

  const localizedMech = localizeMechanism(auth.mechanismId);
  $('mech-label').textContent = localizedMech?.name || auth.mechanism || t('mech.unknown.short');
  $('conf-num').textContent = String(confidence);
  const fill = $('conf-fill');
  fill.style.width = `${confidence}%`;
  fill.dataset.level = confidence >= 75 ? 'high' : confidence >= 45 ? 'mid' : 'low';
  $('mech-desc').textContent = localizedMech?.description || auth.description || '';

  const localizedLabel = localizeCredentialLabel(auth.kind, (auth.items || []).length);
  $('cred-label').textContent = raw
    ? localizedLabel || auth.label || t('popup.result.credFallback')
    : t('popup.result.credNone');
  $('cred-value').textContent = raw
    ? app.masked
      ? maskSecret(raw, { head: 18, tail: 8 })
      : raw
    : t('popup.result.credNoneHint');
  $('cred-value').classList.toggle('is-empty', !raw);
  $('toggle-mask').classList.toggle('hidden', !raw);
  $('toggle-mask').textContent = app.masked ? t('popup.result.showFull') : t('popup.result.hide');
  const sourceText = localizeSourceLabel(auth.sourceLabelKey, auth.sourceLabel);
  $('cred-source').textContent = raw && sourceText
    ? t('popup.result.source', { source: sourceText })
    : '';
  $('cred-expiry').textContent = raw ? t('popup.result.expiry', { text: expiresText(report, getLocale()) }) : '';

  $('copy-raw').disabled = !copies.raw;
  $('copy-prompt').disabled = !copies.prompt;
  const credentialHeaderCount = headerList.filter((header) =>
    /^(cookie|authorization)$/i.test(header.name),
  ).length;
  $('multi-note').classList.toggle('hidden', credentialHeaderCount < 2);

  renderHeaders(headerList);
  renderEvidence((report.evidence || []).map((item) => localizeEvidence(item)));
  renderWarnings((report.warnings || []).map((item) => localizeWarning(item)));
  renderSuggested(report.suggestedOrigins || []);

  const stats = report.stats || {};
  $('analyzed-at').textContent = t('popup.result.analyzedAt', {
    time: formatTime(report.analyzedAt),
    relative: formatRelative(report.analyzedAt),
    requests: stats.requests ?? 0,
    cookies: stats.cookies ?? 0,
  });
}

function renderHeaders(headers) {
  const list = $('headers-list');
  list.textContent = '';
  $('header-count').textContent = headers.length > 0 ? t('popup.result.selectedCount', { count: headers.length }) : '';
  $('copy-headers').disabled = headers.length === 0;

  headers.forEach((header, index) => {
    const row = document.createElement('div');
    row.className = 'header-row';

    const name = document.createElement('span');
    name.className = 'header-name';
    name.textContent = header.name;

    const value = document.createElement('code');
    value.className = 'header-value';
    value.textContent = app.masked ? maskSecret(header.value, { head: 22, tail: 8 }) : header.value;

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'mini-link';
    copy.textContent = t('popup.copy.copy');
    copy.dataset.copyHeader = String(index);
    copy.setAttribute('aria-label', t('popup.copy.copyValueAria', { name: header.name }));

    row.append(name, value, copy);
    list.append(row);
  });
}

function renderEvidence(evidence) {
  const list = $('evidence-list');
  list.textContent = '';
  $('evidence-count').textContent = evidence.length > 0
    ? t('popup.result.evidenceCount', { count: evidence.length })
    : '';

  for (const item of evidence) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'ev-dot';
    dot.dataset.type = item.type || 'hint';

    const body = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = item.title;
    body.append(title);

    if (item.detail) {
      const detail = document.createElement('p');
      detail.textContent = item.detail;
      body.append(detail);
    }

    li.append(dot, body);
    list.append(li);
  }

  if (evidence.length === 0) {
    const li = document.createElement('li');
    const body = document.createElement('div');
    const text = document.createElement('p');
    text.textContent = t('popup.result.noEvidence');
    body.append(text);
    li.append(document.createElement('span'), body);
    list.append(li);
  }
}

function renderWarnings(warnings) {
  const container = $('warnings');
  container.textContent = '';
  const labels = {
    danger: t('level.danger'),
    warn: t('level.warn'),
    info: t('level.info'),
  };

  for (const warning of warnings) {
    const item = document.createElement('div');
    item.className = 'warn-item';
    item.dataset.level = warning.level || 'info';

    const tag = document.createElement('span');
    tag.className = 'warn-tag';
    tag.textContent = labels[warning.level] || t('level.info');

    const text = document.createElement('span');
    text.textContent = warning.text;

    item.append(tag, text);
    container.append(item);
  }
}

function renderSuggested(suggestedOrigins) {
  const container = $('suggested');
  if (suggestedOrigins.length === 0) {
    container.classList.add('hidden');
    return;
  }
  $('suggested-text').textContent = t('popup.result.suggested', {
    hosts: suggestedOrigins.map((item) => item.host).join(', '),
  });
  container.classList.remove('hidden');
}

async function onGrantSuggested() {
  if (app.busy) return;
  const suggested = app.report?.suggestedOrigins || [];
  if (suggested.length === 0) return;

  // 补充授权：同域（可能只是端口不同）用 buildPatterns 的写法，跨站用 origin
  const extra = suggested.flatMap((item) => {
    const scheme = item.origin.startsWith('http://') ? 'http' : 'https';
    return [`${item.origin}/*`, `${scheme}://${item.host.replace(/:\d+$/, '')}/*`];
  });
  const patterns = [...new Set([...buildPatterns(), ...extra])];
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: patterns });
  } catch (error) {
    toast(t('popup.toast.grantFailed', { message: error?.message || error }));
    return;
  }
  if (!granted) {
    toast(t('popup.toast.grantCancelled'));
    return;
  }

  try {
    const state = await chrome.runtime.sendMessage({
      type: 'CA_ENABLE_SITE',
      host: app.host,
      origin: app.origin,
      patterns,
      tabId: app.tab?.id,
    });
    if (!state?.ok) throw new Error(state?.error || t('popup.toast.grantError'));
    applyState(state);
    render();
    toast(t('popup.toast.granted'));
  } catch (error) {
    toast(String(error?.message || error));
  }
}

// ---------------------------------------------------------------------------
// 复制
// ---------------------------------------------------------------------------
async function copyText(text, button, message) {
  if (!text) {
    toast(t('popup.toast.nothingToCopy'));
    return;
  }
  const ok = await writeClipboard(text);
  if (!ok) {
    toast(t('popup.toast.copyManual'));
    return;
  }
  toast(message);
  flash(button);
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 回退到 execCommand */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function flash(button) {
  if (!button) return;
  button.classList.add('is-copied');
  setTimeout(() => button.classList.remove('is-copied'), 1400);
}

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('is-visible'), 1900);
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------
function bindEvents() {
  $('enable-btn').addEventListener('click', onEnable);
  $('start-btn').addEventListener('click', onStartRecording);
  $('retry-btn').addEventListener('click', onRetry);
  $('disable-link').addEventListener('click', onDisable);
  $('analyze-btn').addEventListener('click', onAnalyze);
  $('error-retry').addEventListener('click', onAnalyze);
  $('reload-btn').addEventListener('click', onReload);

  $('copy-raw').addEventListener('click', () => {
    copyText(customCopies().raw, $('copy-raw'), t('popup.toast.copiedRaw'));
  });
  $('copy-prompt').addEventListener('click', () => {
    copyText(customCopies().prompt, $('copy-prompt'), t('popup.toast.copiedPrompt'));
  });
  $('copy-headers').addEventListener('click', () => {
    copyText(customCopies().headers, $('copy-headers'), t('popup.toast.copiedHeaders'));
  });
  $('customize-btn').addEventListener('click', onCustomize);

  $('toggle-mask').addEventListener('click', () => {
    app.masked = !app.masked;
    renderReport();
  });

  $('headers-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy-header]');
    if (!button) return;
    const index = Number(button.dataset.copyHeader);
    const header = app.report?.headers?.[index];
    if (!header) return;
    copyText(header.value, button, t('popup.toast.copiedValue', { name: header.name }));
  });

  $('suggested-btn').addEventListener('click', onGrantSuggested);
  $('open-options').addEventListener('click', openOptions);
  $('footer-options').addEventListener('click', openOptions);

  $('site-favicon').addEventListener('error', () => {
    $('site-favicon').src = '../icons/icon32.png';
  });
}

function openOptions() {
  try {
    chrome.runtime.openOptionsPage();
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function show(id) {
  $(id).classList.remove('hidden');
}

function hideAllPanels() {
  for (const id of PANEL_IDS) $(id).classList.add('hidden');
  $('last-hint').classList.add('hidden');
}