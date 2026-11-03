/**
 * 后台 Service Worker 行为测试：用 chrome API mock 验证
 *  - 按站点启用：权限过滤、内容脚本注册（只注入精确 origin）、站点持久化
 *  - 分析：Cookie 读取、页面采集、报告生成、会话存储与元信息
 *  - 停用：permissions.remove、脚本注销、数据清理
 *  - 权限被外部撤销：站点标记为未授权并清理脚本
 *
 * 用法：node --test tests/background.test.mjs
 */

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

const HOST = '127.0.0.1:8080';
const URL = `http://${HOST}/app`;
const PATTERNS = [
  `http://${HOST}/*`,
  `https://${HOST}/*`,
  'http://127.0.0.1/*',
  'https://127.0.0.1/*',
];

function makeJwt(payload = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: 'demo-user',
    iss: 'https://demo-auth.example.com',
    exp: now + 3600,
    ...payload,
  })}.c2lnbmF0dXJl`;
}
const JWT = makeJwt();

function createChromeMock() {
  const local = {};
  const session = {};
  const registered = new Map();
  const granted = new Set(PATTERNS);
  const calls = [];
  const listeners = {
    message: [],
    installed: [],
    startup: [],
    permissionsRemoved: [],
    permissionsAdded: [],
    storageChanged: [],
    tabUpdated: [],
    tabActivated: [],
  };

  const chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test-extension-id/${String(path).replace(/^\//, '')}`,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => granted.has(origin)),
      remove: async ({ origins }) => {
        calls.push({ api: 'permissions.remove', origins: [...origins] });
        for (const origin of origins) granted.delete(origin);
        return true;
      },
      onAdded: { addListener: (fn) => listeners.permissionsAdded.push(fn) },
      onRemoved: { addListener: (fn) => listeners.permissionsRemoved.push(fn) },
    },
    storage: {
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) },
      local: {
        get: async (key) => (key in local ? { [key]: local[key] } : {}),
        set: async (value) => Object.assign(local, value),
      },
      session: {
        get: async (key) => (key in session ? { [key]: session[key] } : {}),
        set: async (value) => Object.assign(session, value),
      },
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids } = {}) =>
        [...registered.values()].filter((script) => !ids || ids.includes(script.id)),
      registerContentScripts: async (scripts) => {
        calls.push({ api: 'registerContentScripts', scripts });
        for (const script of scripts) registered.set(script.id, script);
      },
      unregisterContentScripts: async ({ ids }) => {
        calls.push({ api: 'unregisterContentScripts', ids: [...ids] });
        for (const id of ids) registered.delete(id);
      },
      executeScript: async () => {
        throw new Error('测试环境不执行页面注入');
      },
    },
    cookies: {
      getAll: async (filter) => {
        calls.push({ api: 'cookies.getAll', filter });
        return [
          {
            name: 'sid',
            value: 'sess-0123456789abcdef',
            domain: '127.0.0.1',
            path: '/',
            httpOnly: true,
            secure: false,
            session: true,
            sameSite: 'lax',
          },
          {
            name: 'csrftoken',
            value: 'csrf-token-abc123',
            domain: '127.0.0.1',
            path: '/',
            httpOnly: false,
            secure: false,
            session: true,
            sameSite: 'lax',
          },
        ];
      },
    },
    tabs: {
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
      onActivated: { addListener: (fn) => listeners.tabActivated.push(fn) },
      get: async (tabId) => ({ id: tabId, url: URL, title: 'Demo', status: 'complete' }),
      sendMessage: async () => ({
        ok: true,
        page: {
          url: URL,
          origin: `http://${HOST}`,
          title: 'Demo',
          referrer: '',
          path: '/app',
          loginPageLikely: false,
        },
        storage: { local: [{ key: 'access_token', value: JWT }], session: [] },
        requests: [
          {
            url: `http://${HOST}/api/me`,
            method: 'GET',
            status: 200,
            headers: { authorization: `Bearer ${JWT}`, 'x-csrf-token': 'csrf-token-abc123' },
            responseHeaders: {},
          },
        ],
        hints: { scriptSrcs: [], linkHrefs: [], meta: {}, cookieNames: ['csrftoken'], indexedDB: [] },
        meta: { hookReady: true },
      }),
      query: async () => [],
      reload: async () => {},
      create: async (options) => {
        calls.push({ api: 'tabs.create', url: options && options.url });
        return { id: 99 };
      },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setIcon: async () => {},
      setTitle: async () => {},
    },
  };

  return { chrome, local, session, registered, granted, calls, listeners };
}

// 图标以 imageData 形式设置：这里给一个最小的 OffscreenCanvas / createImageBitmap 实现
class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return {
      drawImage: () => {},
      getImageData: () => ({ width: this.width, height: this.height, data: new Uint8ClampedArray(this.width * this.height * 4) }),
    };
  }
}

let backgroundListeners = null;

before(async () => {
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  globalThis.createImageBitmap = async () => ({ width: 16, height: 16 });
  globalThis.fetch = async (url) => ({ blob: async () => ({ url }) });
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;
  await import('../src/background.js');
  backgroundListeners = mock.listeners;
  assert.equal(backgroundListeners.message.length, 1, '后台应只注册一个 onMessage 监听');
});

/** 每个用例使用独立的 chrome mock（background.js 在调用时才读取 globalThis.chrome）。 */
function useMock() {
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;
  mock.listeners = backgroundListeners;
  return mock;
}

function send(message, sender = {}) {
  return new Promise((resolve, reject) => {
    const handler = backgroundListeners.message[0];
    const timer = setTimeout(() => reject(new Error(`消息处理超时：${message.type}`)), 5000);
    const keep = handler(message, sender, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    if (keep !== true) reject(new Error('后台没有返回 true，异步响应不会被接收'));
  });
}

async function enable(mock) {
  return send({ type: 'CA_ENABLE_SITE', host: HOST, origin: `http://${HOST}`, patterns: PATTERNS, tabId: 7 });
}

// ---------------------------------------------------------------------------
// 启用
// ---------------------------------------------------------------------------
test('未启用且无权限时状态为空', async () => {
  const mock = useMock();
  mock.granted.clear();
  const state = await send({ type: 'CA_GET_STATE', host: HOST, origin: `http://${HOST}` });
  assert.equal(state.ok, true);
  assert.equal(state.enabled, false);
  assert.equal(state.granted, false);
  assert.equal(state.site, null);
  assert.equal(state.report, null);
});

test('已有权限但站点记录缺失时 granted=true、enabled=false', async () => {
  useMock();
  const state = await send({ type: 'CA_GET_STATE', host: HOST, origin: `http://${HOST}` });
  assert.equal(state.granted, true, '模拟“曾经授权但记录丢失”的场景');
  assert.equal(state.enabled, false);
  assert.deepEqual(state.grantedPatterns.sort(), [...PATTERNS].sort());
});

test('CA_ENABLE_SITE 注册 MAIN/ISOLATED 脚本并保存站点', async () => {
  const mock = useMock();
  const state = await enable(mock);

  assert.equal(state.ok, true);
  assert.equal(state.enabled, true);
  assert.equal(state.granted, true);
  assert.equal(state.site.host, HOST);
  assert.deepEqual(state.site.patterns, PATTERNS);

  const scripts = [...mock.registered.values()];
  assert.equal(scripts.length, 2);
  const hook = scripts.find((script) => script.world === 'MAIN');
  const collector = scripts.find((script) => script.world !== 'MAIN');
  assert.ok(hook, '应注册 MAIN world hook');
  assert.ok(collector, '应注册隔离世界 collector');
  assert.deepEqual(hook.matches, [`http://${HOST}/*`, `https://${HOST}/*`], '内容脚本只匹配精确 origin');
  assert.deepEqual(collector.matches, hook.matches);

  const { sites, flows } = mock.local;
  assert.ok(sites[HOST], '站点应写入 storage.local');
  assert.equal(sites[HOST].patterns.length, 4);
  assert.equal(flows[HOST].armed, true, '启用后自动进入记录状态');
});

test('没有权限时 CA_ENABLE_SITE 返回 NO_PERMISSION', async () => {
  const mock = useMock();
  mock.granted.clear();
  const state = await send({ type: 'CA_ENABLE_SITE', host: HOST, origin: `http://${HOST}`, patterns: PATTERNS });
  assert.equal(state.ok, false);
  assert.equal(state.code, 'NO_PERMISSION');
  assert.equal(mock.registered.size, 0);
});

// ---------------------------------------------------------------------------
// 分析
// ---------------------------------------------------------------------------
test('CA_ANALYZE 生成报告、写入会话存储并保存元信息', async () => {
  const mock = useMock();
  await enable(mock);

  const result = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST, origin: `http://${HOST}` });
  assert.equal(result.ok, true);

  const report = result.report;
  assert.equal(report.auth.mechanismId, 'bearer-token');
  assert.equal(report.auth.kind, 'bearer');
  assert.equal(report.auth.raw, JWT);
  assert.ok(report.headers.some((header) => header.name === 'Authorization'));
  assert.ok(report.headers.some((header) => header.name === 'Cookie'), '应同时携带会话 Cookie');
  assert.ok(report.headers.some((header) => /csrf/i.test(header.name)));
  assert.equal(report.copies.raw, JWT);
  assert.match(report.copies.prompt, /Authorization: Bearer /);
  assert.match(report.copies.prompt, /Cookie: sid=/);

  // 会话存储里有完整报告，本地存储只有元信息
  assert.ok(mock.session.reports[HOST], '报告应写入 storage.session');
  assert.ok(mock.local.reportMeta[HOST], '元信息应写入 storage.local');
  assert.equal(mock.local.reportMeta[HOST].mechanismId, 'bearer-token');
  assert.equal(JSON.stringify(mock.local.reportMeta).includes(JWT), false, '本地存储不应包含凭证');
  assert.equal(JSON.stringify(mock.local.sites).includes(JWT), false, '站点记录不应包含凭证');
  assert.equal(mock.local.flows[HOST].armed, false, '识别到凭证后自动停止记录');
  assert.equal(result.armed, false);
});

test('CA_ANALYZE 对未启用站点返回 NOT_ENABLED', async () => {
  useMock();
  const result = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_ENABLED');
});

test('CA_ANALYZE 在权限被撤销后返回 NO_PERMISSION', async () => {
  const mock = useMock();
  await enable(mock);
  mock.granted.clear();
  const result = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_PERMISSION');
});

test('CA_ANALYZE 在标签页地址变化时返回 TAB_CHANGED', async () => {
  const mock = useMock();
  await enable(mock);
  mock.chrome.tabs.get = async (tabId) => ({ id: tabId, url: 'https://other.example.com/', status: 'complete' });
  const result = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TAB_CHANGED');
});

// ---------------------------------------------------------------------------
// 停用 / 权限变化
// ---------------------------------------------------------------------------
test('CA_DISABLE_SITE 撤销权限、注销脚本并清理数据', async () => {
  const mock = useMock();
  await enable(mock);
  await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST });

  const result = await send({ type: 'CA_DISABLE_SITE', host: HOST, origin: `http://${HOST}` });
  assert.equal(result.ok, true, `停用应成功：${result.error || ''}`);
  assert.equal(result.site, null, '停用返回的结果里不应再有站点记录');
  assert.equal(result.enabled, false);

  const removal = mock.calls.find((call) => call.api === 'permissions.remove');
  assert.ok(removal, '应调用 chrome.permissions.remove');
  assert.deepEqual(removal.origins.sort(), [...PATTERNS].sort(), '应撤销该站点的全部 pattern');

  assert.equal(mock.registered.size, 0, '脚本应全部注销');
  assert.equal(mock.local.sites[HOST], undefined, '站点记录应删除');
  assert.equal(mock.local.reportMeta[HOST], undefined, '元信息应删除');
  assert.equal(mock.session.reports?.[HOST], undefined, '会话报告应删除');
  assert.equal(mock.local.flows[HOST], undefined, '记录状态应删除');

  const state = await send({ type: 'CA_GET_STATE', host: HOST, origin: `http://${HOST}` });
  assert.equal(state.enabled, false);
  assert.equal(state.site, null);
});

test('权限被外部撤销后站点标记为未授权并注销脚本', async () => {
  const mock = useMock();
  await enable(mock);

  mock.granted.clear();
  const handler = mock.listeners.permissionsRemoved[0];
  assert.ok(handler, '应监听 permissions.onRemoved');
  handler({ origins: ['http://127.0.0.1/*'] });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(mock.registered.size, 0, '脚本应注销');
  assert.equal(mock.local.sites[HOST].granted, false);
  assert.deepEqual(mock.local.sites[HOST].patterns, []);

  const state = await send({ type: 'CA_GET_STATE', host: HOST, origin: `http://${HOST}` });
  assert.equal(state.enabled, false);
  assert.equal(state.granted, false);
});

test('CA_PAGE_READY 用「带绿点的图标」标记已授权站点，不再用 ON 文字角标', async () => {
  const mock = useMock();
  const icons = [];
  const badges = [];
  mock.chrome.action.setIcon = async (options) => icons.push(options);
  mock.chrome.action.setBadgeText = async (options) => badges.push(options);

  await send({ type: 'CA_PAGE_READY', host: HOST }, { tab: { id: 7 } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(icons.length, 0, '未启用站点不应点亮图标');

  await enable(mock);
  icons.length = 0;
  badges.length = 0;
  await send({ type: 'CA_PAGE_READY', host: HOST }, { tab: { id: 7 } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const activeIcon = icons.find((item) => item.tabId === 7);
  assert.ok(activeIcon, '已启用站点应切换图标');
  assert.ok(activeIcon.imageData?.['16'], '应设置绿色状态图标（imageData 方式）', JSON.stringify(Object.keys(activeIcon)));
  assert.ok(
    badges.some((item) => item.tabId === 7 && item.text === ''),
    '不应再显示 ON 文字角标',
  );
});

// ---------------------------------------------------------------------------
// 记录状态（悬浮框）
// ---------------------------------------------------------------------------
test('未识别到凭证时保持记录状态，方便继续登录', async () => {
  const mock = useMock();
  await enable(mock);
  mock.chrome.cookies.getAll = async () => [];
  mock.chrome.tabs.sendMessage = async () => ({
    ok: true,
    page: { url: `http://${HOST}/app`, origin: `http://${HOST}`, title: '', referrer: '', path: '/app' },
    storage: { local: [], session: [] },
    requests: [],
    hints: {},
  });

  const result = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST });
  assert.equal(result.ok, true);
  assert.equal(result.report.auth.kind, 'none');
  assert.equal(result.armed, true, '没有凭证时保持记录');
  assert.equal(mock.local.flows[HOST].armed, true);
});

test('CA_DISARM / CA_ARM 控制记录状态', async () => {
  const mock = useMock();
  await enable(mock);

  const stopped = await send({ type: 'CA_DISARM', host: HOST });
  assert.equal(stopped.ok, true);
  assert.equal(mock.local.flows[HOST].armed, false);

  const stateAfterStop = await send({ type: 'CA_GET_STATE', host: HOST, origin: `http://${HOST}` });
  assert.equal(stateAfterStop.flow.armed, false);

  const started = await send({ type: 'CA_ARM', host: HOST, tabId: 7 });
  assert.equal(started.ok, true);
  assert.equal(mock.local.flows[HOST].armed, true);
  assert.equal(started.flow.armed, true);
});

test('CA_ARM 对未启用站点返回 NOT_ENABLED', async () => {
  const mock = useMock();
  mock.granted.clear();
  const result = await send({ type: 'CA_ARM', host: HOST });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_ENABLED');
});

test('CA_OPEN_REPORT 打开带 host 参数的报告页', async () => {
  const mock = useMock();
  const result = await send({ type: 'CA_OPEN_REPORT', host: HOST });
  assert.equal(result.ok, true);
  const call = mock.calls.find((item) => item.api === 'tabs.create');
  assert.ok(call, '应调用 chrome.tabs.create');
  assert.ok(call.url.includes('src/popup.html?host='), `实际 URL：${call.url}`);
  assert.ok(call.url.includes(encodeURIComponent(HOST)), 'URL 应带 host 参数');
});

test('停用后再分析返回 NOT_ENABLED', async () => {
  useMock();
  await enable();
  await send({ type: 'CA_DISABLE_SITE', host: HOST });
  const result = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_ENABLED');
});

test('停用后再启用（不刷新）可以成功，并重新进入记录状态', async () => {
  const mock = useMock();
  await enable(mock);
  await send({ type: 'CA_DISABLE_SITE', host: HOST, origin: `http://${HOST}` });

  // 真实使用时停用会撤销权限，再次启用由权限弹窗重新授予；这里模拟用户点了「允许」
  for (const pattern of PATTERNS) mock.granted.add(pattern);
  const again = await enable(mock);
  assert.equal(again.ok, true, `再次启用应成功：${again.error || ''}`);
  assert.equal(again.enabled, true);
  assert.equal(mock.local.flows[HOST].armed, true, '再次启用后应重新开始记录');
  assert.equal(mock.registered.size, 2, '内容脚本应重新注册');
});

test('旧版本已启用但没有记录状态时，读取状态会自动补上记录', async () => {
  const mock = useMock();
  await enable(mock);
  // 模拟旧版本数据：只有站点记录，没有 flows
  mock.local.flows = {};
  await mock.chrome.storage.local.set({ flows: {} });

  const state = await send({ type: 'CA_GET_STATE', host: HOST, origin: `http://${HOST}` });
  assert.equal(state.enabled, true);
  assert.equal(state.flow.armed, true, '应自动补上记录状态');
  assert.equal(mock.local.flows[HOST].armed, true);
});

test('CA_ENSURE_OVERLAY 在页面无响应时补注入采集脚本', async () => {
  const mock = useMock();
  await enable(mock);
  mock.calls.length = 0;
  let pinged = 0;
  mock.chrome.tabs.sendMessage = async () => {
    pinged += 1;
    // 第一次（未注入）失败，补注入后再 ping 成功
    if (pinged === 1) throw new Error('Receiving end does not exist');
    return { ok: true, overlay: true };
  };
  const injected = [];
  mock.chrome.scripting.executeScript = async (options) => {
    injected.push(options.files && options.files[0]);
    return [];
  };

  const result = await send({ type: 'CA_ENSURE_OVERLAY', host: HOST, tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.reachable, true, '补注入后应能连上页面');
  assert.ok(injected.includes('src/injected/collector.js'), '应补注入 collector');
});

// ---------------------------------------------------------------------------
// 高级自定义
// ---------------------------------------------------------------------------
test('CA_OPEN_CUSTOMIZE 打开自定义页面并带 host 参数', async () => {
  const mock = useMock();
  const result = await send({ type: 'CA_OPEN_CUSTOMIZE', host: HOST });
  assert.equal(result.ok, true);
  const call = mock.calls.find((item) => item.api === 'tabs.create');
  assert.ok(call, '应调用 chrome.tabs.create');
  assert.ok(call.url.includes('src/customize.html?host='), `实际 URL：${call.url}`);
  assert.ok(call.url.includes(encodeURIComponent(HOST)), 'URL 应带 host 参数');
});

test('CA_GET_CUSTOMIZE 返回候选与默认选择', async () => {
  useMock();
  await enable();
  const analyzed = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST, origin: `http://${HOST}` });
  assert.equal(analyzed.ok, true);

  const result = await send({ type: 'CA_GET_CUSTOMIZE', host: HOST });
  assert.equal(result.ok, true);
  assert.ok(result.candidates.some((item) => item.source === 'header' && item.name === 'Authorization'));
  assert.ok(result.candidates.some((item) => item.source === 'cookie' && item.name === 'sid'));
  assert.ok(result.selection.some((item) => item.source === 'header' && item.enabled));
});

test('CA_SAVE_CUSTOMIZE 生成自定义复制内容，并保留原始报告', async () => {
  useMock();
  await enable();
  const analyzed = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST, origin: `http://${HOST}` });
  assert.match(analyzed.report.copies.headers, /Authorization/);

  const { candidates } = await send({ type: 'CA_GET_CUSTOMIZE', host: HOST });
  const selection = candidates.map((item) => ({ ...item, enabled: item.source === 'cookie' }));
  const saved = await send({ type: 'CA_SAVE_CUSTOMIZE', host: HOST, selection });

  assert.equal(saved.ok, true);
  assert.match(saved.report.custom.copies.headers, /^Cookie: sid=/m);
  assert.ok(!saved.report.custom.copies.headers.includes('Authorization'), '自定义结果不再带 Authorization');
  assert.ok(!saved.report.custom.copies.prompt.includes('Authorization: Bearer'));
  assert.ok(saved.report.headers.some((header) => header.name === 'Authorization'), '原始报告保留，便于再次编辑');

  const state = await send({ type: 'CA_GET_STATE', host: HOST, origin: `http://${HOST}` });
  assert.ok(state.report.custom, '自定义结果应随报告返回');
  assert.ok(!state.report.custom.copies.headers.includes('Authorization'));
});

test('CA_SAVE_CUSTOMIZE 没有报告时返回 NO_REPORT', async () => {
  useMock();
  const result = await send({ type: 'CA_SAVE_CUSTOMIZE', host: HOST, selection: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_REPORT');
});

test('重新分析失败（登录态过期）会自动回到记录状态', async () => {
  const mock = useMock();
  await enable(mock);
  const first = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST, origin: `http://${HOST}` });
  assert.equal(first.ok, true);
  assert.equal(mock.local.flows[HOST].armed, false, '识别成功后停止记录');

  // 模拟登录态过期：没有任何 Cookie，也采不到请求
  mock.chrome.cookies.getAll = async () => [];
  mock.chrome.tabs.sendMessage = async () => ({
    ok: true,
    page: { url: `http://${HOST}/app`, origin: `http://${HOST}`, title: '', referrer: '', path: '/app' },
    storage: { local: [], session: [] },
    requests: [],
    hints: {},
  });

  const second = await send({ type: 'CA_ANALYZE', tabId: 7, host: HOST, origin: `http://${HOST}` });
  assert.equal(second.ok, true);
  assert.equal(second.report.auth.kind, 'none');
  assert.equal(mock.local.flows[HOST].armed, true, '失败后自动回到记录状态');
});

// ---------------------------------------------------------------------------
// 语言设置
// ---------------------------------------------------------------------------
test('CA_OVERLAY_STRINGS 跟随语言设置（悬浮框支持手动切换）', async () => {
  const mock = useMock();
  mock.local.settings = { language: 'en' };
  const english = await send({ type: 'CA_OVERLAY_STRINGS' });
  assert.equal(english.ok, true);
  assert.equal(english.locale, 'en');
  assert.equal(english.strings.overlayRecording, 'Recording your sign-in');
  assert.equal(english.strings.overlayRecordingCount, '$1 requests recorded');

  mock.local.settings = { language: 'zh' };
  const listener = mock.listeners.storageChanged[0];
  assert.ok(listener, '应监听 storage.onChanged');
  listener({ settings: { newValue: { language: 'zh' } } }, 'local');
  const chinese = await send({ type: 'CA_OVERLAY_STRINGS' });
  assert.equal(chinese.locale, 'zh');
  assert.equal(chinese.strings.overlayRecording, '正在记录登录过程');
});

test('页面加载完成时同步工具栏图标（未启用站点回到普通图标）', async () => {
  const mock = useMock();
  await enable(mock);
  const icons = [];
  mock.chrome.action.setIcon = async (options) => icons.push(options);
  const listener = mock.listeners.tabUpdated[0];
  assert.ok(listener, '应监听 tabs.onUpdated');

  listener(7, { status: 'complete' }, { id: 7, url: `http://${HOST}/app` });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(
    icons.some((item) => item.tabId === 7 && item.imageData),
    '已启用站点应显示绿色图标',
  );

  icons.length = 0;
  listener(8, { status: 'complete' }, { id: 8, url: 'https://other.example.com/x' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(
    icons.some((item) => item.tabId === 8 && item.imageData),
    '未启用站点应回到普通图标',
  );
});

test('图标切换失败时退回一个小绿点角标（不遮住图标）', async () => {
  const mock = useMock();
  mock.chrome.action.setIcon = async () => {
    throw new Error('Could not load action icon');
  };
  const badges = [];
  mock.chrome.action.setBadgeText = async (options) => badges.push(options.text);
  await enable(mock);
  assert.ok(badges.includes('●'), '应退回小绿点角标', JSON.stringify(badges));
  assert.ok(!badges.includes('ON'), '不应再使用 ON 文字角标');
});

test('已启用时把工具栏图标换成绿色版本，停用后换回蓝色（以 imageData 设置）', async () => {
  const mock = useMock();
  mock.chrome.tabs.query = async () => [{ id: 7, url: URL }];
  const icons = [];
  mock.chrome.action.setIcon = async (options) => icons.push(options);
  await enable(mock);

  const onIcon = icons.find((item) => item.tabId === 7);
  assert.ok(onIcon, '应设置图标');
  assert.ok(onIcon.imageData?.['16'], '应使用 imageData 方式设置图标', JSON.stringify(Object.keys(onIcon)));

  icons.length = 0;
  await send({ type: 'CA_DISABLE_SITE', host: HOST });
  assert.ok(
    icons.some((item) => item.imageData),
    '停用后应恢复普通图标',
  );
});
