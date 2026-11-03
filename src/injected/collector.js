/**
 * ISOLATED world 采集脚本（content script）。
 *
 * 职责：
 *  1. 从 MAIN world 的 hook 拿请求/响应快照（postMessage 跨世界通信）；
 *  2. 读取 localStorage / sessionStorage / Cookie 名称 / 页面特征；
 *  3. 在页面右下角渲染悬浮框（Shadow DOM 隔离样式）：
 *       - 记录中：显示「登录好了，结束分析」按钮；
 *       - 分析完成：直接给出鉴权方式 + 两种复制按钮；
 *  4. 通过 chrome.runtime.onMessage 把数据交给后台，由后台统一分析。
 *
 * 悬浮框是否显示完全由本地存储里的站点状态决定（不需要唤醒 Service Worker）。
 */
(() => {
  // 版本号而不是布尔值：扩展更新后，老页面上的旧脚本守卫不会阻止新脚本初始化
  const AGENT_VERSION = 2;

/**
 * 悬浮框文案：内容脚本不能 import 模块。
 * 优先用后台下发的文案（跟随后台当前语言，支持手动切换），
 * 还没拿到时回退 chrome.i18n（跟随浏览器）。
 */
let overlayStrings = null;

function formatString(text, args) {
  return String(text).replace(/\$(\d)/g, (match, index) => {
    const value = args[Number(index) - 1];
    return value === undefined || value === null ? '' : String(value);
  });
}

function tr(key, ...args) {
  if (overlayStrings && typeof overlayStrings[key] === 'string' && overlayStrings[key]) {
    return formatString(overlayStrings[key], args);
  }
  try {
    return chrome.i18n.getMessage(key, args.map((item) => String(item ?? ''))) || key;
  } catch {
    return key;
  }
}

async function loadOverlayStrings() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CA_OVERLAY_STRINGS' });
    if (response?.ok && response.strings) {
      overlayStrings = response.strings;
      if (ui.root && ui.shadow) render();
    }
  } catch {
    /* 后台暂不可用：沿用 chrome.i18n */
  }
}
  if (window.__authInspectorCollector === AGENT_VERSION) return;
  window.__authInspectorCollector = AGENT_VERSION;

  const HOOK_SOURCE = '__auth_inspector_hook';
  const COLLECTOR_SOURCE = '__auth_inspector_collector';
  const SNAPSHOT_TIMEOUT = 500;
  const MAX_REQUESTS = 300;
  const MAX_HEADER_VALUE = 8192;
  const MAX_BODY = 64 * 1024;
  const MAX_STORAGE_VALUE = 12000;
  const MAX_STORAGE_ENTRIES = 300;
  const MAX_SCRIPT_SRCS = 120;

  const OVERLAY_ID = 'ca-auth-inspector-overlay';
  const FLOW_TTL_MS = 2 * 60 * 60 * 1000;

  // ---------------------------------------------------------------------------
  // 与 MAIN world 通信
  // ---------------------------------------------------------------------------
  const pendingHooks = new Map();
  let hookReady = false;
  let sequence = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== HOOK_SOURCE) return;
    if (data.type === 'ready') {
      hookReady = true;
      return;
    }
    const pending = pendingHooks.get(data.id);
    if (!pending) return;
    pendingHooks.delete(data.id);
    clearTimeout(pending.timer);
    pending.resolve(data);
  });

  function requestHook(payload, timeout = SNAPSHOT_TIMEOUT) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${(sequence += 1)}`;
      const timer = setTimeout(() => {
        pendingHooks.delete(id);
        resolve(null);
      }, timeout);
      pendingHooks.set(id, { resolve, timer });
      try {
        window.postMessage({ source: COLLECTOR_SOURCE, id, ...payload }, '*');
      } catch {
        clearTimeout(timer);
        pendingHooks.delete(id);
        resolve(null);
      }
    });
  }

  async function requestSnapshot() {
    const data = await requestHook({ type: 'snapshot' });
    return data && Array.isArray(data.records) ? data : null;
  }

  async function requestCount() {
    const data = await requestHook({ type: 'count' }, 300);
    return data && typeof data.count === 'number' ? data.count : null;
  }

  // ---------------------------------------------------------------------------
  // 数据清洗
  // ---------------------------------------------------------------------------
  function sanitizeHeaders(value) {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'string') continue;
      const name = String(key).toLowerCase();
      if (!name || name.length > 128) continue;
      out[name] = item.length > MAX_HEADER_VALUE ? item.slice(0, MAX_HEADER_VALUE) : item;
    }
    return out;
  }

  function sanitizeRequests(list) {
    if (!Array.isArray(list)) return [];
    const cleaned = [];
    for (const record of list.slice(-MAX_REQUESTS)) {
      if (!record || typeof record !== 'object') continue;
      const url = String(record.url || '').slice(0, 4096);
      if (!/^https?:/i.test(url)) continue;
      cleaned.push({
        url,
        method: String(record.method || 'GET').toUpperCase().slice(0, 16),
        time: Number(record.time) || 0,
        headers: sanitizeHeaders(record.headers),
        status: Number(record.status) || 0,
        responseHeaders: sanitizeHeaders(record.responseHeaders),
        responseBody:
          typeof record.responseBody === 'string' && record.responseBody.length <= MAX_BODY
            ? record.responseBody
            : null,
      });
    }
    return cleaned;
  }

  function readStorageArea(area) {
    const out = [];
    try {
      const total = Math.min(area.length, MAX_STORAGE_ENTRIES);
      for (let index = 0; index < total; index += 1) {
        const key = area.key(index);
        if (key == null) continue;
        let value;
        try {
          value = area.getItem(key);
        } catch {
          continue;
        }
        if (typeof value !== 'string' || value.length === 0) continue;
        out.push({
          key: String(key).slice(0, 256),
          value: value.length > MAX_STORAGE_VALUE ? value.slice(0, MAX_STORAGE_VALUE) : value,
        });
      }
    } catch {
      /* 存储可能被页面禁用 */
    }
    return out;
  }

  /** document.cookie 能读到「非 HttpOnly」Cookie，包括写在父域名上的，用来补 chrome.cookies 的盲区 */
  function readDocumentCookies() {
    const out = [];
    try {
      const raw = document.cookie || '';
      for (const part of raw.split(';')) {
        const text = part.trim();
        if (!text) continue;
        const index = text.indexOf('=');
        if (index <= 0) continue;
        const name = text.slice(0, index).trim();
        const value = text.slice(index + 1);
        if (!name || value.length === 0 || value.length > 12000) continue;
        out.push({ name: name.slice(0, 256), value });
        if (out.length >= 100) break;
      }
    } catch {
      /* 忽略 */
    }
    return out;
  }

  function readPage() {
    let loginPageLikely = false;
    try {
      loginPageLikely =
        Boolean(document.querySelector('input[type="password"]')) ||
        /(^|\/)(login|signin|sign-in|auth)(\/|$)/i.test(location.pathname);
    } catch {
      loginPageLikely = false;
    }
    return {
      url: location.href,
      origin: location.origin,
      title: document.title || '',
      referrer: document.referrer || '',
      path: location.pathname,
      loginPageLikely,
    };
  }

  function readHints() {
    const scriptSrcs = [];
    const linkHrefs = [];
    const meta = {};
    try {
      for (const element of document.querySelectorAll('script[src]')) {
        if (element.src) scriptSrcs.push(element.src.slice(0, 1024));
        if (scriptSrcs.length >= MAX_SCRIPT_SRCS) break;
      }
      for (const element of document.querySelectorAll('link[href]')) {
        if (element.href) linkHrefs.push(element.href.slice(0, 1024));
        if (linkHrefs.length >= MAX_SCRIPT_SRCS) break;
      }
      for (const name of ['csrf-token', 'csrf-param', '_csrf', 'xsrf-token', 'csrf']) {
        const element = document.querySelector(`meta[name="${name}"]`);
        if (element && element.content) meta[name] = element.content.slice(0, 2048);
      }
    } catch {
      /* 忽略 */
    }
    let cookieNames = [];
    let cookieString = '';
    try {
      cookieString = document.cookie || '';
      cookieNames = cookieString
        .split(';')
        .map((part) => part.split('=')[0].trim())
        .filter(Boolean)
        .slice(0, 100);
    } catch {
      /* 忽略 */
    }
    return { scriptSrcs, linkHrefs, meta, cookieNames, cookieString: cookieString.slice(0, 8192) };
  }

  async function readIndexedDatabases() {
    try {
      if (!indexedDB || typeof indexedDB.databases !== 'function') return [];
      const list = await indexedDB.databases();
      return list
        .map((db) => db && db.name)
        .filter(Boolean)
        .slice(0, 50);
    } catch {
      return [];
    }
  }

  async function collect() {
    const snapshot = await requestSnapshot();
    const page = readPage();
    const hints = readHints();
    hints.indexedDB = await readIndexedDatabases();

    const storage = {
      local: readStorageArea(window.localStorage),
      session: readStorageArea(window.sessionStorage),
    };

    return {
      ok: true,
      page,
      hints,
      storage,
      documentCookies: readDocumentCookies(),
      requests: sanitizeRequests(snapshot && snapshot.records),
      meta: { hookReady: Boolean(snapshot) || hookReady, collectedAt: new Date().toISOString() },
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;
    if (message.type === 'CA_PING') {
      sendResponse({ ok: true, hookReady, url: location.href, overlay: Boolean(ui.root && ui.root.isConnected) });
      return undefined;
    }
    if (message.type === 'CA_COLLECT') {
      collect()
        .then((payload) => sendResponse(payload))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    return undefined;
  });

  // 通知后台“当前页面已就绪”，用于点亮扩展图标角标
  try {
    chrome.runtime
      .sendMessage({ type: 'CA_PAGE_READY', host: location.host, url: location.href })
      .catch(() => {});
  } catch {
    /* 扩展可能正在更新 */
  }

  // ---------------------------------------------------------------------------
  // 页面内悬浮框（Shadow DOM，避免被站点样式影响）
  // ---------------------------------------------------------------------------
  const OVERLAY_CSS = `
    :host { all: initial; }
    .ca-card {
      width: 312px;
      max-width: calc(100vw - 24px);
      background: #ffffff;
      color: #111827;
      border: 1px solid #e5e7ef;
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(15, 23, 42, .18), 0 2px 8px rgba(15, 23, 42, .08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      overflow: hidden;
      animation: ca-in .18s ease;
    }
    .ca-head { display: flex; align-items: center; gap: 8px; padding: 11px 12px 0; }
    .ca-title { flex: 1; font-weight: 700; font-size: 13px; letter-spacing: .01em; }
    .ca-dot {
      width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
      background: #10b981; box-shadow: 0 0 0 0 rgba(16,185,129,.55);
      animation: ca-pulse 1.8s ease-out infinite;
    }
    .ca-dot-ok { background: #10b981; animation: none; }
    .ca-dot-warn { background: #f59e0b; animation: none; }
    .ca-icon {
      border: 0; background: transparent; color: #9ca3af; cursor: pointer;
      width: 22px; height: 22px; border-radius: 6px; font-size: 15px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center; padding: 0;
    }
    .ca-icon:hover { background: rgba(148, 163, 184, .18); color: #4b5563; }
    .ca-body { padding: 8px 12px 12px; }
    .ca-text { margin: 0; color: #6b7280; font-size: 12px; line-height: 1.6; }
    .ca-count { margin: 6px 0 0; color: #9ca3af; font-size: 11px; font-variant-numeric: tabular-nums; }
    .ca-primary {
      width: 100%; margin-top: 10px; border: 0; border-radius: 10px;
      padding: 10px 12px; cursor: pointer; font-family: inherit;
      background: linear-gradient(135deg, #4f46e5, #4338ca); color: #fff;
      font-weight: 700; font-size: 13px; box-shadow: 0 6px 16px rgba(79, 70, 229, .26);
      transition: filter .15s ease, transform .08s ease;
    }
    .ca-primary:hover { filter: brightness(1.06); }
    .ca-primary:active { transform: translateY(1px); }
    .ca-secondary {
      width: 100%; margin-top: 8px; border: 1px solid #e5e7ef; border-radius: 10px;
      padding: 9px 12px; cursor: pointer; font-family: inherit; background: #fff;
      color: #4f46e5; font-weight: 600; font-size: 12px;
    }
    .ca-secondary:hover { border-color: #4f46e5; background: rgba(79, 70, 229, .06); }
    .ca-mech { font-weight: 800; font-size: 14px; line-height: 1.35; letter-spacing: -.01em; }
    .ca-conf { margin-top: 3px; color: #6b7280; font-size: 11px; }
    .ca-cred {
      margin-top: 8px; padding: 8px 9px; border-radius: 9px;
      background: #0f172a; color: #e2e8f0; font-size: 11px; line-height: 1.5;
    }
    .ca-cred pre {
      margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap; word-break: break-all; max-height: 76px; overflow: auto;
    }
    .ca-cred-foot { display: flex; justify-content: flex-end; margin-top: 4px; }
    .ca-mini {
      border: 0; background: none; color: #a5b4fc; cursor: pointer;
      font-family: inherit; font-size: 11px; padding: 0; text-decoration: underline;
    }
    .ca-mini:hover { opacity: .8; }
    .ca-note { margin: 8px 0 0; color: #6b7280; font-size: 11px; line-height: 1.55; }
    .ca-warnings { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .ca-warnings li { font-size: 11px; color: #6b7280; line-height: 1.5; padding-left: 10px; position: relative; }
    .ca-warnings li::before {
      content: ""; position: absolute; left: 0; top: 6px; width: 4px; height: 4px; border-radius: 50%; background: #f59e0b;
    }
    .ca-copy { display: flex; gap: 8px; margin-top: 9px; }
    .ca-copy > button { flex: 1; width: auto; margin-top: 0; }
    .ca-foot { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 9px; }
    .ca-foot .ca-mini { color: #6b7280; }
    .ca-error {
      margin: 8px 0 0; padding: 6px 8px; border-radius: 8px;
      background: rgba(220, 38, 38, .1); color: #dc2626; font-size: 11px;
    }
    .ca-pill {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 8px 7px 12px; border-radius: 999px;
      background: #fff; border: 1px solid #e5e7ef;
      box-shadow: 0 8px 24px rgba(15, 23, 42, .16);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      font-size: 12px; color: #111827; animation: ca-in .18s ease;
    }
    .ca-pill-text { font-weight: 600; }
    .ca-pill-btn {
      border: 0; border-radius: 999px; padding: 5px 10px; cursor: pointer;
      background: linear-gradient(135deg, #4f46e5, #4338ca); color: #fff;
      font-family: inherit; font-size: 11px; font-weight: 700;
    }
    .ca-spinner {
      width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto;
      border: 2px solid #e5e7ef; border-top-color: #4f46e5;
      animation: ca-spin .8s linear infinite;
    }
    @keyframes ca-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes ca-pulse {
      0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, .5); }
      70% { box-shadow: 0 0 0 7px rgba(16, 185, 129, 0); }
      100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    @keyframes ca-spin { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: dark) {
      .ca-card, .ca-pill { background: #141a2e; color: #e8ecf6; border-color: #263049; }
      .ca-title { color: #e8ecf6; }
      .ca-text, .ca-count, .ca-conf, .ca-note, .ca-warnings li { color: #98a2b3; }
      .ca-secondary { background: #18203a; border-color: #263049; color: #a5b4fc; }
      .ca-pill-text { color: #e8ecf6; }
      .ca-cred { background: #070c19; color: #dbeafe; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ca-card, .ca-pill { animation: none; }
      .ca-dot { animation: none; }
    }
  `;

  const ui = {
    root: null,
    shadow: null,
    mode: 'hidden', // hidden | recording | busy | result | unknown
    report: null,
    masked: true,
    collapsed: false,
    count: 0,
    error: '',
    pollTimer: null,
  };

  function isTopFrame() {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  }

  async function readFlowState() {
    try {
      const data = await chrome.storage.local.get(['sites', 'flows']);
      const sites = data.sites || {};
      const flows = data.flows || {};
      const site = sites[location.host] || null;
      const flow = flows[location.host] || null;
      const enabled = Boolean(site && Array.isArray(site.patterns) && site.patterns.length > 0);
      const age = Date.now() - Date.parse((flow && flow.armedAt) || 0);
      // 没有记录状态时（老版本数据）默认跟随「已启用」，保证悬浮框能出现
      const armed = flow
        ? Boolean(flow.armed) && (!Number.isFinite(age) || age < FLOW_TTL_MS)
        : enabled;
      return { enabled, armed };
    } catch {
      return { enabled: false, armed: false };
    }
  }

  function mountOverlay() {
    if (ui.root && ui.root.isConnected) return;
    const root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute('data-ca-overlay', '');
    root.style.cssText =
      'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 312px; max-width: calc(100vw - 24px);';
    const shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${OVERLAY_CSS}</style><div class="ca-card" role="dialog" aria-live="polite"></div>`;
    shadow.addEventListener('click', onOverlayClick);
    (document.body || document.documentElement).appendChild(root);
    ui.root = root;
    ui.shadow = shadow;
  }

  function unmountOverlay() {
    stopPolling();
    if (ui.root) {
      try {
        ui.root.remove();
      } catch {
        /* 忽略 */
      }
    }
    ui.root = null;
    ui.shadow = null;
    ui.mode = 'hidden';
    ui.report = null;
    ui.count = 0;
    ui.error = '';
  }

  function render() {
    if (!ui.shadow) return;
    const card = ui.shadow.querySelector('.ca-card');
    if (!card) return;

    if (ui.mode === 'hidden') {
      card.innerHTML = '';
      return;
    }

    if (ui.mode === 'recording' && ui.collapsed) {
      card.innerHTML = `
        <div class="ca-pill">
          <span class="ca-dot" aria-hidden="true"></span>
          <span class="ca-pill-text">${tr('overlayPill', ui.count)}</span>
          <button class="ca-pill-btn" data-action="finish">${tr('overlayFinishPill')}</button>
          <button class="ca-icon" data-action="expand" title="${tr('overlayExpand')}" aria-label="${tr('overlayExpand')}">⌃</button>
        </div>`;
      return;
    }

    if (ui.mode === 'recording') {
      card.innerHTML = `
        <div class="ca-head">
          <span class="ca-dot" aria-hidden="true"></span>
          <span class="ca-title">${tr('overlayRecording')}</span>
          <button class="ca-icon" data-action="collapse" title="${tr('overlayCollapse')}" aria-label="${tr('overlayCollapse')}">−</button>
          <button class="ca-icon" data-action="close" title="${tr('overlayStop')}" aria-label="${tr('overlayStop')}">×</button>
        </div>
        <div class="ca-body">
          <p class="ca-text">${tr('overlayRecordingText')}</p>
          <p class="ca-count" data-role="count">${tr('overlayRecordingCount', ui.count)}</p>
          ${ui.error ? `<p class="ca-error">${escapeHtml(ui.error)}</p>` : ''}
          <button class="ca-primary" data-action="finish">${tr('overlayFinish')}</button>
        </div>`;
      return;
    }

    if (ui.mode === 'busy') {
      card.innerHTML = `
        <div class="ca-head">
          <span class="ca-spinner" aria-hidden="true"></span>
          <span class="ca-title">${tr('overlayAnalyzing')}</span>
        </div>
        <div class="ca-body">
          <p class="ca-text">${tr('overlayAnalyzingText')}</p>
        </div>`;
      return;
    }

    if (ui.mode === 'unknown') {
      const warnings = ((ui.report && ui.report.warnings) || [])
        .slice(0, 3)
        .map((item) => `<li>${escapeHtml(item.text)}</li>`)
        .join('');
      card.innerHTML = `
        <div class="ca-head">
          <span class="ca-dot ca-dot-warn" aria-hidden="true"></span>
          <span class="ca-title">${tr('overlayUnknownTitle')}</span>
          <button class="ca-icon" data-action="close" title="${tr('overlayClose')}" aria-label="${tr('overlayClose')}">×</button>
        </div>
        <div class="ca-body">
          <p class="ca-text">${tr('overlayUnknownText')}</p>
          ${warnings ? `<ul class="ca-warnings">${warnings}</ul>` : ''}
          ${ui.error ? `<p class="ca-error">${escapeHtml(ui.error)}</p>` : ''}
          <div class="ca-copy">
            <button class="ca-primary" data-action="rearm">${tr('overlayContinue')}</button>
            <button class="ca-secondary" data-action="open-report">${tr('overlayDetails')}</button>
          </div>
        </div>`;
      return;
    }

    // 结果态
    const report = ui.report || {};
    const auth = report.auth || {};
    const raw = auth.raw || '';
    const confidence = Math.round(auth.confidence || 0);
    const credentialCount = (report.headers || []).filter((header) =>
      /^(cookie|authorization)$/i.test(header.name),
    ).length;
    const note =
      credentialCount > 1
        ? tr('overlayMulti')
        : auth.sourceLabel
          ? tr('overlaySource', auth.sourceLabel)
          : '';

    card.innerHTML = `
      <div class="ca-head">
        <span class="ca-dot ca-dot-ok" aria-hidden="true"></span>
        <span class="ca-title">${tr('overlayDone')}</span>
        <button class="ca-icon" data-action="close" title="${tr('overlayClose')}" aria-label="${tr('overlayClose')}">×</button>
      </div>
      <div class="ca-body">
        <div class="ca-mech">${escapeHtml(auth.mechanism || tr('overlayUnidentified'))}</div>
        <div class="ca-conf">${escapeHtml(tr('overlayConfidence', confidence, auth.label || ''))}</div>
        <div class="ca-cred">
          <pre data-role="cred">${escapeHtml(raw ? (ui.masked ? maskValue(raw) : raw) : tr('overlayEmptyCred'))}</pre>
          <div class="ca-cred-foot">
            <button class="ca-mini" data-action="toggle-mask">${ui.masked ? tr('overlayShowFull') : tr('overlayHideFull')}</button>
          </div>
        </div>
        ${note ? `<p class="ca-note">${escapeHtml(note)}</p>` : ''}
        ${ui.error ? `<p class="ca-error">${escapeHtml(ui.error)}</p>` : ''}
        <div class="ca-copy">
          <button class="ca-primary" data-action="copy-raw">${tr('overlayCopyRaw')}</button>
          <button class="ca-secondary" data-action="copy-prompt">${tr('overlayCopyPrompt')}</button>
        </div>
        <div class="ca-foot">
          <button class="ca-mini" data-action="retry">${tr('overlayRetry')}</button>
          <button class="ca-mini" data-action="open-report">${tr('overlayOpenReport')}</button>
        </div>
      </div>`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => {
      switch (character) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function maskValue(value) {
    const text = String(value || '');
    if (!text) return '';
    if (text.length <= 18) return '•'.repeat(Math.min(16, Math.max(6, text.length)));
    return `${text.slice(0, 14)}…${text.slice(-8)}`;
  }

  async function sendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  async function copyText(text, button, label) {
    if (!text) {
      ui.error = tr('overlayNoContent');
      render();
      return;
    }
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) ok = execCommandCopy(text);
    if (!ok) {
      ui.error = tr('overlayCopyFailed');
      render();
      return;
    }
    if (button) {
      const original = button.textContent;
      button.textContent = tr('overlayCopied', label);
      button.disabled = true;
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1400);
    }
  }

  function execCommandCopy(text) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function startPolling() {
    stopPolling();
    if (ui.mode !== 'recording') return;
    const tick = async () => {
      const count = await requestCount();
      if (typeof count === 'number' && ui.mode === 'recording') {
        ui.count = count;
        if (ui.shadow) {
          const counter = ui.shadow.querySelector('[data-role="count"]');
          if (counter) counter.textContent = tr('overlayRecordingCount', count);
          const inline = ui.shadow.querySelector('[data-role="count-inline"]');
          if (inline) inline.textContent = String(count);
        }
      }
    };
    tick();
    ui.pollTimer = setInterval(tick, 2000);
  }

  function stopPolling() {
    if (ui.pollTimer) clearInterval(ui.pollTimer);
    ui.pollTimer = null;
  }

  async function finishAnalysis() {
    if (ui.mode === 'busy') return;
    ui.mode = 'busy';
    ui.error = '';
    render();
    stopPolling();

    const result = await sendMessage({
      type: 'CA_ANALYZE',
      host: location.host,
      origin: location.origin,
    });

    if (!result || !result.ok) {
      ui.mode = 'recording';
      ui.error = analyzeError(result);
      render();
      startPolling();
      return;
    }

    ui.report = result.report || null;
    ui.mode = ui.report && ui.report.auth && ui.report.auth.kind !== 'none' ? 'result' : 'unknown';
    render();
  }

  function analyzeError(result) {
    switch (result && result.code) {
      case 'NOT_ENABLED':
        return '该网站尚未启用，请先在扩展里启用。';
      case 'NO_PERMISSION':
        return tr('overlayPermissionRevoked');
      case 'PAGE_LOADING':
        return '页面仍在加载，请稍后再试。';
      case 'TAB_CHANGED':
        return '标签页地址已变化，请重新打开扩展。';
      default:
        return (result && result.error) || '分析失败，请稍后再试。';
    }
  }

  async function onOverlayClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const action = button.dataset.action;

    switch (action) {
      case 'finish':
        await finishAnalysis();
        break;
      case 'retry':
        // 直接再分析一次；没识别到凭证时后台会自动保持记录状态
        await finishAnalysis();
        break;
      case 'close':
        if (ui.mode === 'recording') await disarm();
        unmountOverlay();
        break;
      case 'collapse':
        ui.collapsed = true;
        render();
        break;
      case 'expand':
        ui.collapsed = false;
        render();
        break;
      case 'toggle-mask':
        ui.masked = !ui.masked;
        render();
        break;
      case 'copy-raw':
        await copyText((ui.report && ui.report.copies && ui.report.copies.raw) || '', button, '');
        break;
      case 'copy-prompt':
        await copyText((ui.report && ui.report.copies && ui.report.copies.prompt) || '', button, '');
        break;
      case 'rearm':
        await rearm();
        break;
      case 'open-report':
        await sendMessage({ type: 'CA_OPEN_REPORT', host: location.host });
        break;
      default:
        break;
    }
  }

  async function disarm() {
    await sendMessage({ type: 'CA_DISARM', host: location.host });
    stopPolling();
  }

  async function rearm() {
    const result = await sendMessage({ type: 'CA_ARM', host: location.host });
    if (!result || !result.ok) {
      ui.error = (result && result.error) || '无法开始记录，请回到扩展重试。';
      render();
      return;
    }
    ui.mode = 'recording';
    ui.report = null;
    ui.error = '';
    ui.collapsed = false;
    render();
    startPolling();
  }

  async function syncOverlay() {
    if (!isTopFrame()) return;
    const state = await readFlowState();
    if (!state.enabled) {
      unmountOverlay();
      return;
    }
    if (ui.mode === 'result' || ui.mode === 'unknown' || ui.mode === 'busy') return;
    if (!state.armed) {
      unmountOverlay();
      return;
    }
    mountOverlay();
    if (ui.mode !== 'recording') {
      ui.mode = 'recording';
      ui.collapsed = false;
      ui.count = 0;
      ui.error = '';
      render();
    }
    startPolling();
  }

  if (isTopFrame()) {
    loadOverlayStrings();
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.settings) {
          loadOverlayStrings();
          return;
        }
        if (!changes.sites && !changes.flows) return;
        syncOverlay().catch(() => {});
      });
    } catch {
      /* 忽略 */
    }

    const start = () => {
      syncOverlay().catch(() => {});
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
})();