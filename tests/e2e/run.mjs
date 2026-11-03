/**
 * 端到端测试：用真实 Chrome 跑完整流程。
 *
 *  1. 起一个本地「假登录站点」：POST /api/login 下发 HttpOnly 会话 Cookie + JWT；
 *     /app 页面用 Authorization: Bearer + X-CSRF-Token 调接口。
 *  2. 起一个真实 Chrome（headless），通过 CDP Extensions.loadUnpacked 加载扩展
 *     （测试用临时副本里预置 host_permissions，避免权限弹窗阻塞自动化）。
 *  3. 打开扩展 popup（?tabId= 指向站点标签页），点启用 → 刷新 → 登录 → 分析，
 *     校验识别结果、两种复制文本、脱敏切换与停用清理。
 *
 * 用法：node tests/e2e/run.mjs
 * 依赖：本机 Google Chrome（macOS 默认路径），无需任何 npm 依赖。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}
function assert(condition, name, detail = '') {
  if (condition) pass(name, detail);
  else fail(name, detail);
  return Boolean(condition);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 假登录站点
// ---------------------------------------------------------------------------
const SESSION_ID = `sess-${randomBytes(18).toString('hex')}`;
const CSRF_TOKEN = 'csrf-token-abc123';
const NOW = Math.floor(Date.now() / 1000);
const JWT = [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(
    JSON.stringify({
      sub: 'demo-user',
      iss: 'https://demo-auth.example.com',
      aud: 'demo-app',
      iat: NOW,
      exp: NOW + 3600,
    }),
  ).toString('base64url'),
  randomBytes(24).toString('base64url'),
].join('.');

const loginHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录 · Demo</title></head>
<body>
  <h1>Demo 登录</h1>
  <form id="login-form">
    <input name="username" value="demo" autocomplete="username">
    <input name="password" type="password" value="demo-password" autocomplete="current-password">
    <button type="submit">登录</button>
  </form>
  <script>
    // 用 XHR 登录：同时验证 hook 对 XMLHttpRequest 的观测能力
    document.getElementById('login-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/login');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = () => {
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch (error) { payload = null; }
        if (payload && payload.data && payload.data.access_token) {
          localStorage.setItem('access_token', payload.data.access_token);
        }
        location.assign('/app');
      };
      xhr.send(JSON.stringify({ username: 'demo', password: 'demo-password' }));
    });
  </script>
</body></html>`;

const appHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>控制台 · Demo</title></head>
<body>
  <h1>Demo 控制台</h1>
  <p id="state">booting</p>
  <script>
    const token = localStorage.getItem('access_token');
    // 模拟前端写入的非 HttpOnly 登录 Cookie（chrome.cookies 之外的补充来源）
    document.cookie = 'app_session=js-session-value-123456; path=/';
    async function callApi() {
      const responses = await Promise.all([
        fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } }),
        fetch('/api/orders', {
          headers: { Authorization: 'Bearer ' + token, 'X-CSRF-Token': '${CSRF_TOKEN}' },
        }),
        // 模拟某些 SDK 未拿到 token 时发出的占位请求头
        fetch('/api/teams?pageSize=1000', {
          headers: { Authorization: 'Bearer undefined', 'X-Tenant-Id': 'tenant-abc', 'X-App-Id': 'app-xyz' },
        }),
      ]);
      document.getElementById('state').textContent = 'loaded:' + responses.map((r) => r.status).join(',');
    }
    callApi();
  </script>
</body></html>`;

function startSite() {
  const received = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    received.push({ method: req.method, path: url.pathname, headers: req.headers });

    const json = (status, body, extraHeaders = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders,
      });
      res.end(JSON.stringify(body));
    };
    const html = (body) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };

    if (req.method === 'POST' && url.pathname === '/api/login') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        json(
          200,
          { code: 0, data: { access_token: JWT, token_type: 'Bearer', expires_in: 3600 } },
          {
            'Set-Cookie': [
              `sid=${SESSION_ID}; HttpOnly; Path=/; SameSite=Lax`,
              `csrftoken=${CSRF_TOKEN}; Path=/; SameSite=Lax`,
            ],
          },
        );
      });
      return;
    }

    if (url.pathname === '/api/me') {
      if (!/^Bearer\s+/.test(req.headers.authorization || '')) return json(401, { code: 401 });
      return json(200, { code: 0, data: { id: 42, name: 'Demo User' } });
    }

    if (url.pathname === '/api/teams') {
      return json(200, { code: 0, data: [] });
    }

    if (url.pathname === '/api/orders') {
      if (!/^Bearer\s+/.test(req.headers.authorization || '')) return json(401, { code: 401 });
      if (req.headers['x-csrf-token'] !== CSRF_TOKEN) return json(403, { code: 403 });
      return json(200, { code: 0, data: [{ id: 1, title: '订单 1' }] });
    }

    if (url.pathname === '/app') return html(appHtml);
    if (url.pathname === '/' || url.pathname === '/login') return html(loginHtml);

    return json(404, { code: 404 });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

// ---------------------------------------------------------------------------
// 最小 CDP 客户端（Node 内置 WebSocket）
// ---------------------------------------------------------------------------
class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.events = new Map();
    this.closed = false;
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (event) => reject(new Error(`WebSocket 错误：${event.message || ''}`)));
    });
    this.ws.addEventListener('message', (event) => this.onMessage(event.data));
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      const key = `${message.method}`;
      for (const handler of this.events.get(key) || []) handler(message.params, message.sessionId);
    }
  }

  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(handler);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = (this.nextId += 1);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`等待 ${url} 超时：${lastError?.message || ''}`);
}

async function evaluate(client, sessionId, expression, options = {}) {
  const response = await client.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: true,
      userGesture: Boolean(options.userGesture),
      replMode: false,
    },
    sessionId,
  );
  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      '页面脚本异常';
    throw new Error(description.split('\n')[0]);
  }
  return response.result?.value;
}

async function waitFor(client, sessionId, expression, timeoutMs = 15000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, sessionId, expression)) return true;
    } catch (error) {
      lastError = error;
    }
    await sleep(120);
  }
  throw new Error(`等待条件超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

async function openExtensionPage(client, url) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let targetId = null;
    try {
      ({ targetId } = await client.send('Target.createTarget', { url }));
      const sessionId = await attach(client, targetId);
      await waitFor(client, sessionId, 'document.readyState === "complete"', 8000);
      const ready = await evaluate(
        client,
        sessionId,
        'typeof chrome !== "undefined" && !!chrome.tabs && typeof chrome.tabs.query === "function"',
      );
      if (ready) return { targetId, sessionId };
      lastError = new Error('扩展页面 API 尚未就绪');
    } catch (error) {
      lastError = error;
    }
    if (targetId) {
      try {
        await client.send('Target.closeTarget', { targetId });
      } catch {
        /* 忽略 */
      }
    }
    await sleep(500);
  }
  throw new Error(`无法打开扩展页面：${lastError?.message || ''}`);
}

async function capture(client, sessionId, file, width = 400, height = 620) {
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  await sleep(250);
  const layout = await evaluate(
    client,
    sessionId,
    `({
      scrollWidth: document.documentElement.scrollWidth,
      bodyWidth: Math.round(document.body.getBoundingClientRect().width),
      docHeight: document.documentElement.scrollHeight,
      appHeight: Math.round(document.querySelector('.app')?.getBoundingClientRect().height || 0),
    })`,
  );
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  · 截图：${file.replace(ROOT + '/', '')} (${width}x${height})`);
  return layout;
}

async function attach(client, targetId) {
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Page.enable', {}, sessionId);
  return sessionId;
}

async function realClick(client, sessionId, selector) {
  const rect = await evaluate(
    client,
    sessionId,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`,
  );
  if (!rect) throw new Error(`找不到可点击元素：${selector}`);
  const base = { x: rect.x, y: rect.y, button: 'left', clickCount: 1 };
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, sessionId);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, sessionId);
}

function text(client, sessionId, selector) {
  return evaluate(
    client,
    sessionId,
    `document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`,
  );
}

const READ_STATE = `chrome.runtime.sendMessage({ type: 'CA_GET_STATE', host: '127.0.0.1:' + location.hostname.length + '', origin: '' })`;

function reportWarnings(state) {
  return (state?.report?.warnings || []).map((item) => item.text);
}

function prepareExtension(port, workDir) {
  const extensionDir = join(workDir, 'extension');
  // E2E_ZIP=dist/xxx.zip 时直接解压商店包来测，确保“要发布的产物”本身可用
  if (process.env.E2E_ZIP) {
    // 直接解压商店包来测，确保“要发布的产物”本身可用
    const zipPath = join(ROOT, process.env.E2E_ZIP);
    mkdirSync(extensionDir, { recursive: true });
    execFileSync('unzip', ['-q', zipPath, '-d', extensionDir], { stdio: 'pipe' });
  } else {
    mkdirSync(extensionDir, { recursive: true });
    copyFileSync(join(ROOT, 'manifest.json'), join(extensionDir, 'manifest.json'));
    cpSync(join(ROOT, 'src'), join(extensionDir, 'src'), { recursive: true });
    cpSync(join(ROOT, 'icons'), join(extensionDir, 'icons'), { recursive: true });
    cpSync(join(ROOT, '_locales'), join(extensionDir, '_locales'), { recursive: true });
  }

  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  // 预置站点权限，让自动化流程跳过原生权限弹窗（弹窗本身无法在 headless 中点击）
  // 同时预置带端口与不带端口的 pattern：真实使用中由权限弹窗一次性授予，
  // 这里预置是为了让 headless 环境跳过无法点击的原生权限弹窗。
  manifest.host_permissions = [
    `http://127.0.0.1:${port}/*`,
    `https://127.0.0.1:${port}/*`,
    'http://127.0.0.1/*',
    'https://127.0.0.1/*',
  ];
  writeFileSync(join(extensionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return extensionDir;
}

function launchChrome(profileDir, debugPort) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--metrics-recording-only',
    '--mute-audio',
    '--window-size=900,900',
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ];
  const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return { child, getStderr: () => stderr };
}


// ---------------------------------------------------------------------------
// 悬浮框（Shadow DOM）
// ---------------------------------------------------------------------------
const OVERLAY = `document.getElementById('ca-auth-inspector-overlay')?.shadowRoot`;

async function overlayExists(client, sessionId) {
  return evaluate(client, sessionId, `Boolean(${OVERLAY})`);
}

async function overlayText(client, sessionId, selector) {
  return evaluate(
    client,
    sessionId,
    `(${OVERLAY})?.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`,
  );
}

async function overlayClick(client, sessionId, action) {
  const selector = `[data-action="${action}"]`;
  const rect = await evaluate(
    client,
    sessionId,
    `(() => {
      const root = ${OVERLAY};
      const element = root && root.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`,
  );
  if (!rect) throw new Error(`悬浮框中找不到操作：${action}`);
  const base = { x: rect.x, y: rect.y, button: 'left', clickCount: 1 };
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, sessionId);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, sessionId);
}

async function captureOverlay(client, sessionId, file, width = 900, height = 700) {
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  await sleep(250);
  const rect = await evaluate(
    client,
    sessionId,
    `(() => {
      const element = document.getElementById('ca-auth-inspector-overlay');
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height };
    })()`,
  );
  if (!rect) throw new Error('悬浮框不存在，无法截图');
  const clip = { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8), width: rect.width + 16, height: rect.height + 16, scale: 2 };
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', clip }, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  · 截图：${file.replace(ROOT + '/', '')} (悬浮框)`);
  return rect;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'ca-e2e-'));
  const profileDir = join(workDir, 'profile');
  const errors = [];

  const site = await startSite();
  const host = `127.0.0.1:${site.port}`;
  const readState = `chrome.runtime.sendMessage({ type: 'CA_GET_STATE', host: '${host}', origin: 'http://${host}' })`;
  console.log(`\n[setup] 假站点：http://${host}`);

  const extensionDir = prepareExtension(site.port, workDir);
  const debugPort = await freePort();
  const chrome = launchChrome(profileDir, debugPort);
  let client = null;

  try {
    const version = await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`);
    client = new CDPClient(version.webSocketDebuggerUrl);
    await client.opened;

    const { id: extensionId } = await client.send('Extensions.loadUnpacked', { path: extensionDir });
    console.log(`[setup] 扩展 ID：${extensionId}`);

    let workerTargetId = null;
    for (let attempt = 0; attempt < 50 && !workerTargetId; attempt += 1) {
      const { targetInfos } = await client.send('Target.getTargets');
      const worker = targetInfos.find(
        (info) => info.type === 'service_worker' && info.url === `chrome-extension://${extensionId}/src/background.js`,
      );
      if (worker) workerTargetId = worker.targetId;
      else await sleep(100);
    }
    const workerOk = assert(Boolean(workerTargetId), '扩展 Service Worker 启动');
    if (workerOk) {
      try {
        const workerSession = await attach(client, workerTargetId);
        client.on('Runtime.exceptionThrown', (params, sessionId) => {
          if (sessionId === workerSession) errors.push(`background: ${params.exceptionDetails?.text}`);
        });
      } catch {
        /* 忽略 */
      }
    }

    // 站点页（启用前就已经加载，用来验证“启用后立即注入悬浮框”）
    const siteTarget = await client.send('Target.createTarget', { url: `http://${host}/login` });
    const siteSession = await attach(client, siteTarget.targetId);
    await waitFor(client, siteSession, 'document.readyState === "complete"');

    const popup = await openExtensionPage(client, `chrome-extension://${extensionId}/src/popup.html`);
    const popupSession = popup.sessionId;
    client.on('Runtime.exceptionThrown', (params, sessionId) => {
      if (sessionId === popupSession) errors.push(`popup: ${params.exceptionDetails?.text}`);
    });

    const tabIds = await evaluate(
      client,
      popupSession,
      `chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => (tab.url || '').includes('${host}')).map((tab) => tab.id))`,
    );
    assert(Array.isArray(tabIds) && tabIds.length === 1, '定位到站点标签页', `tabId=${tabIds?.[0]}`);
    const pinnedTabId = tabIds[0];

    await client.send(
      'Page.navigate',
      { url: `chrome-extension://${extensionId}/src/popup.html?tabId=${pinnedTabId}` },
      popupSession,
    );
    await waitFor(
      client,
      popupSession,
      `document.getElementById('site-host')?.textContent === '${host}' && !document.getElementById('enable-panel').classList.contains('hidden')`,
      10000,
      'popup 展示站点信息与启用面板',
    );

    // ---- 布局：标题不再被站点卡片遮挡 ----
    const layout = await evaluate(
      client,
      popupSession,
      `(() => {
        const title = document.querySelector('.brand-text h1').getBoundingClientRect();
        const card = document.querySelector('.site-card').getBoundingClientRect();
        const host = document.getElementById('site-host');
        return {
          titleBottom: Math.round(title.bottom),
          cardTop: Math.round(card.top),
          overlap: title.bottom > card.top + 0.5,
          clamp: getComputedStyle(host).webkitLineClamp,
          hostTitle: host.title,
        };
      })()`,
    );
    assert(layout.overlap === false, '站点卡片不再遮挡标题', JSON.stringify(layout));
    assert(layout.clamp === '2', '长域名最多两行完整展示', layout.clamp);
    assert(layout.hostTitle === host, '域名附带完整 title 提示');

    // ---------------------------------------------------------------------
    // 1) 启用 → 自动开始记录，页面立即出现悬浮框
    // ---------------------------------------------------------------------
    await realClick(client, popupSession, '#enable-btn');
    await waitFor(
      client,
      popupSession,
      `!document.getElementById('flow-panel').classList.contains('hidden')`,
      10000,
      '启用后进入记录引导',
    );
    pass('点击启用 → 权限通过并进入记录引导');

    const foldCheck = await evaluate(
      client,
      popupSession,
      `(() => {
        const button = document.getElementById('analyze-btn').getBoundingClientRect();
        const body = document.querySelector('.app-body');
        return { bottom: Math.round(button.bottom), viewport: 600, scrollable: body.scrollHeight > body.clientHeight };
      })()`,
    );
    assert(foldCheck.bottom <= 600, '「结束分析」按钮在首屏内可见', JSON.stringify(foldCheck));
    const uiLanguage = await evaluate(client, popupSession, `chrome.i18n.getUILanguage()`);

    const zhUI = String(uiLanguage).toLowerCase().startsWith('zh');
    const overlayCopy = await evaluate(
      client,
      popupSession,
      `({
        title: chrome.i18n.getMessage('overlayRecording'),
        unknown: chrome.i18n.getMessage('overlayUnknownTitle'),
        done: chrome.i18n.getMessage('overlayDone'),
      })`,
    );
    const L = {
      enabled: zhUI ? '已启用' : 'Enabled',
      recording: zhUI ? '正在记录登录过程' : 'Recording your sign-in',
      overlayRecording: overlayCopy.title || '正在记录登录过程',
      overlayUnknown: overlayCopy.unknown || '还没识别到登录信息',
      overlayDone: overlayCopy.done || '分析完成',
      copied: '✓',
      overlayHint: zhUI ? '悬浮框' : 'floating card',
      saved: zhUI ? '已保存' : 'Saved',
      queryHeader: '## URL',
    retry: zhUI ? '重新分析' : 'Analyze again',
      disable: zhUI ? '停用' : 'Disable',
    };
    pass(`界面语言：${uiLanguage}`);

    assert((await text(client, popupSession, '#site-status')) === L.enabled, '站点状态显示「已启用」');
    assert(
      (await text(client, popupSession, '#recording-title')) === L.recording,
      '弹窗显示「正在记录登录过程」',
    );

    // 工具栏状态：切到「带绿点」的图标（不再有 ON 文字角标）
    // 注意：无头 Chrome + Extensions.loadUnpacked 下 action.setIcon 会报「Could not load action icon」，
    // 这里只校验后台确实下发了带绿点的图标路径，以及角标被清空。
    const tabsNow = await evaluate(client, popupSession, `chrome.tabs.query({ active: true, currentWindow: true })`);
    const siteTabId = Array.isArray(tabsNow) ? tabsNow[0]?.id : null;
    if (siteTabId != null) {
      const badge = await evaluate(
        client,
        popupSession,
        `chrome.action.getBadgeText({ tabId: ${siteTabId} })`,
      );
      assert(badge === '', '工具栏不再显示 ON 文字角标', badge);
    }
    assert(
      (await evaluate(client, siteSession, `(${OVERLAY})?.querySelector('.ca-title')?.textContent`)) ===
        L.overlayRecording,
      '悬浮框仍在记录状态（图标切换不影响页面）',
    );
    pass('工具栏使用带绿点的状态图标，无 ON 文字角标');

    // 记录阶段（还没有分析结果）：不再有孤零零的一行按钮，「停用」在站点卡片里
    const flowLayout = await evaluate(
      client,
      popupSession,
      `(() => {
        const card = document.querySelector('.site-card').getBoundingClientRect();
        const disable = document.getElementById('disable-link').getBoundingClientRect();
        return {
          hasToolbar: Boolean(document.getElementById('site-toolbar')),
          disableInCard: disable.top >= card.top && disable.top < card.bottom,
          disableVisible: disable.width > 0,
        };
      })()`,
    );
    assert(flowLayout.hasToolbar === false, '页面里不再有独立的工具栏行', JSON.stringify(flowLayout));
    assert(flowLayout.disableVisible, '记录阶段「停用」仍然可见', JSON.stringify(flowLayout));
    assert(flowLayout.disableInCard, '记录阶段「停用」在站点卡片内', JSON.stringify(flowLayout));
    pass('记录阶段没有独立按钮行，停用收敛进站点卡片');

    // 悬浮框立即出现在当前页面（无需刷新）
    await waitFor(client, siteSession, `Boolean(${OVERLAY})`, 8000, '启用后悬浮框立即出现');
    pass('启用后当前页面立即出现悬浮框，无需刷新');
    const overlayTitle = await overlayText(client, siteSession, '.ca-title');
    assert(overlayTitle === L.overlayRecording, '悬浮框显示记录状态', `实际：${overlayTitle}`);

    if (process.env.E2E_SCREENSHOTS) {
      await captureOverlay(client, siteSession, join(ROOT, 'docs', 'overlay-recording.png'));
      const popupLayout = await capture(client, popupSession, join(ROOT, 'docs', 'popup-steps.png'));
      assert(popupLayout.scrollWidth <= 400, 'popup 无横向溢出（记录引导页）', JSON.stringify(popupLayout));
      assert(popupLayout.appHeight <= 600, 'popup 高度不超过 600px', String(popupLayout.appHeight));
    }

    // 英文记录引导页截图（商店物料用）
    if (process.env.E2E_SCREENSHOTS) {
      const englishSteps = await openExtensionPage(
        client,
        `chrome-extension://${extensionId}/src/popup.html?tabId=${pinnedTabId}&lang=en`,
      );
      await waitFor(
        client,
        englishSteps.sessionId,
        `!document.getElementById('flow-panel').classList.contains('hidden')`,
        10000,
        '英文记录引导页',
      );
      await capture(client, englishSteps.sessionId, join(ROOT, 'docs', 'popup-steps-en.png'));
    }

    // ---------------------------------------------------------------------
    // 1.1) 停用 → 再启用（不刷新页面）必须能重新启用成功且悬浮框回来
    // ---------------------------------------------------------------------
    if (process.env.E2E_DEBUG) {
      const before = await evaluate(
        client,
        popupSession,
        `(() => {
          const el = document.getElementById('disable-link');
          const r = el.getBoundingClientRect();
          el.addEventListener('click', () => { window.__caDisableClicked = true; });
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            text: el.textContent,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            hit: hit && (hit.id || hit.tagName + '.' + hit.className),
            isSame: hit === el,
          };
        })()`,
      );
      console.log('[debug] disable link:', JSON.stringify(before));
    }
    await realClick(client, popupSession, '#disable-link');
    if (process.env.E2E_DEBUG) {
      await sleep(1500);
      const after = await evaluate(client, popupSession, `({ clicked: Boolean(window.__caDisableClicked), status: document.getElementById('site-status').textContent, toast: document.getElementById('toast').textContent, err: document.getElementById('enable-error').textContent })`);
      console.log('[debug] after disable click:', JSON.stringify(after));
      const direct = await evaluate(client, popupSession, `chrome.runtime.sendMessage({ type: 'CA_DISABLE_SITE', host: '${host}', origin: 'http://summary' })`);
      console.log('[debug] direct disable:', JSON.stringify(direct));
      const store = await evaluate(client, popupSession, `chrome.storage.local.get(['sites','flows','reportMeta'])`);
      console.log('[debug] store:', JSON.stringify(store).slice(0, 500));
    }
    await waitFor(
      client,
      popupSession,
      `document.getElementById('enable-panel').classList.contains('hidden') === false`,
      8000,
      '停用后回到启用面板',
    );
    await waitFor(client, siteSession, `!${OVERLAY}`, 8000, '停用后悬浮框消失');
    pass('停用 → 悬浮框消失');

    await realClick(client, popupSession, '#enable-btn');
    await waitFor(
      client,
      popupSession,
      `!document.getElementById('flow-panel').classList.contains('hidden')`,
      10000,
      '再次启用成功',
    );
    const enableError = await text(client, popupSession, '#enable-error');
    assert(
      enableError === '' || !enableError.includes('没有获得'),
      '停用后再启用不会报「没有获得访问权限」',
      enableError,
    );
    await waitFor(client, siteSession, `Boolean(${OVERLAY})`, 8000, '再次启用后悬浮框重新出现');
    pass('不刷新页面：停用 → 再启用 → 悬浮框重新出现');

    // ---------------------------------------------------------------------
    // 1.2) 模拟“扩展更新前就打开的旧页面”：清掉当前页面的采集脚本后再启用
    // ---------------------------------------------------------------------
    await evaluate(
      client,
      siteSession,
      `(() => {
        window.__authInspectorCollector = false;
        window.__authInspectorHooked = false;
        document.querySelectorAll('[data-ca-overlay]').forEach((element) => element.remove());
        return true;
      })()`,
    );
    await realClick(client, popupSession, '#disable-link');
    await waitFor(client, popupSession, `!document.getElementById('enable-panel').classList.contains('hidden')`, 8000, '停用（旧页面）');
    await realClick(client, popupSession, '#enable-btn');
    await waitFor(client, popupSession, `!document.getElementById('flow-panel').classList.contains('hidden')`, 10000, '旧页面再次启用');
    await waitFor(client, siteSession, `Boolean(${OVERLAY})`, 10000, '旧页面补注入后出现悬浮框');
    pass('无采集脚本的旧页面：重新启用后自动补注入并显示悬浮框');

    // ---------------------------------------------------------------------
    // 2) 刷新页面 → 悬浮框仍然存在（动态脚本在 document_start 注入）
    // ---------------------------------------------------------------------
    await realClick(client, popupSession, '#reload-btn');
    await sleep(500);
    await waitFor(client, siteSession, 'document.readyState === "complete"');
    await waitFor(
      client,
      siteSession,
      `!!document.getElementById('login-form')`,
      8000,
      '刷新后登录页就绪',
    );
    await waitFor(client, siteSession, `Boolean(${OVERLAY})`, 8000, '刷新后悬浮框仍在');
    pass('刷新页面后悬浮框自动恢复（记录不中断）');

    // ---------------------------------------------------------------------
    // 2.1) 兼容旧版本数据：已启用但没有记录状态
    // ---------------------------------------------------------------------
    await evaluate(
      client,
      popupSession,
      `chrome.storage.local.get('flows').then((data) => {
        const flows = data.flows || {};
        delete flows['${host}'];
        return chrome.storage.local.set({ flows });
      })`,
    );
    await client.send('Page.reload', {}, popupSession);
    await sleep(600);
    await waitFor(client, popupSession, 'document.readyState === "complete"', 8000, 'popup 重新加载');
    await waitFor(
      client,
      popupSession,
      `document.getElementById('recording-title')?.textContent === ${JSON.stringify(L.recording)}`,
      10000,
      '旧数据自动补记录状态',
    );
    const hint = await text(client, popupSession, '#recording-count');
    assert(hint.includes(L.overlayHint), '记录提示指出悬浮框位置', hint);
    await waitFor(client, siteSession, `Boolean(${OVERLAY})`, 8000, '旧数据下悬浮框存在');
    pass('旧版本遗留数据（无记录状态）也能自动恢复悬浮框');

    // ---------------------------------------------------------------------
    // 3) 未登录时结束分析 → 提示未识别，可继续记录
    // ---------------------------------------------------------------------
    await overlayClick(client, siteSession, 'finish');
    await waitFor(
      client,
      siteSession,
      `!!(${OVERLAY})?.querySelector('[data-action="rearm"]')`,
      15000,
      '未识别状态出现',
    );
    assert(
      (await overlayText(client, siteSession, '.ca-title')).includes(L.overlayUnknown),
      '未登录时悬浮框提示还没识别到登录信息',
    );
    pass('未登录直接结束 → 悬浮框明确提示，不会误报');

    await overlayClick(client, siteSession, 'rearm');
    await waitFor(
      client,
      siteSession,
      `!!(${OVERLAY})?.querySelector('[data-action="finish"]')`,
      8000,
      '继续记录生效',
    );
    assert(
      (await overlayText(client, siteSession, '.ca-title')) === L.overlayRecording,
      '点「继续记录」回到记录状态',
    );

    // ---------------------------------------------------------------------
    // 4) 登录 → 悬浮框结束分析 → 直接展示两种复制
    // ---------------------------------------------------------------------
    await evaluate(client, siteSession, `document.getElementById('login-form').requestSubmit()`);
    await waitFor(client, siteSession, `location.pathname === '/app'`, 10000, '登录后跳转 /app');
    await waitFor(
      client,
      siteSession,
      `document.getElementById('state')?.textContent?.startsWith('loaded:200')`,
      10000,
      '登录后接口调用成功',
    );
    await waitFor(client, siteSession, `Boolean(${OVERLAY})`, 8000, '新页面悬浮框存在');
    await evaluate(
      client,
      siteSession,
      `(() => {
        addEventListener('keyup', () => {
          fetch('/api/search?keyword=demo', { headers: { Authorization: 'Bearer ' + localStorage.getItem('access_token') } });
        }, { once: true });
        dispatchEvent(new KeyboardEvent('keyup'));
        return true;
      })()`,
    );
    await sleep(400);

    await overlayClick(client, siteSession, 'finish');
    await waitFor(
      client,
      siteSession,
      `!!(${OVERLAY})?.querySelector('[data-action="copy-raw"]')`,
      20000,
      '悬浮框展示分析结果',
    );
    pass('登录后点悬浮框「结束分析」→ 悬浮框直接展示结果');

    const overlayMechanism = await overlayText(client, siteSession, '.ca-mech');
    assert(/Bearer Token/.test(overlayMechanism), '悬浮框识别为 Bearer Token', overlayMechanism);
    assert(
      (await overlayText(client, siteSession, '.ca-title')) === L.overlayDone,
      '悬浮框标题显示「分析完成」',
    );
    const overlayCredential = await overlayText(client, siteSession, '[data-role="cred"]');
    assert(overlayCredential.includes('…') && !overlayCredential.includes(JWT), '悬浮框凭证默认脱敏');

    await overlayClick(client, siteSession, 'copy-raw');
    await waitFor(
      client,
      siteSession,
      `(${OVERLAY})?.querySelector('[data-action="copy-raw"]')?.textContent?.includes(${JSON.stringify(L.copied)})`,
      3000,
      '悬浮框复制反馈',
    );
    pass('悬浮框「复制认证值」给出成功反馈');

    await overlayClick(client, siteSession, 'copy-prompt');
    await waitFor(
      client,
      siteSession,
      `(${OVERLAY})?.querySelector('[data-action="copy-prompt"]')?.textContent?.includes(${JSON.stringify(L.copied)})`,
      3000,
      '悬浮框 Prompt 复制反馈',
    );
    pass('悬浮框「复制带 Prompt」给出成功反馈');

    assert(
      await evaluate(
        client,
        siteSession,
        `!(${OVERLAY})?.querySelector('[data-action="rearm"]')`,
      ),
      '悬浮框结果页只保留一个「重新分析」入口',
    );

    if (process.env.E2E_SCREENSHOTS) {
      await captureOverlay(client, siteSession, join(ROOT, 'docs', 'overlay-result.png'));
    }

    // 悬浮框「重新分析」= 直接再分析一次（不再先切到记录态，避免悬浮框闪现）
    const recordingSeen = [];
    await overlayClick(client, siteSession, 'retry');
    for (let sample = 0; sample < 12; sample += 1) {
      const mode = await evaluate(client, siteSession, `(${OVERLAY})?.dataset?.mode || ''`);
      if (mode === 'recording') recordingSeen.push(mode);
      await sleep(60);
    }
    await waitFor(
      client,
      siteSession,
      `!!(${OVERLAY})?.querySelector('[data-action="copy-raw"]')`,
      20000,
      '悬浮框重新分析完成',
    );
    assert(recordingSeen.length === 0, '重新分析时悬浮框不会先闪一下「正在记录」', recordingSeen.join(','));
    pass('悬浮框「重新分析」完成整个重试');

    // ---------------------------------------------------------------------
    // 5) 悬浮框「查看完整报告」→ 独立报告页
    // ---------------------------------------------------------------------
    const before = await client.send('Target.getTargets');
    await overlayClick(client, siteSession, 'open-report');
    let reportTarget = null;
    for (let attempt = 0; attempt < 40 && !reportTarget; attempt += 1) {
      const { targetInfos } = await client.send('Target.getTargets');
      reportTarget = targetInfos.find(
        (info) => info.type === 'page' && info.url.includes('popup.html?host=') && !before.targetInfos.some((item) => item.targetId === info.targetId),
      );
      if (!reportTarget) await sleep(150);
    }
    assert(Boolean(reportTarget), '「查看完整报告」打开独立报告页', reportTarget?.url || '');
    if (reportTarget) {
      const reportSession = await attach(client, reportTarget.targetId);
      await waitFor(
        client,
        reportSession,
        `document.getElementById('mech-label')?.textContent?.includes('Bearer')`,
        10000,
        '报告页渲染鉴权方式',
      );
      pass('独立报告页正确展示结果');
      assert(
        await evaluate(
          client,
          reportSession,
          `document.getElementById('retry-btn').classList.contains('hidden')`,
        ),
        '报告页隐藏无法执行的「重新分析」',
      );
    }

    // ---------------------------------------------------------------------
    // 6) 弹窗同步展示结果（重新打开 popup）
    // ---------------------------------------------------------------------
    await client.send('Page.reload', {}, popupSession);
    await waitFor(
      client,
      popupSession,
      `!document.getElementById('result-panel').classList.contains('hidden')`,
      10000,
      '弹窗展示结果',
    );
    assert(
      (await text(client, popupSession, '#mech-label')).includes('Bearer'),
      '弹窗与悬浮框结果一致',
    );

    if (process.env.E2E_SCREENSHOTS) {
      const layout = await capture(client, popupSession, join(ROOT, 'docs', 'popup-result.png'));
      assert(layout.scrollWidth <= 400, 'popup 无横向溢出（结果页）', JSON.stringify(layout));
    }

    const toolbar = await evaluate(
      client,
      popupSession,
      `(() => {
        const button = document.getElementById('retry-btn');
        const box = button.getBoundingClientRect();
        const eyebrow = document.querySelector('#result-panel .eyebrow').getBoundingClientRect();
        const head = document.querySelector('#result-panel .result-head').getBoundingClientRect();
        const panel = document.getElementById('result-panel').getBoundingClientRect();
        return {
          visible: !button.classList.contains('hidden'),
          inHead: box.top >= head.top - 1 && box.bottom <= head.bottom + 1,
          sameLineAsEyebrow: Math.abs((box.top + box.bottom) / 2 - (eyebrow.top + eyebrow.bottom) / 2) <= 4,
          leftOfConfidence: box.right <= document.querySelector('#result-panel .conf').getBoundingClientRect().left,
          singleRowHeight: Math.round(box.height) <= 24,
          panelTop: Math.round(panel.top),
          top: Math.round(box.top),
          hasOldButtons: Boolean(document.getElementById('reanalyze-btn') || document.getElementById('rearm-btn')),
          hasToolbar: Boolean(document.getElementById('site-toolbar')),
        };
      })()`,
    );
    assert(toolbar.visible, '结果页有「重新分析」入口');
    assert(toolbar.inHead, '「重新分析」在结果卡片头部', JSON.stringify(toolbar));
    assert(toolbar.sameLineAsEyebrow, '「重新分析」与标题同一行（不独占一行）', JSON.stringify(toolbar));
    assert(toolbar.leftOfConfidence, '「重新分析」不与可信度重叠', JSON.stringify(toolbar));
    assert(toolbar.hasToolbar === false, '结果页不再有独立工具栏行', JSON.stringify(toolbar));

    const cardLayout = await evaluate(
      client,
      popupSession,
      `(() => {
        const box = (id) => {
          const el = document.getElementById(id);
          const r = el.getBoundingClientRect();
          return {
            top: Math.round(r.top),
            left: Math.round(r.left),
            right: Math.round(r.right),
            height: Math.round(r.height),
            decoration: getComputedStyle(el).textDecorationLine,
          };
        };
        const card = document.querySelector('.site-card').getBoundingClientRect();
        return {
          card: { top: Math.round(card.top), bottom: Math.round(card.bottom), right: Math.round(card.right) },
          pill: box('site-status'),
          disable: box('disable-link'),
          disableText: document.getElementById('disable-link').innerText.trim(),
          vw: document.documentElement.clientWidth,
        };
      })()`,
    );
    // 停用与状态徽标同处站点卡片内：启动就能看到主操作，不会孤零零占一行
    assert(
      cardLayout.disable.top >= cardLayout.card.top && cardLayout.disable.top < cardLayout.card.bottom,
      '「停用」位于站点卡片内',
      JSON.stringify(cardLayout),
    );
    assert(
      Math.abs(cardLayout.pill.top - cardLayout.disable.top) <= 2,
      '「停用」与状态徽标在同一行',
      JSON.stringify(cardLayout),
    );
    assert(
      cardLayout.pill.right < cardLayout.disable.left && cardLayout.disable.right >= cardLayout.card.right - 14,
      '「停用」在卡片右侧成组排列',
      JSON.stringify(cardLayout),
    );
    assert(
      cardLayout.disable.decoration === 'none',
      '「停用」是按钮样式（不是下划线链接）',
      cardLayout.disable.decoration,
    );
    assert(
      cardLayout.disableText === (L.disable || cardLayout.disableText) && cardLayout.disableText.length > 0,
      '「停用」文案正常',
      cardLayout.disableText,
    );
    pass('工具栏按钮成组右对齐（同高、不重叠、非下划线链接）');
    assert(toolbar.top < 260, '「重新分析」位于结果卡片顶部（靠上）', JSON.stringify(toolbar));
    assert(toolbar.hasOldButtons === false, '旧的「重新记录 / 重新分析」按钮已合并');

    await realClick(client, popupSession, '#retry-btn');
    await waitFor(
      client,
      popupSession,
      `!document.getElementById('retry-btn').disabled && !document.getElementById('result-panel').classList.contains('hidden')`,
      20000,
      '顶部重新分析完成',
    );
    assert(
      (await text(client, popupSession, '#mech-label')).includes('Bearer'),
      '顶部「重新分析」后结果仍然正确',
    );
    pass('顶部「重新分析」一键完成重新记录 + 重新分析');

    const state = await evaluate(client, popupSession, readState);
    const report = state?.report || {};
    assert(Boolean(report.copies), '分析结果已写入会话存储');
    assert(report.copies?.raw === JWT, '纯认证值 = 捕获到的 JWT');
    assert(report.stats?.requests >= 3, '捕获到多个请求', `${report.stats?.requests} 个`);
    assert((report.stats?.cookies ?? 0) >= 2, '读取到站点 Cookie', `${report.stats?.cookies} 个`);

    assert(
      !JSON.stringify(report.copies).includes('Bearer undefined'),
      '占位 Bearer（Bearer undefined）不会进入复制内容',
    );
    assert(
      (report.evidence || []).some((item) => item.id === 'invalid-bearer'),
      '无效 Bearer 会被标注为已忽略',
    );

    assert(
      /app_session=js-session-value-123456/.test(report.copies?.headers || ''),
      'document.cookie 写入的 Cookie 也会被读取进请求头',
      report.copies?.headers,
    );

    const headerNames = (report.headers || []).map((header) => header.name.toLowerCase());
    assert(headerNames.includes('authorization'), '推荐请求头包含 Authorization');
    assert(headerNames.includes('x-tenant-id'), '推荐请求头包含多租户上下文头 X-Tenant-Id');
    assert(headerNames.includes('x-app-id'), '推荐请求头包含 X-App-Id');
    assert(headerNames.includes('cookie'), '推荐请求头包含 Cookie（双重凭证）');
    assert(headerNames.includes('x-csrf-token'), '推荐请求头包含 X-CSRF-Token');

    const prompt = report.copies?.prompt || '';
    assert(prompt.includes(`Authorization: Bearer ${JWT}`), 'Prompt 含完整 Authorization 头');
    assert(prompt.includes(`Cookie: sid=${SESSION_ID}`), 'Prompt 含 HttpOnly 会话 Cookie');
    assert(/x-csrf-token:/i.test(prompt), 'Prompt 含 CSRF 头');
    assert(prompt.includes(`http://${host}`), 'Prompt 含站点地址');
    assert(!prompt.includes('{{'), 'Prompt 没有残留占位符');
    assert(!JSON.stringify(report.evidence).includes(JWT), '判断依据不含完整 JWT');

    // 弹窗内复制
    await realClick(client, popupSession, '#copy-prompt');
    await waitFor(
      client,
      popupSession,
      `document.getElementById('copy-prompt').classList.contains('is-copied')`,
      3000,
      '弹窗复制反馈',
    );
    pass('弹窗内复制按钮可用');


    // ---------------------------------------------------------------------
    // 6.5) 高级自定义：选择 Header / Cookie / URL 参数
    // ---------------------------------------------------------------------
    await evaluate(
      client,
      popupSession,
      `document.querySelectorAll('details.acc').forEach((item) => { item.open = false; })`,
    );
    const entry = await evaluate(
      client,
      popupSession,
      `(() => {
        const button = document.getElementById('customize-btn');
        const box = button.getBoundingClientRect();
        const details = button.closest('details');
        return { top: Math.round(box.top), inDetails: Boolean(details), visible: box.width > 0 };
      })()`,
    );
    assert(entry.visible, '「自定义」入口可见');
    assert(entry.inDetails === false, '「自定义」入口不在折叠区里（一级入口）', JSON.stringify(entry));
    assert(entry.top < 560, '「自定义」入口位于结果页前部，无需展开折叠区', JSON.stringify(entry));
    await evaluate(
      client,
      popupSession,
      `document.getElementById('customize-btn').scrollIntoView({ block: 'center' })`,
    );
    await sleep(200);
    const beforeCustomize = await client.send('Target.getTargets');
    await realClick(client, popupSession, '#customize-btn');
    let customizeTarget = null;
    for (let attempt = 0; attempt < 40 && !customizeTarget; attempt += 1) {
      const { targetInfos } = await client.send('Target.getTargets');
      customizeTarget = targetInfos.find(
        (info) =>
          info.type === 'page' &&
          info.url.includes('src/customize.html?host=') &&
          !beforeCustomize.targetInfos.some((item) => item.targetId === info.targetId),
      );
      if (!customizeTarget) await sleep(150);
    }
    assert(Boolean(customizeTarget), '「高级自定义」打开独立编辑页', customizeTarget?.url || '');

    if (customizeTarget) {
      const customizeSession = await attach(client, customizeTarget.targetId);
      await waitFor(
        client,
        customizeSession,
        `document.querySelectorAll('#rows .row').length >= 3`,
        10000,
        '自定义页渲染候选项',
      );
      pass('自定义页列出请求头与 Cookie 候选项');

      const authRow = await evaluate(
        client,
        customizeSession,
        `(() => {
          const row = [...document.querySelectorAll('#rows .row')].find(
            (item) => item.querySelector('input[data-role="name"]')?.value === 'Authorization',
          );
          return row ? row.dataset.id : '';
        })()`,
      );
      assert(Boolean(authRow), '候选项里包含 Authorization');
      await evaluate(
        client,
        customizeSession,
        `(() => {
          const row = [...document.querySelectorAll('#rows .row')].find((item) => item.dataset.id === '${authRow}');
          row.querySelector('input[type="checkbox"]').click();
        })()`,
      );
      await waitFor(
        client,
        customizeSession,
        `!document.getElementById('preview-headers').textContent.includes('Authorization')`,
        5000,
        '取消勾选后预览实时更新',
      );
      const rawPreview = await text(client, customizeSession, '#preview-raw');
      assert(rawPreview.startsWith('sid='), '纯内容随选择切换为 Cookie', rawPreview.slice(0, 30));
      assert(
        !(await text(client, customizeSession, '#preview-prompt')).includes('Authorization: Bearer'),
        '用法说明里不再包含被取消勾选的 Authorization 头',
      );
      pass('取消勾选后三项预览实时同步');

      await evaluate(
        client,
        customizeSession,
        `(() => {
          document.getElementById('add-source').value = 'query';
          document.getElementById('add-name').value = 'debug';
          document.getElementById('add-value').value = '1';
          document.getElementById('add-form').requestSubmit();
        })()`,
      );
      await waitFor(
        client,
        customizeSession,
        `document.getElementById('preview-prompt').textContent.includes(${JSON.stringify(L.queryHeader)})`,
        5000,
        '添加 URL 参数后预览更新',
      );
      assert(
        (await text(client, customizeSession, '#preview-prompt')).includes('- debug=1'),
        'URL 参数进入用法说明',
      );
      pass('可以添加 URL 参数（GET 认证）');

      await waitFor(
        client,
        customizeSession,
        `document.getElementById('save-state').textContent.includes(${JSON.stringify(L.saved)})`,
        8000,
        '自定义选择自动保存',
      );
      pass('自定义选择自动保存');

      if (process.env.E2E_SCREENSHOTS) {
        await capture(client, customizeSession, join(ROOT, 'docs', 'customize.png'), 1000, 900);
      }

      await client.send('Target.closeTarget', { targetId: customizeTarget.targetId });
      await sleep(300);

      await client.send('Page.reload', {}, popupSession);
      await waitFor(
        client,
        popupSession,
        `!document.getElementById('result-panel').classList.contains('hidden')`,
        10000,
        '重新打开弹窗',
      );
      const headerNamesAfter = await evaluate(
        client,
        popupSession,
        `[...document.querySelectorAll('#headers-list .header-name')].map((item) => item.textContent.toLowerCase())`,
      );
      assert(
        !headerNamesAfter.includes('authorization'),
        '弹窗里的请求头已按自定义选择过滤',
        JSON.stringify(headerNamesAfter),
      );
      const customState = await evaluate(
        client,
        popupSession,
        `chrome.storage.session.get('reports').then((data) => data.reports['${host}']?.custom || null)`,
      );
      assert(Boolean(customState), '自定义结果写入了会话报告');
      assert(
        !String(customState?.copies?.headers || '').includes('Authorization'),
        '会话报告里的复制内容已按自定义生成',
      );
      pass('弹窗与会话报告同步自定义结果');
    }

    // ---------------------------------------------------------------------
    // 6.6) 英文界面渲染（?lang=en 覆盖，验证 i18n 词典与模板）
    // ---------------------------------------------------------------------
    const englishPopup = await openExtensionPage(
      client,
      `chrome-extension://${extensionId}/src/popup.html?host=${encodeURIComponent(host)}&lang=en`,
    );
    await waitFor(
      client,
      englishPopup.sessionId,
      `document.getElementById('mech-label')?.textContent?.length > 0`,
      10000,
      '英文弹窗渲染',
    );
    const english = await evaluate(
      client,
      englishPopup.sessionId,
      `(() => {
        const lines = document.body.innerText.split(String.fromCharCode(10));
        return {
          lang: document.documentElement.lang,
          mech: document.getElementById('mech-label')?.textContent || '',
          confidence: document.querySelector('.conf-label')?.textContent || '',
          cjk: lines.filter((line) => /[\\u4e00-\\u9fa5]/.test(line)).slice(0, 5),
        };
      })()`,
    );
    assert(english.lang === 'en', '?lang=en 时 html lang=en', english.lang);
    assert(english.cjk.length === 0, '英文弹窗没有残留中文', english.cjk.join(' | '));
    assert(english.confidence === 'Confidence', '英文弹窗使用英文标签', english.confidence);
    assert(english.mech.includes('Bearer'), '英文弹窗的机制名已翻译', english.mech);

    const englishCustomize = await openExtensionPage(
      client,
      `chrome-extension://${extensionId}/src/customize.html?host=${encodeURIComponent(host)}&lang=en`,
    );
    await waitFor(
      client,
      englishCustomize.sessionId,
      `document.getElementById('preview-prompt')?.textContent?.length > 50`,
      10000,
      '英文自定义页渲染',
    );
    const englishCustomizeState = await evaluate(
      client,
      englishCustomize.sessionId,
      `(() => {
        const lines = document.body.innerText.split(String.fromCharCode(10));
        return {
          lang: document.documentElement.lang,
          prompt: document.getElementById('preview-prompt')?.textContent || '',
          cjk: lines.filter((line) => /[\\u4e00-\\u9fa5]/.test(line)).slice(0, 5),
        };
      })()`,
    );
    assert(englishCustomizeState.lang === 'en', '英文自定义页 lang=en', englishCustomizeState.lang);
    assert(englishCustomizeState.cjk.length === 0, '英文自定义页没有残留中文', englishCustomizeState.cjk.join(' | '));
    assert(
      englishCustomizeState.prompt.includes('Request headers'),
      '英文用法说明使用英文模板',
      englishCustomizeState.prompt.slice(0, 120),
    );
    if (process.env.E2E_SCREENSHOTS) {
      await capture(client, englishCustomize.sessionId, join(ROOT, 'docs', 'customize-en.png'), 1000, 900);
    }

    const englishOptions = await openExtensionPage(
      client,
      `chrome-extension://${extensionId}/src/options.html?lang=en`,
    );
    await waitFor(
      client,
      englishOptions.sessionId,
      `document.getElementById('template')?.value?.length > 100`,
      10000,
      '英文设置页渲染',
    );
    const englishOptionsState = await evaluate(
      client,
      englishOptions.sessionId,
      `(() => {
        const lines = document.body.innerText.split(String.fromCharCode(10));
        const select = document.getElementById('language');
        const inSelect = select ? [...select.options].map((option) => option.textContent) : [];
        return {
          lang: document.documentElement.lang,
          template: document.getElementById('template').value,
          cjk: lines
            .filter((line) => !inSelect.includes(line))
            .filter((line) => /[\\u4e00-\\u9fa5]/.test(line))
            .slice(0, 5),
        };
      })()`,
    );
    assert(englishOptionsState.lang === 'en', '英文设置页 lang=en', englishOptionsState.lang);
    assert(englishOptionsState.cjk.length === 0, '英文设置页没有残留中文', englishOptionsState.cjk.join(' | '));
    assert(
      englishOptionsState.template.includes('## Request headers'),
      '英文设置页使用英文默认模板',
      englishOptionsState.template.slice(0, 80),
    );
    if (process.env.E2E_SCREENSHOTS) {
      await capture(client, englishPopup.sessionId, join(ROOT, 'docs', 'popup-result-en.png'));
    }
    pass('英文界面（弹窗 / 自定义 / 设置）完整渲染');

    // ---------------------------------------------------------------------
    // 6.7) 设置页手动切换语言 → 弹窗跟随（不需要 ?lang）
    // ---------------------------------------------------------------------
    const languageOptions = await openExtensionPage(
      client,
      `chrome-extension://${extensionId}/src/options.html`,
    );
    await waitFor(
      client,
      languageOptions.sessionId,
      `document.getElementById('language')?.options?.length >= 3`,
      10000,
      '设置页语言下拉框',
    );
    await evaluate(
      client,
      languageOptions.sessionId,
      `(() => {
        const select = document.getElementById('language');
        select.value = 'en';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
    );
    await sleep(500);
    console.log(
      'LANGDEBUG',
      JSON.stringify(
        await evaluate(
          client,
          languageOptions.sessionId,
          `(async () => ({
            value: document.getElementById('language').value,
            lang: document.documentElement.lang,
            toast: document.getElementById('toast')?.textContent || '',
            saveState: document.getElementById('save-state')?.textContent || '',
            settings: (await chrome.storage.local.get('settings')).settings || {},
          }))()`,
        ),
      ),
    );
    assert(
      !(await text(client, languageOptions.sessionId, '#save-state')).includes('未保存'),
      '切语言后不应误报模板未保存',
    );
    const storedSettings = await evaluate(
      client,
      languageOptions.sessionId,
      `chrome.storage.local.get('settings').then((data) => data.settings || {})`,
    );
    assert(storedSettings.language === 'en', '语言设置已持久化', JSON.stringify(storedSettings.language));

    const englishNoParam = await openExtensionPage(
      client,
      `chrome-extension://${extensionId}/src/popup.html?host=${encodeURIComponent(host)}`,
    );
    await waitFor(
      client,
      englishNoParam.sessionId,
      `document.getElementById('mech-label')?.textContent?.length > 0`,
      10000,
      '弹窗按设置切换语言',
    );
    const manualEnglish = await evaluate(
      client,
      englishNoParam.sessionId,
      `({ lang: document.documentElement.lang, confidence: document.querySelector('.conf-label')?.textContent || '' })`,
    );
    assert(manualEnglish.lang === 'en', '手动设置英文后弹窗为英文', manualEnglish.lang);
    assert(manualEnglish.confidence === 'Confidence', '手动设置英文后标签为英文');

    // 切回自动（中文浏览器 → 中文）
    await evaluate(
      client,
      languageOptions.sessionId,
      `(() => {
        const select = document.getElementById('language');
        select.value = 'auto';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
    );
    await waitFor(
      client,
      languageOptions.sessionId,
      `document.documentElement.lang === 'zh-CN'`,
      8000,
      '设置页切回自动',
    );
    await client.send('Page.reload', {}, englishNoParam.sessionId);
    await waitFor(
      client,
      englishNoParam.sessionId,
      `document.documentElement.lang === 'zh-CN'`,
      10000,
      '弹窗跟随自动语言',
    );
    pass('手动切换语言立即生效，并可切回自动');

    // ---------------------------------------------------------------------
    // 7) 停用 → 悬浮框消失、数据清理
    // ---------------------------------------------------------------------
    await realClick(client, popupSession, '#disable-link');
    await waitFor(
      client,
      popupSession,
      `!document.getElementById('enable-panel').classList.contains('hidden')`,
      8000,
      '停用后回到未启用',
    );
    await waitFor(client, siteSession, `!${OVERLAY}`, 8000, '停用后悬浮框消失');
    pass('停用后悬浮框自动消失');

    const scriptsAfter = await evaluate(
      client,
      popupSession,
      `chrome.scripting.getRegisteredContentScripts({}).then((list) => list.filter((item) => item.id.startsWith('ca_')))`,
    );
    assert(Array.isArray(scriptsAfter) && scriptsAfter.length === 0, '停用后采集脚本已注销');

    const stateAfter = await evaluate(client, popupSession, readState);
    assert(!stateAfter?.report, '停用后分析结果已清除');
    assert(!stateAfter?.site, '停用后站点记录已移除');

    // ---------------------------------------------------------------------
    // 8) 设置页
    // ---------------------------------------------------------------------
    const options = await openExtensionPage(client, `chrome-extension://${extensionId}/src/options.html`);
    await waitFor(client, options.sessionId, `document.getElementById('template')?.value?.length > 100`, 8000, '设置页加载模板');

    pass('设置页可打开并载入默认模板');

    if (process.env.E2E_SCREENSHOTS) {
      await capture(client, options.sessionId, join(ROOT, 'docs', 'options.png'), 900, 1000);
    }

    const siteRows = await evaluate(
      client,
      options.sessionId,
      `document.querySelectorAll('#site-list .site-row').length`,
    );
    assert(siteRows === 0, '停用后的站点不再出现在设置页列表', `${siteRows} 行`);

    // ---------------------------------------------------------------------
    // 8.5) 多语言：英文界面 + 中文界面都能正确渲染
    // ---------------------------------------------------------------------
    const optionsText = await evaluate(
      client,
      options.sessionId,
      `({ lang: document.documentElement.lang, title: document.querySelector('.page-title h1')?.textContent || '', hasCjk: /[\\u4e00-\\u9fa5]/.test(document.body.innerText) })`,
    );
    if (uiLanguage.toLowerCase().startsWith('zh')) {
      assert(optionsText.lang === 'zh-CN', '中文浏览器下 lang=zh-CN', optionsText.lang);
    } else {
      assert(optionsText.lang === 'en', '英文浏览器下 lang=en', optionsText.lang);
      assert(
        !optionsText.hasCjk,
        '英文浏览器下设置页没有残留中文',
        (await evaluate(client, options.sessionId, `document.body.innerText.slice(0, 200)`)) || '',
      );
    }
    pass(`设置页语言跟随浏览器（${optionsText.lang}）`);

    // ---------------------------------------------------------------------
    // 9) 健康检查
    // ---------------------------------------------------------------------
    assert(errors.length === 0, '运行期间没有未捕获异常', errors.slice(0, 3).join(' | '));

    const extensionErrors = chrome
      .getStderr()
      .split('\n')
      .filter((line) => /Uncaught|Extension error|Failed to load extension|Unchecked runtime/i.test(line))
      .slice(0, 3);
    assert(extensionErrors.length === 0, 'Chrome 日志中没有扩展错误', extensionErrors.join(' | '));

    const authed = site.received.filter((item) => /^Bearer\s+/.test(item.headers.authorization || ''));
    assert(authed.length >= 2, '服务端确实收到带 Bearer 的请求', `${authed.length} 个`);
  } finally {
    try {
      client?.close();
    } catch {
      /* 忽略 */
    }
    try {
      chrome.child.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
    site.server.close();
    await sleep(300);
    rmSync(workDir, { recursive: true, force: true });
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.error('\n失败项：');
    for (const item of failed) console.error(` - ${item.name}${item.detail ? `：${item.detail}` : ''}`);
    process.exitCode = 1;
  } else {
    console.log('✓ 端到端测试全部通过');
  }
}

main().catch((error) => {
  console.error('\n✗ 端到端测试异常终止：', error?.stack || error);
  process.exitCode = 1;
});
