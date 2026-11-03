/**
 * MAIN world 注入脚本（运行在页面自身的 JS 环境）。
 *
 * 为什么需要它：Authorization / 自定义 Token 头只存在于页面上下文中，
 * 隔离世界（ISOLATED）的扩展脚本读不到，因此必须在页面环境里包一层 fetch / XHR。
 *
 * 设计要点：
 *  - 只读不改：不修改请求参数（包括 headers），只读取一份副本；
 *  - 记录放在内存里，通过 postMessage 交给 collector.js；
 *  - 响应体只在 JSON / text 且含 token 关键字时截取，并有总量上限；
 *  - 全局只包装一次（__authInspectorHooked）。
 */
(() => {
  if (window.__authInspectorHooked) return;
  window.__authInspectorHooked = true;

  const HOOK_SOURCE = '__auth_inspector_hook';
  const COLLECTOR_SOURCE = '__auth_inspector_collector';
  const MAX_RECORDS = 400;
  const BODY_LIMIT = 64 * 1024;
  const BODY_BUDGET = 2 * 1024 * 1024;
  const HEADER_VALUE_LIMIT = 8192;

  const SKIP_HEADERS = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'connection',
    'content-length',
    'content-type',
    'dnt',
    'host',
    'if-modified-since',
    'if-none-match',
    'origin',
    'pragma',
    'priority',
    'referer',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user',
    'upgrade-insecure-requests',
    'user-agent',
  ]);

  const INTERESTING_RESPONSE_HEADER = /^(www-authenticate|authorization|x-.*(auth|token|key|session|csrf)).*/i;
  const BODY_HINT = /access[_-]?token|id[_-]?token|refresh[_-]?token|"token"|"jwt"|api[_-]?key|"ticket"|"assertion"|"session/i;

  const records = [];
  const startedAt = Date.now();
  let bodyBytes = 0;

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  function absolutize(url) {
    try {
      return new URL(String(url), location.href).href;
    } catch {
      return String(url || '');
    }
  }

  function isHttp(url) {
    return /^https?:/i.test(url);
  }

  function normalizeHeaderName(name) {
    return String(name || '').toLowerCase();
  }

  function setHeader(target, name, value) {
    const key = normalizeHeaderName(name);
    if (!key || key.startsWith(':')) return;
    if (SKIP_HEADERS.has(key)) return;
    if (typeof value !== 'string' || value.length === 0) return;
    target[key] = value.length > HEADER_VALUE_LIMIT ? value.slice(0, HEADER_VALUE_LIMIT) : value;
  }

  function readRequestHeaders(source) {
    const out = {};
    if (!source) return out;
    try {
      if (typeof source.forEach === 'function' && typeof source.get === 'function') {
        // Headers 实例
        source.forEach((value, key) => setHeader(out, key, value));
        return out;
      }
      if (Array.isArray(source)) {
        for (const pair of source) {
          if (Array.isArray(pair) && pair.length >= 2) setHeader(out, pair[0], pair[1]);
        }
        return out;
      }
      if (typeof source === 'object') {
        for (const [key, value] of Object.entries(source)) {
          if (typeof value === 'string') setHeader(out, key, value);
        }
      }
    } catch {
      /* 忽略 */
    }
    return out;
  }

  function readResponseHeaders(headers) {
    const out = {};
    if (!headers) return out;
    try {
      headers.forEach((value, key) => {
        const name = normalizeHeaderName(key);
        if (!INTERESTING_RESPONSE_HEADER.test(name)) return;
        if (typeof value === 'string' && value.length > 0) out[name] = value.slice(0, HEADER_VALUE_LIMIT);
      });
    } catch {
      /* 忽略 */
    }
    return out;
  }

  function mergeRequestHeaders(first, second) {
    const out = {};
    const write = (source) => {
      if (!source) return;
      try {
        if (typeof source.forEach === 'function' && typeof source.get === 'function') {
          source.forEach((value, key) => setHeader(out, key, value));
        } else if (Array.isArray(source)) {
          for (const pair of source) if (Array.isArray(pair)) setHeader(out, pair[0], pair[1]);
        } else if (typeof source === 'object') {
          for (const [key, value] of Object.entries(source)) setHeader(out, key, value);
        }
      } catch {
        /* 忽略 */
      }
    };
    write(first);
    write(second);
    return out;
  }

  function addRecord(url, method, headers) {
    if (!isHttp(url)) return null;
    const record = {
      url,
      method: String(method || 'GET').toUpperCase(),
      time: Date.now(),
      headers: headers || {},
      status: 0,
      responseHeaders: {},
      responseBody: null,
    };
    if (records.length < MAX_RECORDS) records.push(record);
    return record;
  }

  function captureBodyText(text, record) {
    if (typeof text !== 'string' || text.length === 0) return;
    if (text.length > BODY_LIMIT) return;
    if (bodyBytes + text.length > BODY_BUDGET) return;
    if (!BODY_HINT.test(text)) return;
    bodyBytes += text.length;
    record.responseBody = text;
  }

  // ---------------------------------------------------------------------------
  // fetch
  // ---------------------------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      let record = null;
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          const url = absolutize(input.url);
          const method = (init && init.method) || input.method || 'GET';
          record = addRecord(url, method, mergeRequestHeaders(input.headers, init && init.headers));
        } else {
          const url = absolutize(input);
          const method = (init && init.method) || 'GET';
          record = addRecord(url, method, readRequestHeaders(init && init.headers));
        }
      } catch {
        record = null;
      }

      const promise = nativeFetch.apply(this, arguments);
      if (!record || !promise || typeof promise.then !== 'function') return promise;

      promise.then(
        (response) => {
          try {
            record.status = response.status;
            record.responseHeaders = readResponseHeaders(response.headers);
            const type = (response.headers.get('content-type') || '').toLowerCase();
            if ((type.includes('json') || type.includes('text/plain')) && response.body) {
              response
                .clone()
                .text()
                .then((text) => {
                  if (!text || text.length > BODY_LIMIT || bodyBytes + text.length > BODY_BUDGET) return;
                  if (!BODY_HINT.test(text)) return;
                  bodyBytes += text.length;
                  record.responseBody = text;
                })
                .catch(() => {});
            }
          } catch {
            /* 忽略 */
          }
          return response;
        },
        () => {
          record.status = 0;
          return undefined;
        },
      ).catch(() => {});

      return promise;
    };
  }

  // ---------------------------------------------------------------------------
  // XMLHttpRequest
  // ---------------------------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    const originalSetRequestHeader = XHR.prototype.setRequestHeader;
    const originalGetResponseHeader = XHR.prototype.getResponseHeader;
    const originalGetAllResponseHeaders = XHR.prototype.getAllResponseHeaders;

    XHR.prototype.open = function patchedOpen(method, url) {
      try {
        this.__authInspectorMeta = {
          method: String(method || 'GET').toUpperCase(),
          url: absolutize(typeof url === 'string' ? url : String(url)),
          headers: {},
        };
        this.__authInspectorRecord = null;
      } catch {
        /* 忽略 */
      }
      return originalOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      try {
        const meta = this.__authInspectorMeta;
        if (meta && typeof value === 'string') {
          const key = normalizeHeaderName(name);
          if (key && !SKIP_HEADERS.has(key)) meta.headers[key] = value.slice(0, HEADER_VALUE_LIMIT);
        }
      } catch {
        /* 忽略 */
      }
      return originalSetRequestHeader.apply(this, arguments);
    };

    XHR.prototype.send = function patchedSend() {
      try {
        const meta = this.__authInspectorMeta;
        if (meta) {
          const record = addRecord(meta.url, meta.method, meta.headers);
          if (record) {
            this.__authInspectorRecord = record;
            const xhr = this;
            const finish = () => {
              try {
                record.status = xhr.status;
                const raw = originalGetAllResponseHeaders.call(xhr) || '';
                for (const line of raw.split(/\r?\n/)) {
                  const index = line.indexOf(':');
                  if (index < 0) continue;
                  const name = normalizeHeaderName(line.slice(0, index).trim());
                  if (!INTERESTING_RESPONSE_HEADER.test(name)) continue;
                  record.responseHeaders[name] = line.slice(index + 1).trim().slice(0, HEADER_VALUE_LIMIT);
                }
                if (!xhr.responseType || xhr.responseType === 'text') {
                  captureBodyText(xhr.responseText, record);
                }
              } catch {
                /* 忽略 */
              }
            };
            if (this.readyState === 4) finish();
            else this.addEventListener('loadend', finish, { once: true });
          }
        }
      } catch {
        /* 忽略 */
      }
      return originalSend.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------------------
  // 与 collector 的通信
  // ---------------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== COLLECTOR_SOURCE) return;

    // 悬浮框轮询“已记录多少个请求”时只需要计数，不复制请求内容
    if (data.type === 'count') {
      window.postMessage(
        { source: HOOK_SOURCE, type: 'count', id: data.id, count: records.length, hookedAt: startedAt },
        location.origin === 'null' ? '*' : location.origin,
      );
      return;
    }

    if (data.type !== 'snapshot') return;
    let payload;
    try {
      payload = records.map((record) => ({
        url: record.url,
        method: record.method,
        time: record.time,
        headers: record.headers,
        status: record.status,
        responseHeaders: record.responseHeaders,
        responseBody: record.responseBody,
      }));
    } catch {
      payload = [];
    }
    window.postMessage(
      {
        source: HOOK_SOURCE,
        type: 'snapshot',
        id: data.id,
        hookedAt: startedAt,
        records: payload,
      },
      location.origin === 'null' ? '*' : location.origin,
    );
  });

  window.postMessage({ source: HOOK_SOURCE, type: 'ready' }, location.origin === 'null' ? '*' : location.origin);
})();