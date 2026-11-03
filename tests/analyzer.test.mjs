/**
 * 分析引擎行为测试（node --test）。
 * 用真实的 JWT 结构与典型的登录站点样本，验证机制识别、凭证挑选与两种复制文本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, decodeJwt, isJwt } from '../src/lib/analyzer.js';
import { attachCopies, buildPrompt, buildPromptVars, formatTime } from '../src/lib/format.js';
import { maskSecret } from '../src/lib/mask.js';
import { DEFAULT_PROMPT_TEMPLATE } from '../src/lib/settings.js';

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------
function base64Url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeJwt(payload = {}, header = { alg: 'RS256', typ: 'JWT' }) {
  const exp = payload.exp ?? Math.floor(Date.now() / 1000) + 3600;
  return `${base64Url(header)}.${base64Url({ sub: '1024', iss: 'https://auth.example.com', exp, ...payload })}.c2lnbmF0dXJlLXZhbHVl`;
}

const JWT = makeJwt();

function cookie(overrides) {
  const now = Math.floor(Date.now() / 1000);
  return {
    name: 'sid',
    value: 'a'.repeat(43),
    domain: '.example.com',
    path: '/',
    httpOnly: false,
    secure: true,
    session: true,
    expirationDate: null,
    ...overrides,
    expirationDate: overrides.expirationDate === undefined ? now + 86400 : overrides.expirationDate,
  };
}

function page(url = 'https://example.com/dashboard') {
  return {
    url,
    origin: new URL(url).origin,
    host: new URL(url).host,
    title: '控制台',
    referrer: '',
    path: new URL(url).pathname,
    loginPageLikely: false,
  };
}

// ---------------------------------------------------------------------------
// JWT 解析
// ---------------------------------------------------------------------------
test('decodeJwt 能解析标准 JWT 的 exp / iss', () => {
  assert.ok(isJwt(JWT));
  const claims = decodeJwt(JWT);
  assert.equal(claims.alg, 'RS256');
  assert.equal(claims.iss, 'https://auth.example.com');
  assert.equal(claims.sub, '1024');
  assert.equal(typeof claims.exp, 'number');
});

test('decodeJwt 对非 JWT 返回 null', () => {
  assert.equal(decodeJwt('not-a-jwt'), null);
  assert.equal(decodeJwt(''), null);
  assert.equal(decodeJwt('eyJhbGciOiJub25lIn0..'), null);
});

// ---------------------------------------------------------------------------
// Cookie 会话
// ---------------------------------------------------------------------------
test('SESSIONID Cookie → 识别为 Cookie 会话', () => {
  const result = analyze({
    page: page('https://example.com/home'),
    cookies: [cookie({ name: 'SESSIONID', value: 'x'.repeat(32), httpOnly: true })],
    requests: [
      { url: 'https://example.com/api/user', method: 'GET', headers: { cookie: 'SESSIONID=' + 'x'.repeat(32) }, status: 200 },
    ],
  });
  assert.equal(result.auth.mechanismId, 'session-cookie');
  assert.equal(result.auth.kind, 'cookie');
  assert.match(result.auth.raw, /^SESSIONID=/);
  assert.ok(result.auth.confidence >= 60, `置信度应较高，实际 ${result.auth.confidence}`);
  assert.equal(result.headers[0].name, 'Cookie');
  assert.ok(result.evidence.some((item) => item.type === 'cookie'));
});

test('JSESSIONID 会打高置信度，且同域 Cookie 一起输出', () => {
  const result = analyze({
    page: page(),
    cookies: [
      cookie({ name: 'JSESSIONID', value: 'ABCDEF1234567890', httpOnly: true, session: true }),
      cookie({ name: 'csrftoken', value: 'csrf-value-123', httpOnly: false }),
      cookie({ name: '_ga', value: 'GA1.2.123.456' }),
    ],
  });
  assert.equal(result.auth.mechanismId, 'session-cookie');
  const names = result.auth.items.map((item) => item.name);
  assert.deepEqual(names, ['JSESSIONID', 'csrftoken']);
  assert.ok(!result.auth.raw.includes('_ga'));
  assert.ok(result.headers.some((h) => h.name === 'Cookie'));
});

test('纯 JSESSIONID 站点的置信度应达到 90% 以上', () => {
  const result = analyze({
    page: page(),
    cookies: [cookie({ name: 'JSESSIONID', value: 'ABCDEF1234567890', httpOnly: true, session: true })],
  });
  assert.ok(result.auth.confidence >= 90, `实际 ${result.auth.confidence}`);
});

test('只有统计类 Cookie 时不应识别为登录态', () => {
  const result = analyze({
    page: page(),
    cookies: [cookie({ name: '_ga', value: 'GA1.2.99' }), cookie({ name: '_gid', value: 'GA1.2.100' })],
  });
  assert.equal(result.auth.kind, 'none');
  assert.equal(result.auth.mechanismId, 'unknown');
});

// ---------------------------------------------------------------------------
// JWT Cookie
// ---------------------------------------------------------------------------
test('JWT 放在 Cookie 中 → 识别为 JWT 会话 Cookie', () => {
  const result = analyze({
    page: page(),
    cookies: [cookie({ name: 'session_token', value: JWT, httpOnly: true })],
  });
  assert.equal(result.auth.mechanismId, 'jwt-cookie');
  assert.equal(result.auth.kind, 'cookie');
  assert.equal(result.auth.raw, `session_token=${JWT}`);
  assert.ok(result.auth.token?.claims, '应解析出 JWT claims 用于展示过期时间');
});

// ---------------------------------------------------------------------------
// Bearer Token
// ---------------------------------------------------------------------------
test('Authorization: Bearer → 识别为 Bearer Token，并带过期时间', () => {
  const result = analyze({
    page: page(),
    cookies: [],
    requests: [
      {
        url: 'https://example.com/api/orders',
        method: 'GET',
        headers: { authorization: `Bearer ${JWT}`, accept: 'application/json' },
        status: 200,
      },
    ],
  });
  assert.equal(result.auth.mechanismId, 'bearer-token');
  assert.equal(result.auth.kind, 'bearer');
  assert.equal(result.auth.raw, JWT);
  assert.deepEqual(result.headers[0], {
    name: 'Authorization',
    value: `Bearer ${JWT}`,
    note: 'Bearer Token',
    noteKey: 'cred',
  });
  assert.ok(result.auth.expiresAt, '应解析出 JWT exp');
  assert.ok(result.auth.token.claims);
});

test('localStorage 中的 access_token → 识别为 Bearer Token', () => {
  const result = analyze({
    page: page(),
    storage: { local: [{ key: 'access_token', value: JWT }], session: [] },
  });
  assert.equal(result.auth.mechanismId, 'bearer-token');
  assert.equal(result.auth.raw, JWT);
  assert.equal(result.auth.sourceLabel, 'localStorage');
});

test('JSON 存储对象里的 token 字段也能提取', () => {
  const opaque = 'opaque-access-token-value-1234567890';
  const result = analyze({
    page: page(),
    storage: {
      local: [{ key: 'auth', value: JSON.stringify({ access_token: opaque, refresh_token: 'refresh-value-abcdefghij' }) }],
      session: [],
    },
  });
  assert.equal(result.auth.kind, 'bearer');
  assert.equal(result.auth.raw, opaque, '应优先选择 access_token 而不是 refresh_token');
});

test('过期的 JWT 会给出发过期提示，Token 仍可复制', () => {
  const expired = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
  const result = analyze({
    page: page(),
    requests: [{ url: 'https://example.com/api/x', method: 'GET', headers: { authorization: `Bearer ${expired}` }, status: 401 }],
  });
  assert.equal(result.auth.kind, 'bearer');
  assert.ok(result.warnings.some((w) => w.level === 'danger' && w.text.includes('过期')));
});

// ---------------------------------------------------------------------------
// OAuth / OIDC
// ---------------------------------------------------------------------------
test('OIDC 端点 + id_token → 识别为 OAuth2/OIDC', () => {
  const result = analyze({
    page: page(),
    cookies: [cookie({ name: 'sid', value: 's'.repeat(30), httpOnly: true })],
    storage: {
      local: [
        { key: 'oidc.user:https://idp.example.com:app', value: JSON.stringify({ access_token: JWT, id_token: makeJwt({ aud: 'app' }) }) },
      ],
      session: [],
    },
    requests: [
      { url: 'https://idp.example.com/oauth2/authorize?client_id=abc', method: 'GET', headers: {}, status: 302 },
      { url: 'https://example.com/api/me', method: 'GET', headers: { authorization: `Bearer ${JWT}` }, status: 200 },
    ],
  });
  assert.equal(result.auth.mechanismId, 'oauth2-oidc');
  assert.ok(result.evidence.some((item) => item.id === 'framework-oidc-client'));
  assert.ok(result.evidence.some((item) => item.id === 'id-token'));
});

test('登录响应体中的 token 也能被识别', () => {
  const opaque = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.xyz';
  const result = analyze({
    page: page(),
    requests: [
      {
        url: 'https://example.com/api/login',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        status: 200,
        responseBody: JSON.stringify({ code: 0, data: { token: opaque, expires_in: 7200 } }),
      },
    ],
  });
  assert.ok(result.auth.kind === 'bearer');
  assert.equal(result.auth.raw, opaque);
  assert.ok(result.evidence.some((item) => item.id === 'token-response'));
});

// ---------------------------------------------------------------------------
// 其他机制
// ---------------------------------------------------------------------------
test('X-API-Key 请求头 → 识别为 API Key', () => {
  const key = 'sk_live_abcdef1234567890';
  const result = analyze({
    page: page(),
    requests: [{ url: 'https://example.com/api/data', method: 'GET', headers: { 'x-api-key': key }, status: 200 }],
  });
  assert.equal(result.auth.mechanismId, 'api-key');
  assert.equal(result.auth.kind, 'api-key');
  assert.equal(result.headers[0].name, 'x-api-key');
  assert.equal(result.headers[0].value, key);
});

test('X-Auth-Token 请求头 → 识别为自定义 Token', () => {
  const token = 'custom-token-value-123456';
  const result = analyze({
    page: page(),
    requests: [{ url: 'https://example.com/api/list', method: 'POST', headers: { 'x-auth-token': token }, status: 200 }],
  });
  assert.equal(result.auth.mechanismId, 'token-header');
  assert.equal(result.auth.raw, token);
});

test('Basic 认证 → 识别并提示风险', () => {
  const credentials = Buffer.from('admin:pass1234').toString('base64');
  const result = analyze({
    page: page(),
    requests: [{ url: 'https://example.com/api', method: 'GET', headers: { authorization: `Basic ${credentials}` }, status: 401 }],
  });
  assert.equal(result.auth.mechanismId, 'basic-auth');
  assert.equal(result.auth.raw, credentials);
  assert.equal(result.headers[0].value, `Basic ${credentials}`);
  assert.ok(result.warnings.some((w) => w.text.includes('账号密码')));
});

test('SAML 相关请求 → 识别为 SAML 单点登录', () => {
  const result = analyze({
    page: page('https://example.com/app'),
    cookies: [cookie({ name: 'ASP.NET_SessionId', value: 'abcdefghijklmnop', httpOnly: true })],
    requests: [{ url: 'https://idp.example.com/adfs/ls/?SAMLRequest=abc', method: 'GET', headers: {}, status: 302 }],
  });
  assert.equal(result.auth.mechanismId, 'saml-sso');
  assert.equal(result.auth.kind, 'cookie');
});

test('WWW-Authenticate: Negotiate → 识别为 NTLM', () => {
  const result = analyze({
    page: page('http://intranet.example.com/'),
    cookies: [],
    requests: [
      { url: 'http://intranet.example.com/', method: 'GET', headers: {}, status: 401, responseHeaders: { 'www-authenticate': 'Negotiate' } },
    ],
  });
  assert.equal(result.auth.mechanismId, 'ntlm');
  assert.ok(result.warnings.some((w) => w.text.includes('HTTPS')));
});

// ---------------------------------------------------------------------------
// 综合场景
// ---------------------------------------------------------------------------
test('Cookie + Token 同时存在时，推荐请求头包含两者并给出提示', () => {
  const result = analyze({
    page: page(),
    cookies: [cookie({ name: 'sid', value: 's'.repeat(30), httpOnly: true })],
    requests: [{ url: 'https://example.com/api/me', method: 'GET', headers: { authorization: `Bearer ${JWT}` }, status: 200 }],
  });
  const names = result.headers.map((h) => h.name);
  assert.ok(names.includes('Authorization'));
  assert.ok(names.includes('Cookie'));
  assert.ok(result.warnings.some((w) => w.text.includes('同时使用')));
});

test('没有任何信号时给出明确的“未识别”与后续建议', () => {
  const result = analyze({ page: page(), cookies: [], requests: [], storage: {} });
  assert.equal(result.auth.kind, 'none');
  assert.equal(result.auth.confidence, 15);
  assert.ok(result.warnings.some((w) => w.level === 'danger'));
  assert.ok(result.nextSteps.length > 0);
});

test('其他同域子域会作为“建议补充授权”的域名', () => {
  const result = analyze({
    page: page('https://example.com/app'),
    cookies: [cookie({ name: 'sid', value: 'v'.repeat(30) })],
    requests: [
      { url: 'https://api.example.com/v1/me', method: 'GET', headers: {}, status: 200 },
      { url: 'https://third-party.com/x.js', method: 'GET', headers: {}, status: 200 },
    ],
  });
  const hosts = result.suggestedOrigins.map((item) => item.host);
  assert.ok(hosts.includes('api.example.com'));
  assert.ok(!hosts.includes('third-party.com'));
});

// ---------------------------------------------------------------------------
// 格式化 / 复制
// ---------------------------------------------------------------------------
test('attachCopies 生成纯认证值与带 Prompt 两种文本', () => {
  const result = analyze({
    page: page(),
    cookies: [cookie({ name: 'sid', value: 'abc123'.repeat(6), httpOnly: true })],
  });
  result.headers = [{ name: 'Cookie', value: 'sid=' + 'abc123'.repeat(6), note: '会话 Cookie' }];
  const full = attachCopies(result, {});
  assert.ok(full.copies.raw.startsWith('sid='));
  assert.ok(full.copies.prompt.includes('https://example.com'));
  assert.ok(full.copies.prompt.includes('Cookie: sid='));
  assert.ok(full.copies.prompt.includes('## 判断依据'));
  assert.ok(full.copies.prompt.includes('可信度'));
  assert.equal(full.copies.headers, 'Cookie: sid=' + 'abc123'.repeat(6));
});

test('关闭附带依据后 Prompt 不包含判断依据段落', () => {
  const result = analyze({
    page: page(),
    cookies: [cookie({ name: 'sid', value: 'value'.repeat(8) })],
  });
  const vars = buildPromptVars(result, { includeEvidence: false, includeWarnings: false });
  assert.equal(vars.evidence_block, '');
  assert.equal(vars.warnings_block, '');
  const prompt = buildPrompt(result, { includeEvidence: false, includeWarnings: false });
  assert.ok(!prompt.includes('## 判断依据'));
});

test('自定义模板与未知占位符', () => {
  const result = analyze({ page: page(), cookies: [cookie({ name: 'sid', value: 'v'.repeat(20) })] });
  const prompt = buildPrompt(result, { promptTemplate: 'HOST={{host}} UNKNOWN={{nope}} MECH={{mechanism_short}}' });
  assert.equal(prompt, 'HOST=example.com UNKNOWN={{nope}} MECH=Cookie 会话');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes('{{origin}}'));
});

test('formatTime 输出本地时间字符串', () => {
  assert.equal(formatTime('2025-01-02T03:04:05.000Z').length, 19);
  assert.equal(formatTime(null), '未知');
  assert.equal(formatTime('not-a-date'), 'not-a-date');
});

test('maskSecret 不泄露完整值', () => {
  const masked = maskSecret('abcdefghijklmnopqrstuvwxyz0123456789');
  assert.ok(masked.includes('…'));
  assert.ok(!masked.includes('qrstuvwxyz0123456789'));
  assert.equal(maskSecret('short'), '••••••');
});

test('分析结果里不含完整的 Cookie 值（只有 auth.items 与 raw 才保存原值）', () => {
  const secret = 'super-secret-session-value-1234567890';
  const result = analyze({
    page: page(),
    cookies: [cookie({ name: 'sid', value: secret, httpOnly: true })],
  });
  const evidenceText = JSON.stringify(result.evidence);
  assert.ok(!evidenceText.includes(secret), '判断依据中不应出现完整会话值');
  assert.equal(result.auth.raw, `sid=${secret}`, '复制用的认证值保留原值');
});

// ---------------------------------------------------------------------------
// 常见场景：Bearer 占位值 + 父域名 JWT Cookie
// ---------------------------------------------------------------------------
// 全部为合成数据
const PARENT_JWT =
  'eyJhbGciOiJFZERTQSJ9.eyJhcHAiOiJkZW1vLWFwcC1pZCIsInN1YiI6ImRlbW8tc3ViamVjdC1pZCIsInR5cCI6ImFjY2Vzc190b2tlbiIsImV4cCI6MjU5MjAwfQ.synthetic-signature-not-a-real-token';

test('Bearer undefined 不会被当成凭证', () => {
  const result = analyze({
    page: page('https://flow.example.com/pipelines/42/current'),
    cookies: [cookie({ name: 'SESSIONID', value: 'session-value-abcdef', httpOnly: true })],
    requests: [
      {
        url: 'https://api.example.com/v1/teams?pageSize=1000',
        method: 'GET',
        headers: { authorization: 'Bearer undefined', 'x-tenant-id': 'demo-tenant-id' },
        status: 200,
      },
    ],
  });
  const full = attachCopies(result, {});

  assert.equal(full.auth.kind, 'cookie', '应回退到 Cookie，而不是 Bearer');
  assert.ok(!String(full.copies.raw).includes('undefined'), '复制内容不能出现 undefined');
  assert.ok(!String(full.copies.prompt).includes('undefined'), 'Prompt 不能出现占位值');
  assert.ok(!full.headers.some((header) => header.name === 'Authorization'), '不应推荐 Authorization 头');
  assert.ok(full.evidence.some((item) => item.id === 'invalid-bearer'), '应说明忽略了无效 Bearer');
  assert.ok(full.warnings.some((item) => item.text.includes('并不依赖 Bearer')), '应说明登录态不在 Bearer');
});

test('只有占位 Bearer、没有其它凭证时，输出「未识别」而不是 undefined', () => {
  const result = analyze({
    page: page('https://flow.example.com/pipelines/1'),
    cookies: [],
    requests: [
      { url: 'https://api.example.com/v1/teams', method: 'GET', headers: { authorization: 'Bearer undefined' } },
      { url: 'https://api.example.com/v1/teams', method: 'GET', headers: { authorization: 'Bearer ' } },
    ],
  });
  const full = attachCopies(result, {});
  assert.equal(full.auth.kind, 'none');
  assert.equal(full.copies.raw, '');
  assert.ok(!JSON.stringify(full.headers).includes('undefined'), '推荐请求头不应包含占位值');
  assert.ok(!String(full.copies.raw).includes('undefined'), '纯认证值不应包含占位值');
  assert.equal(full.evidence.filter((item) => item.id === 'invalid-bearer').length, 1);
});

test('camelCase 的 JWT Cookie（accessToken）能被识别', () => {
  const result = analyze({
    page: page('https://flow.example.com/pipelines/1'),
    cookies: [cookie({ name: 'accessToken', value: PARENT_JWT, httpOnly: false, domain: '.example.com' })],
  });
  assert.equal(result.auth.mechanismId, 'jwt-cookie');
  assert.match(result.auth.raw, /^accessToken=/);
  assert.equal(result.auth.confidence >= 80, true);
});

test('多租户上下文头（x-tenant-id / x-app-id）会进入推荐请求头', () => {
  const result = analyze({
    page: page('https://flow.example.com/pipelines/1'),
    cookies: [cookie({ name: 'SESSIONID', value: 'session-value-abcdef', httpOnly: true })],
    requests: [
      {
        url: 'https://api.example.com/v1/teams',
        method: 'GET',
        headers: {
          'x-tenant-id': 'demo-tenant-id',
          'x-app-id': 'demo-app-id',
          'h-tenant-id': 'demo-tenant-id',
          'ao-user-timezone': 'Asia/Shanghai',
        },
      },
    ],
  });
  const names = result.headers.map((header) => header.name.toLowerCase());
  assert.ok(names.includes('x-tenant-id'), '应包含 x-tenant-id');
  assert.ok(names.includes('x-app-id'), '应包含 x-app-id');
  assert.ok(names.includes('ao-user-timezone'), '应包含 ao-user-timezone');
  const tenant = result.headers.find((header) => header.name.toLowerCase() === 'x-tenant-id');
  assert.equal(tenant.value, 'demo-tenant-id');
});

test('读不到任何 Cookie 时提示父域名授权（flow.example.com → example.com）', () => {
  const result = analyze({
    page: page('https://flow.example.com/pipelines/1'),
    cookies: [],
    storage: { local: [], session: [] },
    requests: [],
  });
  const hosts = result.suggestedOrigins.map((item) => item.host);
  assert.ok(hosts.includes('example.com'), `建议授权父域名，实际：${hosts.join(',')}`);
  assert.ok(result.warnings.some((item) => item.text.includes('父域名')));
});

test('IP / localhost 不会建议父域名', () => {
  for (const host of ['127.0.0.1:8080', 'localhost:3000']) {
    const result = analyze({ page: page(`http://${host}/app`), cookies: [] });
    assert.ok(!result.suggestedOrigins.some((item) => item.host.startsWith('0.0.1') || item.host === 'localhost'));
  }
});

test('合法的短 Bearer（≥8 位）仍然会被识别', () => {
  const result = analyze({
    page: page(),
    requests: [{ url: 'https://example.com/api/x', method: 'GET', headers: { authorization: 'Bearer abcdefgh12345678' } }],
  });
  assert.equal(result.auth.kind, 'bearer');
  assert.equal(result.auth.raw, 'abcdefgh12345678');
});

test('JWT 的 exp 不是时间戳（如 259200）时不误判过期', () => {
  const weird = makeJwt({ exp: 259200 });
  const result = analyze({
    page: page('https://flow.example.com/pipelines/1'),
    cookies: [cookie({ name: 'accessToken', value: weird, httpOnly: false, session: true, expirationDate: null })],
  });
  const full = attachCopies(result, {});
  assert.equal(full.auth.mechanismId, 'jwt-cookie');
  assert.equal(full.auth.expiresAt, null, '非法 exp 不应作为过期时间');
  assert.ok(!full.warnings.some((item) => item.text.includes('已过期')), '不应误报过期');
  assert.ok(full.copies.prompt.includes('会话级 Cookie'), '按会话 Cookie 描述有效期');
});

// ---------------------------------------------------------------------------
// Cookie 与 Authorization 头重复携带同一个 Token
// ---------------------------------------------------------------------------
// 全部为合成数据
const MIRROR_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3OTM2NzM5ODAsImZyb20iOiJkZW1vIiwiaWF0IjoxNzkzMDY5MTgwLCJpZCI6MSwibmFtZSI6ImRlbW9fdXNlciIsInRva2VuIjoiIiwidHlwZSI6Miwid29ya2NvZGUiOiJXMDAwMDAwIn0.synthetic-signature-not-a-real-token';

function appCookie(name, value, httpOnly = false) {
  return {
    name,
    value,
    domain: 'cloud.example.com',
    path: '/',
    httpOnly,
    secure: true,
    session: false,
    expirationDate: Math.floor(Date.now() / 1000) + 86400,
  };
}

test('Cookie 里重复保存同一个 Token 时，以 Authorization 头为准', () => {
  const result = analyze({
    page: page('https://cloud.example.com/console/app-manage'),
    cookies: [
      appCookie('logged_in', '1'),
      appCookie('app_token', 'app-token-value-123456', true),
      appCookie('SESSIONID', 'a12e9c89f8f0c4c7324ec86dccdc4d9a', true),
      appCookie('request_fingerprint', 'f'.repeat(180)),
      appCookie('pre_login_id', 'a59b8df35ec1ce79ea457f9044ddc967'),
      appCookie('Authorization', `Bearer%20${MIRROR_JWT}`, true),
    ],
    requests: [
      {
        url: 'https://cloud.example.com/api/v1/permission/menu',
        method: 'GET',
        status: 200,
        headers: { authorization: `Bearer ${MIRROR_JWT}` },
      },
    ],
  });
  const full = attachCopies(result, {});

  assert.equal(full.auth.mechanismId, 'bearer-token', '应判为 Authorization 头，而不是 Cookie 会话');
  assert.equal(full.auth.kind, 'bearer');
  assert.equal(full.copies.raw, MIRROR_JWT);
  assert.ok(
    full.evidence.some((item) => item.id === 'mirror-cookie'),
    '应说明 Cookie 只是重复保存了同一个 Token',
  );
  assert.ok(!full.copies.headers.includes('Authorization=Bearer'), 'Cookie 头里不应再出现重复的 Token');
  assert.ok(full.copies.headers.startsWith('Authorization: Bearer '), '第一行应是 Authorization 头');
});

test('Cookie 与请求头 Token 不同则不视为重复', () => {
  const other = makeJwt();
  const result = analyze({
    page: page('https://cloud.example.com/app'),
    cookies: [appCookie('Authorization', `Bearer%20${other}`, true)],
    requests: [
      {
        url: 'https://cloud.example.com/api/x',
        method: 'GET',
        status: 200,
        headers: { authorization: `Bearer ${MIRROR_JWT}` },
      },
    ],
  });
  assert.ok(!result.evidence.some((item) => item.id === 'mirror-cookie'), 'Token 不同不应判为重复');
});

test('跨站请求上的 Bearer 不会覆盖本站的 Cookie 会话', () => {
  const result = analyze({
    page: page('https://example.com/home'),
    cookies: [cookie({ name: 'JSESSIONID', value: 'ABCDEF1234567890', httpOnly: true })],
    requests: [
      {
        url: 'https://api.third-party.com/beacon',
        method: 'POST',
        status: 200,
        headers: { authorization: `Bearer ${makeJwt()}` },
      },
    ],
  });
  assert.equal(result.auth.mechanismId, 'session-cookie', '第三方请求上的 Token 不应影响本站结论');
});

test('只有 Cookie 里存 Bearer Token 时（没有请求头），仍按 Cookie 输出', () => {
  const result = analyze({
    page: page('https://app.example.com/console'),
    cookies: [appCookie('Authorization', `Bearer%20${MIRROR_JWT}`, true)],
    requests: [],
  });
  assert.equal(result.auth.kind, 'cookie');
  assert.match(result.auth.raw, /^Authorization=/);
  assert.ok(!result.headers.some((header) => header.name === 'Authorization'), '没有观测到请求头，不应臆造 Authorization 头');
});
