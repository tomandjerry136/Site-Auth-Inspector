/**
 * 网站登录鉴权分析引擎（纯函数，无 chrome API 依赖）。
 *
 * 输入：页面信息 + Cookie + 存储 + 捕获到的请求/响应 + 页面特征
 * 输出：鉴权方式、置信度、可复制的凭证与请求头、判断依据、风险提示
 *
 * 设计原则：
 *  - 只做“证据 + 打分”，不做猜测式硬编码，便于后续扩展；
 *  - 任何写进报告的字段都不包含完整密钥（复制用的原始值单独放在 auth 里）；
 *  - 可在 Node 中单测，浏览器与扩展页面共用同一份逻辑。
 */

import { maskSecret, brief } from './mask.js';

// ---------------------------------------------------------------------------
// 机制定义
// ---------------------------------------------------------------------------

export const MECHANISMS = {
  'session-cookie': {
    label: 'Cookie 会话（服务端 Session）',
    short: 'Cookie 会话',
    description: '登录后服务端下发会话 Cookie，后续请求依靠 Cookie 头识别身份，常见于传统服务端渲染站点。',
  },
  'jwt-cookie': {
    label: 'JWT 会话 Cookie',
    short: 'JWT Cookie',
    description: '登录凭证以 JWT 形式存放在 Cookie 中，服务端校验签名后识别身份。',
  },
  'bearer-token': {
    label: 'Bearer Token（Authorization 头）',
    short: 'Bearer Token',
    description: '前端把 access token 放在 Authorization: Bearer 请求头里调用接口，常见于前后端分离项目。',
  },
  'oauth2-oidc': {
    label: 'OAuth 2.0 / OIDC 授权',
    short: 'OAuth2 / OIDC',
    description: '通过 OAuth 2.0 或 OpenID Connect 流程获取 access_token / id_token，再以 Bearer 方式调用接口。',
  },
  'token-header': {
    label: '自定义 Token 请求头',
    short: 'Token 请求头',
    description: '客户端在自定义请求头（如 X-Auth-Token、X-Access-Token）中携带 Token。',
  },
  'api-key': {
    label: 'API Key 请求头',
    short: 'API Key',
    description: '客户端在自定义请求头（如 X-API-Key）中携带固定密钥，常见于开放平台与内部服务。',
  },
  'basic-auth': {
    label: 'HTTP Basic 认证',
    short: 'Basic 认证',
    description: '使用 Authorization: Basic base64(用户名:密码) 进行认证，凭证等同于账号密码。',
  },
  'saml-sso': {
    label: 'SAML 2.0 单点登录',
    short: 'SAML SSO',
    description: '通过 IdP 的 SAML 断言完成登录，登录成功后通常落地为服务端会话 Cookie。',
  },
  'cas-sso': {
    label: 'CAS 单点登录',
    short: 'CAS SSO',
    description: '通过 CAS 服务的 ST / TGT 票据完成登录，登录成功后落地为会话 Cookie。',
  },
  ntlm: {
    label: 'Negotiate / NTLM 集成认证',
    short: 'NTLM',
    description: '服务端要求 Windows 集成认证（Negotiate / NTLM），凭证由操作系统凭据提供。',
  },
  unknown: {
    label: '未识别出明确鉴权方式',
    short: '未识别',
    description: '没有匹配到已知鉴权特征，可能使用了非标准方案，可结合下方判断依据人工确认。',
  },
};

/** 平分时的优先级：越靠前越“具体” */
const PRIORITY = [
  'oauth2-oidc',
  'bearer-token',
  'api-key',
  'token-header',
  'basic-auth',
  'saml-sso',
  'cas-sso',
  'jwt-cookie',
  'session-cookie',
  'ntlm',
  'unknown',
];

const TRACKING_COOKIE =
  /^(_ga|_gid|_gat|_gcl|_gl$|_fbp|_fbc|_hj|_hjSession|_hjFirstSeen|__utm|_uetsid|_uetvid|_clck|_clsk|_pk_|_vwo|_vis_opt|optimizely|amplitude|ajs_|mp_|__hs|hubspot|intercom|drift|sentry|__stripe|_dd_|cf_clearance|__cf_bm|datadome|acw_tc|_gali|_ym_|yandex|_med_)/i;

const AUTH_COOKIE_NAME =
  /(^|[_.-])(sid|ssid|sess|session|sessionid|session_id|jsessionid|phpsessid|asp\.net_sessionid|aspsessionid|connect\.sid|ci_session|laravel_session|_session|auth|token|jwt|ticket|login|remember|access_token|id_token|accesstoken|idtoken|refreshtoken|authtoken|sessiontoken)([_.-]|$)/i;

const STRONG_SESSION_COOKIE =
  /jsessionid|phpsessid|asp\.net_sessionid|aspsessionid|connect\.sid|laravel_session|ci_session|_session_id|sessionid/i;

const CSRF_COOKIE = /(csrf|xsrf|_token)/i;

const CSRF_HEADER = /(^|[-_])(csrf|xsrf|anti[-_]?csrf)([-_]|$)/i;

/** 多租户 / 多应用 API 常见、复用请求时必须携带的上下文头 */
const CONTEXT_HEADER =
  /^([xh]-(tenant|app|client|channel|region|project|org|workspace|space)([-_]?(id|code|key))?|ao-user-timezone|x-requested-with)$/i;

const PUBLIC_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.uk', 'org.uk', 'ac.uk', 'com.hk', 'com.tw', 'co.jp',
  'com.au', 'com.sg', 'com.br', 'co.in', 'co.kr',
]);

/** 猜测可读父域名 Cookie 的授权域名（IP / localhost 返回 null） */
function parentDomain(host) {
  if (!host || host.includes(':')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost') return null;
  const parts = host.split('.');
  if (parts.length < 3) return null;
  const lastTwo = parts.slice(-2).join('.');
  const parent = (PUBLIC_SUFFIXES.has(lastTwo) ? parts.slice(-3) : parts.slice(-2)).join('.');
  return parent === host ? null : parent;
}

const API_KEY_HEADER =
  /(^|[-_])(api[-_]?key|apikey|auth[-_]?key|access[-_]?key|x[-_]?api[-_]?key)([-_]|$)/i;

const CUSTOM_TOKEN_HEADER =
  /^(x[-_])?(auth|access|id)[-_]?token$|^x[-_]?(token|session[-_]?id)$|^(x[-_])?bearer$/i;

const JWT_RE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/;

/** 前端 SDK 没拿到 token 时常见的占位值，不能当作凭证 */
const PLACEHOLDER_TOKEN = /^(undefined|null|nil|none|nan|true|false|off|on|0|\[object object\])$/i;

/** Token 值是否可用：排除空值、占位值、未替换的模板变量、重复 scheme */
export function isUsableToken(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 8) return false;
  if (PLACEHOLDER_TOKEN.test(text)) return false;
  if (/^\$\{[^}]*\}$/.test(text) || text.includes('{{')) return false;
  if (/^(bearer|basic)\s/i.test(text)) return false;
  if (/^(undefined|null|nan)/i.test(text) && text.length < 16) return false;
  return true;
}

const TOKEN_FIELD =
  /^(access[_-]?token|id[_-]?token|refresh[_-]?token|token|jwt|auth[_-]?token|accessToken|idToken|refreshToken|session[_-]?token|api[_-]?key|apikey|bearer|ticket|assertion|credential)$/i;

const TOKEN_KEY =
  /(token|jwt|bearer|api[_-]?key|apikey|credential|session[_-]?id|auth[_-]?id|access[_-]?key|refresh|id[_-]?token)/i;

const LOGIN_URL =
  /(login|log-in|signin|sign-in|sign_in|auth|token|session|oauth|sso|saml|cas|passport|jwt|webauthn)/i;

const OAUTH_URL = /(oauth2?|openid|oidc|\/authorize|\.well-known\/openid-configuration|\/token\b)/i;

const SAML_URL = /(saml|shibboleth|\/adfs\/|saml2?\/|assertionconsumer|sso\/saml)/i;

const CAS_URL = /(\/cas\/|ticket=ST-|servicevalidate|p3\/servicevalidate)/i;

const PROVIDER_RULES = [
  { id: 'google', label: 'Google Identity', protocol: 'oauth', hostRe: /(^|\.)accounts\.google\.com$/i },
  { id: 'microsoft', label: 'Microsoft Entra ID', protocol: 'oauth', hostRe: /(^|\.)(login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|b2clogin\.com)$/i },
  { id: 'okta', label: 'Okta', protocol: 'oauth', hostRe: /(^|\.)(okta|oktapreview|okta-emea)\.com$/i },
  { id: 'auth0', label: 'Auth0', protocol: 'oauth', hostRe: /(^|\.)auth0\.com$/i },
  { id: 'keycloak', label: 'Keycloak', protocol: 'oauth', urlRe: /\/realms\/[^/]+\/protocol\/openid-connect/i },
  { id: 'onelogin', label: 'OneLogin', protocol: 'oauth', hostRe: /(^|\.)onelogin\.com$/i },
  { id: 'ping', label: 'Ping Identity', protocol: 'saml', hostRe: /(^|\.)(pingidentity|pingone)\.com$/i },
  { id: 'adfs', label: 'ADFS', protocol: 'saml', urlRe: /\/adfs\//i },
  { id: 'shibboleth', label: 'Shibboleth', protocol: 'saml', urlRe: /shibboleth|\/idp\/profile\//i },
  { id: 'cas', label: 'CAS Server', protocol: 'cas', urlRe: /\/cas\/(login|servicevalidate|p3\/servicevalidate)/i },
];

const FRAMEWORK_KEY_RULES = [
  { id: 'firebase', label: 'Firebase Auth', protocol: 'oauth', re: /^firebase:authUser/i },
  { id: 'supabase', label: 'Supabase Auth', protocol: 'oauth', re: /^sb-.*-auth-token$/i },
  { id: 'msal', label: 'MSAL (Azure AD)', protocol: 'oauth', re: /^msal\./i },
  { id: 'oidc-client', label: 'oidc-client-ts', protocol: 'oauth', re: /^oidc\.user:/i },
  { id: 'amplify', label: 'AWS Cognito', protocol: 'oauth', re: /^CognitoIdentityServiceProvider/i },
];

const SCRIPT_HINTS = [
  { id: 'firebase', label: 'Firebase Auth SDK', protocol: 'oauth', re: /firebase|gstatic\.com\/firebasejs/i },
  { id: 'supabase', label: 'Supabase SDK', protocol: 'oauth', re: /supabase/i },
  { id: 'auth0', label: 'Auth0 SPA SDK', protocol: 'oauth', re: /auth0/i },
  { id: 'msal', label: 'MSAL.js', protocol: 'oauth', re: /msal/i },
  { id: 'google-gsi', label: 'Google Identity Services', protocol: 'oauth', re: /accounts\.google\.com\/gsi/i },
  { id: 'okta', label: 'Okta Sign-in Widget', protocol: 'oauth', re: /okta/i },
  { id: 'cognito', label: 'AWS Amplify / Cognito', protocol: 'oauth', re: /cognito|amplify/i },
];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function isJwt(value) {
  return typeof value === 'string' && JWT_RE.test(value.trim());
}

function base64UrlDecode(input) {
  let text = String(input).replace(/-/g, '+').replace(/_/g, '/');
  while (text.length % 4 !== 0) text += '=';
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/** 解析 JWT（失败返回 null）。exp 单位为秒。 */
export function decodeJwt(token) {
  if (!isJwt(token)) return null;
  const parts = String(token).trim().split('.');
  try {
    const header = JSON.parse(base64UrlDecode(parts[0]));
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return {
      header,
      payload,
      alg: header.alg || '',
      exp: typeof payload.exp === 'number' ? payload.exp : null,
      iat: typeof payload.iat === 'number' ? payload.iat : null,
      iss: typeof payload.iss === 'string' ? payload.iss : '',
      aud: payload.aud ?? null,
      sub: typeof payload.sub === 'string' ? payload.sub : '',
    };
  } catch {
    return null;
  }
}

/** JWT 的 exp 必须是合理的 UNIX 时间戳；有些站点会误填有效期（如 259200），此时不能当作过期时间 */
export function isPlausibleExp(exp) {
  return typeof exp === 'number' && Number.isFinite(exp) && exp >= 946684800 && exp <= 4102444800;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function safeUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function registrableish(host) {
  if (!host) return '';
  if (/^[\d.]+$/.test(host) || host === 'localhost') return host;
  const parts = host.split('.');
  return parts.slice(-2).join('.');
}

function sameSite(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return registrableish(a) === registrableish(b);
}

function isProviderHost(host) {
  return PROVIDER_RULES.some((rule) => rule.hostRe && rule.hostRe.test(host));
}

function detectProvider(host, url) {
  for (const rule of PROVIDER_RULES) {
    if (rule.hostRe && rule.hostRe.test(host)) return rule;
    if (rule.urlRe && rule.urlRe.test(url)) return rule;
  }
  return null;
}

function createEvidenceLog() {
  const list = [];
  const seen = new Set();
  return {
    list,
    add(id, type, title, detail = '') {
      if (seen.has(id)) return;
      seen.add(id);
      list.push({ id, type, title, detail });
    },
  };
}

function plausibleToken(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 12 || value.length > 8192) return false;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9._~+/=-]+$/.test(value);
}

function collectJsonTokens(value, out, depth = 0) {
  if (depth > 3 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) collectJsonTokens(item, out, depth + 1);
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') {
      if (TOKEN_FIELD.test(key) && val.length >= 8 && val.length <= 8192) out.push({ key, value: val });
    } else if (val && typeof val === 'object') {
      collectJsonTokens(val, out, depth + 1);
    }
  }
}

function extractTokensFromText(text) {
  if (typeof text !== 'string' || text.length < 8) return [];
  const out = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      collectJsonTokens(JSON.parse(trimmed), out);
    } catch {
      /* 非 JSON，忽略 */
    }
  }
  if (out.length === 0 && isJwt(trimmed)) out.push({ key: 'jwt', value: trimmed });
  return out;
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

function normalizePage(input) {
  const raw = input?.page || {};
  const url = typeof raw.url === 'string' ? raw.url : '';
  const parsed = safeUrl(url);
  const origin = raw.origin || (parsed ? parsed.origin : '');
  const host = raw.host || (parsed ? parsed.host : '');
  return {
    url,
    origin,
    host,
    title: typeof raw.title === 'string' ? raw.title : '',
    referrer: typeof raw.referrer === 'string' ? raw.referrer : '',
    path: raw.path || (parsed ? parsed.pathname : ''),
    loginPageLikely: Boolean(raw.loginPageLikely),
    https: origin ? origin.startsWith('https://') : false,
  };
}

function normalizeCookies(list, now) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    const expirationDate = typeof item.expirationDate === 'number' ? item.expirationDate : null;
    if (expirationDate && expirationDate * 1000 < now - 60_000) continue; // 已过期
    out.push({
      name: item.name,
      value: typeof item.value === 'string' ? item.value : '',
      domain: item.domain || '',
      path: item.path || '/',
      httpOnly: Boolean(item.httpOnly),
      secure: Boolean(item.secure),
      session: Boolean(item.session) || !expirationDate,
      sameSite: item.sameSite || 'unspecified',
      expirationDate,
      expiresAt: expirationDate ? new Date(expirationDate * 1000).toISOString() : null,
    });
  }
  return out;
}

function normalizeRequests(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r.url === 'string')
    .map((r) => {
      const headers = {};
      for (const [key, value] of Object.entries(r.headers || {})) {
        if (typeof value === 'string') headers[String(key).toLowerCase()] = value;
      }
      const responseHeaders = {};
      for (const [key, value] of Object.entries(r.responseHeaders || {})) {
        if (typeof value === 'string') responseHeaders[String(key).toLowerCase()] = value;
      }
      return {
        url: r.url,
        method: String(r.method || 'GET').toUpperCase(),
        status: typeof r.status === 'number' ? r.status : 0,
        headers,
        responseHeaders,
        responseBody: typeof r.responseBody === 'string' ? r.responseBody : null,
        time: typeof r.time === 'number' ? r.time : 0,
      };
    });
}

function normalizeStorage(storage) {
  const dump = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((item) => item && typeof item.key === 'string')
      .map((item) => ({
        key: item.key,
        value: typeof item.value === 'string' ? item.value : String(item.value ?? ''),
      }))
      .filter((item) => item.value.length > 0)
      .slice(0, 300);
  return { local: dump(storage?.local), session: dump(storage?.session) };
}

function normalizeHints(hints) {
  const arr = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(0, 300) : []);
  const meta = {};
  for (const [key, value] of Object.entries(hints?.meta || {})) {
    if (typeof value === 'string' && value.length < 4096) meta[key] = value;
  }
  return {
    scriptSrcs: arr(hints?.scriptSrcs),
    linkHrefs: arr(hints?.linkHrefs),
    cookieNames: arr(hints?.cookieNames),
    indexedDB: arr(hints?.indexedDB),
    meta,
  };
}

// ---------------------------------------------------------------------------
// Cookie 打分
// ---------------------------------------------------------------------------

function cookieReasons(cookie) {
  const reasons = [];
  if (AUTH_COOKIE_NAME.test(cookie.name)) reasons.push('名称符合会话特征');
  if (cookie.httpOnly) reasons.push('HttpOnly');
  if (cookie.secure) reasons.push('Secure');
  if (cookie.value.length >= 20) reasons.push('值较长');
  if (isJwt(cookie.value)) reasons.push('JWT 格式');
  if (/^(__Host-|__Secure-)/i.test(cookie.name)) reasons.push('安全前缀');
  if (CSRF_COOKIE.test(cookie.name)) reasons.push('CSRF 相关');
  return reasons;
}

function scoreCookie(cookie) {
  if (TRACKING_COOKIE.test(cookie.name)) return 0;
  let score = 0;
  if (AUTH_COOKIE_NAME.test(cookie.name)) score += 14;
  if (STRONG_SESSION_COOKIE.test(cookie.name)) score += 8;
  if (cookie.httpOnly) score += 8;
  if (cookie.secure) score += 3;
  if (cookie.value.length >= 20) score += 5;
  if (isJwt(cookie.value)) score += 10;
  if (/^(__Host-|__Secure-)/i.test(cookie.name)) score += 6;
  if (CSRF_COOKIE.test(cookie.name)) score += 2;
  if (cookie.session) score += 2;
  return score;
}

function pickAuthCookies(scored) {
  const strong = scored.filter((item) => item.score >= 8);
  if (strong.length > 0) return strong.slice(0, 6);
  return scored.filter((item) => item.score >= 3).slice(0, 4);
}

/** 从 Cookie 值里解析 "Bearer <token>"（前端常把 Token 塞进 Cookie，例如 Authorization=Bearer%20xxx） */
function bearerTokenFromCookieValue(value) {
  if (typeof value !== 'string') return null;
  let text = value;
  try {
    text = decodeURIComponent(value);
  } catch {
    /* 保留原值 */
  }
  const match = /^bearer\s+(\S.*)$/i.exec(text.trim());
  if (!match) return null;
  const token = match[1].trim();
  return isUsableToken(token) ? token : null;
}

function cookieHeaderValue(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * 除会话 Cookie 外，真实请求往往还需要 CSRF Cookie（双提交校验）或其它 HttpOnly 功能 Cookie。
 * 这里把它们一起带上，避免“复制出来却少一条 Cookie 导致 403”。
 */
function extraFunctionalCookies(cookies, authCookies) {
  const used = new Set(authCookies.map((item) => item.c.name));
  return cookies.filter(
    (cookie) =>
      !used.has(cookie.name) &&
      !TRACKING_COOKIE.test(cookie.name) &&
      (CSRF_COOKIE.test(cookie.name) || cookie.httpOnly),
  );
}

// ---------------------------------------------------------------------------
// 存储 / 请求扫描
// ---------------------------------------------------------------------------

function scanStorage(storage) {
  const tokens = [];
  const frameworks = [];
  const areas = [
    ['local', 'localStorage'],
    ['session', 'sessionStorage'],
  ];
  for (const [area, label] of areas) {
    for (const item of storage[area]) {
      for (const rule of FRAMEWORK_KEY_RULES) {
        if (rule.re.test(item.key)) {
          frameworks.push({ ...rule, key: item.key, area: label });
        }
      }
      let parsedJson = null;
      const trimmed = item.value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          parsedJson = JSON.parse(trimmed);
        } catch {
          parsedJson = null;
        }
      }
      if (parsedJson) {
        const found = [];
        collectJsonTokens(parsedJson, found);
        for (const token of found) {
          tokens.push({ value: token.value, key: `${item.key}.${token.key}`, source: 'storage', area: label, areaKey: item.key });
        }
        continue;
      }
      if (isJwt(item.value)) {
        tokens.push({ value: item.value, key: item.key, source: 'storage', area: label, areaKey: item.key });
      } else if (TOKEN_KEY.test(item.key) && plausibleToken(item.value) && isUsableToken(item.value)) {
        tokens.push({ value: item.value, key: item.key, source: 'storage', area: label, areaKey: item.key });
      }
    }
  }
  return { tokens, frameworks };
}

function scanRequests(requests, pageHost) {
  const result = {
    bearer: [],
    basic: [],
    apiKeys: [],
    customTokens: [],
    csrf: [],
    queryTokens: [],
    wwwAuth: [],
    providers: new Map(),
    saml: false,
    cas: false,
    oauthEndpoints: [],
    loginRequests: 0,
    hosts: new Map(), // host -> origin
    responseTokens: [],
    scriptProviders: new Map(),
    invalidBearer: 0,
    contextHeaders: new Map(),
  };

  const pushUnique = (list, entry, keyFn = (x) => x.value) => {
    const key = keyFn(entry);
    if (!key) return;
    if (!list.some((x) => keyFn(x) === key)) list.push(entry);
  };

  for (const req of requests) {
    const parsed = safeUrl(req.url);
    if (!parsed || !/^https?:$/.test(parsed.protocol)) continue;
    result.hosts.set(parsed.host, parsed.origin);
    if (
      parsed.host === pageHost &&
      LOGIN_URL.test(parsed.pathname) &&
      !/\/authorize\b/i.test(parsed.pathname)
    ) {
      result.loginRequests += 1;
    }
    if (SAML_URL.test(req.url)) result.saml = true;
    if (CAS_URL.test(req.url)) result.cas = true;
    if (OAUTH_URL.test(req.url)) result.oauthEndpoints.push(req.url);

    const provider = detectProvider(parsed.host, req.url);
    if (provider) result.providers.set(provider.id, provider);

    const auth = req.headers.authorization;
    if (auth) {
      if (/^bearer\b/i.test(auth)) {
        const token = auth.replace(/^bearer\b\s*/i, '').trim();
        if (isUsableToken(token)) {
          pushUnique(result.bearer, {
            value: token,
            method: req.method,
            url: req.url,
            status: req.status,
            sameSite: sameSite(parsed.host, pageHost),
            jwt: isJwt(token),
          });
        } else {
          // 典型场景：SDK 未拿到 token 时发出 "Authorization: Bearer" / "Bearer undefined"
          result.invalidBearer += 1;
        }
      } else if (/^basic\b/i.test(auth)) {
        const value = auth.replace(/^basic\b\s*/i, '').trim();
        if (value.length >= 8 && !PLACEHOLDER_TOKEN.test(value)) {
          pushUnique(result.basic, { value, method: req.method, url: req.url });
        }
      } else if (/^(negotiate|ntlm|digest)\b/i.test(auth)) {
        result.wwwAuth.push(auth.split(/\s+/)[0]);
      }
    }

    for (const [name, value] of Object.entries(req.headers)) {
      if (!value || name === 'authorization' || name.startsWith(':')) continue;
      if (CSRF_HEADER.test(name)) {
        result.csrf.push({ name, value, url: req.url });
        continue;
      }
      if (API_KEY_HEADER.test(name)) {
        if (isUsableToken(value)) {
          pushUnique(result.apiKeys, { name, value, method: req.method, url: req.url }, (x) => `${x.name}:${x.value}`);
        }
        continue;
      }
      if (CUSTOM_TOKEN_HEADER.test(name)) {
        if (isUsableToken(value)) {
          pushUnique(result.customTokens, { name, value, method: req.method, url: req.url }, (x) => `${x.name}:${x.value}`);
        }
        continue;
      }
      // 应用上下文头（多租户 / 多应用 API 往往必须携带），用于生成可直接复用的请求头
      if (CONTEXT_HEADER.test(name) && value.length <= 200 && !PLACEHOLDER_TOKEN.test(value.trim())) {
        const key = `${name.toLowerCase()}`;
        const existing = result.contextHeaders.get(key);
        if (existing) existing.count += 1;
        else result.contextHeaders.set(key, { name, value, count: 1 });
      }
    }

    for (const [key, value] of parsed.searchParams) {
      if (/^(access_token|id_token|token|jwt|ticket)$/i.test(key) && value.length >= 8) {
        pushUnique(result.queryTokens, { name: key, value, url: req.url });
      }
    }

    const www = req.responseHeaders['www-authenticate'];
    if (www) result.wwwAuth.push(www);
    if (req.status === 401 || req.status === 403) result.wwwAuth.push(`status:${req.status}`);

    if (req.responseBody) {
      for (const token of extractTokensFromText(req.responseBody)) {
        pushUnique(
          result.responseTokens,
          { value: token.value, key: token.key, source: 'response', url: req.url },
          (x) => `${x.key}:${x.value}`,
        );
      }
    }
  }

  return result;
}

function detectScriptHints(hints) {
  const found = new Map();
  const sources = [...hints.scriptSrcs, ...hints.linkHrefs].join('\n');
  for (const rule of SCRIPT_HINTS) {
    if (rule.re.test(sources)) found.set(rule.id, rule);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 凭证挑选
// ---------------------------------------------------------------------------

function tokenCandidateScore(token) {
  let score = 0;
  if (token.source === 'request') score += 100;
  else if (token.source === 'response') score += 80;
  else if (token.area === 'localStorage') score += 60;
  else if (token.area === 'sessionStorage') score += 50;
  if (isJwt(token.value)) score += 20;
  if (/access[_-]?token|id[_-]?token/i.test(token.key || '')) score += 10;
  if (/refresh[_-]?token/i.test(token.key || '')) score -= 40;
  const claims = isJwt(token.value) ? decodeJwt(token.value) : null;
  if (isPlausibleExp(claims?.exp) && claims.exp * 1000 < Date.now()) score -= 50;
  return score;
}

function pickBestToken(tokens) {
  let best = null;
  let bestScore = -Infinity;
  for (const token of tokens) {
    const score = tokenCandidateScore(token);
    if (score > bestScore) {
      best = token;
      bestScore = score;
    }
  }
  return best;
}

function sourceLabelFor(token) {
  if (!token) return '';
  if (token.source === 'request') return '请求头 Authorization';
  if (token.source === 'response') return '登录响应体';
  return token.area || '浏览器存储';
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export function analyze(input = {}) {
  const now = Date.now();
  const page = normalizePage(input);
  const cookies = normalizeCookies(input.cookies, now);
  const requests = normalizeRequests(input.requests);
  const storage = normalizeStorage(input.storage);
  const hints = normalizeHints(input.hints);

  const evidence = createEvidenceLog();
  const scores = new Map();
  const add = (id, weight) => {
    if (!weight || weight <= 0) return;
    scores.set(id, (scores.get(id) || 0) + weight);
  };

  // ---------------- 请求（先扫描，Cookie 里的镜像 Token 需要用到） ----------------
  const found = scanRequests(requests, page.host);

  // ---------------- Cookie ----------------
  // Cookie 里只是把请求头的 Token 又存了一份：不计入 Cookie 会话证据，也不放进复制内容
  const headerBearerTokens = new Set(found.bearer.map((item) => item.value));
  const mirrorCookieNames = new Set();
  for (const cookie of cookies) {
    const token = bearerTokenFromCookieValue(cookie.value);
    if (token && headerBearerTokens.has(token)) mirrorCookieNames.add(cookie.name);
  }
  const credentialCookies = cookies.filter((cookie) => !mirrorCookieNames.has(cookie.name));
  if (mirrorCookieNames.size > 0) {
    evidence.add(
      'mirror-cookie',
      'cookie',
      'Cookie 里重复保存了同一个 Token',
      `${[...mirrorCookieNames].join('、')} 与请求头 Authorization 中的 Token 相同，已按请求头识别，不重复计入 Cookie`,
    );
  }

  const scoredCookies = credentialCookies
    .map((cookie) => ({ c: cookie, score: scoreCookie(cookie), reasons: cookieReasons(cookie) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const authCookies = pickAuthCookies(scoredCookies);
  if (authCookies.length > 0) {
    const names = authCookies
      .map((item) => `${item.c.name}${item.c.httpOnly ? '（HttpOnly）' : ''}`)
      .join('、');
    evidence.add('cookie-set', 'cookie', `识别到 ${authCookies.length} 个疑似会话 Cookie`, names);
    const cookieStrength = authCookies.slice(0, 3).reduce((total, item) => total + item.score, 0);
    const weight =
      12 +
      Math.min(8, authCookies.length * 2) +
      (authCookies.some((item) => item.c.httpOnly) ? 6 : 0) +
      (authCookies.some((item) => STRONG_SESSION_COOKIE.test(item.c.name)) ? 8 : 0) +
      Math.min(30, Math.round(cookieStrength / 1.5));
    add('session-cookie', weight);

    const jwtCookie = authCookies.find((item) => isJwt(item.c.value));
    if (jwtCookie) {
      add('jwt-cookie', weight + 10);
      evidence.add(
        'cookie-jwt',
        'cookie',
        'Cookie 中存在 JWT 格式凭证',
        `${jwtCookie.c.name} = ${maskSecret(jwtCookie.c.value)}`,
      );
    }
    const csrfCookie = authCookies.find((item) => CSRF_COOKIE.test(item.c.name));
    if (csrfCookie) {
      evidence.add('cookie-csrf', 'cookie', '存在 CSRF 相关 Cookie', csrfCookie.c.name);
    }
  } else if (cookies.length > 0) {
    evidence.add('cookie-any', 'cookie', `发现 ${cookies.length} 个 Cookie，但不符合常见会话特征`, '');
  }

  if (found.bearer.length > 0) {
    const sameSiteTokens = found.bearer.filter((item) => item.sameSite);
    const primaryToken =
      sameSiteTokens.find((item) => item.jwt) || sameSiteTokens[0] || found.bearer[0];
    let bearerWeight = sameSiteTokens.length > 0 ? 62 : 30;
    if (primaryToken.jwt) bearerWeight += 6;
    if (sameSiteTokens.some((item) => item.status >= 200 && item.status < 300)) bearerWeight += 4;
    if (found.loginRequests > 0) bearerWeight += 6;
    add('bearer-token', bearerWeight);
    evidence.add(
      'bearer-request',
      'request',
      '捕获到 Authorization: Bearer 请求头',
      `${primaryToken.method} ${hostOf(primaryToken.url)} · ${maskSecret(primaryToken.value)}`,
    );
  }
  if (found.invalidBearer > 0) {
    evidence.add(
      'invalid-bearer',
      'request',
      '忽略无效的 Bearer 请求头',
      `${found.invalidBearer} 个请求未携带有效 Token（值为空或前端占位值），已忽略，不作为认证凭证`,
    );
  }
  if (found.customTokens.length > 0) {
    add('token-header', 26);
    const first = found.customTokens[0];
    evidence.add(
      'custom-token-request',
      'request',
      `捕获到自定义 Token 请求头 ${first.name}`,
      `${first.method} ${hostOf(first.url)} · ${maskSecret(first.value)}`,
    );
  }
  if (found.apiKeys.length > 0) {
    add('api-key', 30);
    const first = found.apiKeys[0];
    evidence.add(
      'api-key-request',
      'request',
      `捕获到 API Key 请求头 ${first.name}`,
      `${first.method} ${hostOf(first.url)} · ${maskSecret(first.value)}`,
    );
  }
  if (found.basic.length > 0) {
    add('basic-auth', 32);
    evidence.add(
      'basic-request',
      'request',
      '捕获到 Authorization: Basic 请求头',
      `${found.basic[0].method} ${hostOf(found.basic[0].url)}`,
    );
  }
  if (found.wwwAuth.some((value) => /negotiate|ntlm/i.test(value))) {
    add('ntlm', 28);
    evidence.add('ntlm-request', 'request', '服务端要求 Negotiate / NTLM 认证', '');
  }
  if (found.saml) {
    add('saml-sso', 34);
    evidence.add('saml-request', 'request', '捕获到 SAML 相关请求', brief(found.oauthEndpoints[0] || '', 80));
  }
  if (found.cas) {
    add('cas-sso', 34);
    evidence.add('cas-request', 'request', '捕获到 CAS 票据 / 校验请求', '');
  }
  if (found.queryTokens.length > 0) {
    evidence.add(
      'query-token',
      'request',
      '凭证出现在 URL 查询参数中',
      `${found.queryTokens[0].name}=${maskSecret(found.queryTokens[0].value)}`,
    );
  }
  if (found.csrf.length > 0) {
    evidence.add('csrf-header', 'request', '请求携带 CSRF 防护头', found.csrf[0].name);
  }
  if (found.loginRequests > 0) {
    evidence.add('login-request', 'request', `捕获到 ${found.loginRequests} 个疑似登录 / Token 相关请求`, '');
  }

  // ---------------- 存储 ----------------
  const storageScan = scanStorage(storage);
  const residualTokens = [];
  for (const token of storageScan.tokens) {
    if (!residualTokens.some((t) => t.value === token.value)) residualTokens.push(token);
  }
  const responseTokens = found.responseTokens;
  const storageTemplates = storageScan.frameworks;
  for (const framework of storageTemplates) {
    evidence.add(
      `framework-${framework.id}`,
      'storage',
      `发现 ${framework.label} 的本地会话数据`,
      `${framework.area} · ${framework.key}`,
    );
    if (framework.protocol === 'oauth') add('oauth2-oidc', 16);
  }

  if (residualTokens.length > 0) {
    const jwtToken = residualTokens.find((token) => isJwt(token.value));
    evidence.add(
      'token-storage',
      'storage',
      `在 ${residualTokens[0].area} 中发现 ${residualTokens.length} 个疑似 Token`,
      residualTokens
        .slice(0, 3)
        .map((token) => `${brief(token.key, 40)} = ${maskSecret(token.value)}`)
        .join('；'),
    );
    if (found.bearer.length === 0) add('bearer-token', 22 + (jwtToken ? 4 : 0));
  }
  if (responseTokens.length > 0) {
    evidence.add(
      'token-response',
      'response',
      '从接口响应中提取到 Token',
      responseTokens
        .slice(0, 3)
        .map((token) => `${token.key} = ${maskSecret(token.value)}`)
        .join('；'),
    );
    if (found.bearer.length === 0) add('bearer-token', 20);
  }

  // ---------------- 单点登录 / OAuth 线索 ----------------
  const scriptProviders = detectScriptHints(hints);
  for (const provider of scriptProviders.values()) {
    evidence.add(`script-${provider.id}`, 'hint', `页面加载了 ${provider.label}`, '');
    if (provider.protocol === 'oauth') add('oauth2-oidc', 14);
    if (provider.protocol === 'saml') add('saml-sso', 14);
    if (provider.protocol === 'cas') add('cas-sso', 14);
  }

  for (const provider of found.providers.values()) {
    evidence.add(
      `provider-${provider.id}`,
      'request',
      `捕获到 ${provider.label} 相关请求`,
      provider.label,
    );
    if (provider.protocol === 'saml') add('saml-sso', 26);
    else if (provider.protocol === 'cas') add('cas-sso', 26);
    else add('oauth2-oidc', 24);
  }

  if (found.oauthEndpoints.length > 0) {
    add('oauth2-oidc', 24);
    evidence.add('oauth-endpoint', 'request', '捕获到 OAuth / OIDC 端点请求', brief(found.oauthEndpoints[0], 90));
  }

  const allTokens = [
    ...found.bearer.map((token) => ({
      value: token.value,
      key: 'authorization',
      source: 'request',
      method: token.method,
      url: token.url,
    })),
    ...responseTokens,
    ...residualTokens,
  ];

  const idToken = allTokens.find((token) => /id[_-]?token/i.test(token.key || ''));
  if (idToken) {
    add('oauth2-oidc', 30);
    evidence.add('id-token', 'storage', '发现 id_token（OIDC 身份令牌）', maskSecret(idToken.value));
  }
  const refreshToken = allTokens.find((token) => /refresh[_-]?token/i.test(token.key || ''));
  if (refreshToken) {
    add('oauth2-oidc', 10);
    evidence.add('refresh-token', 'storage', '发现 refresh_token', maskSecret(refreshToken.value));
  }

  const bestToken = pickBestToken(allTokens);
  if (bestToken) {
    const claims = isJwt(bestToken.value) ? decodeJwt(bestToken.value) : null;
    if (claims?.iss && /^https?:\/\//i.test(claims.iss)) {
      add('oauth2-oidc', 10);
      evidence.add('jwt-issuer', 'storage', 'JWT 由外部身份提供方签发', claims.iss);
    }
  }

  // ---------------- 选出机制 ----------------
  const ranked = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id));

  const top = ranked[0];
  const mechanismId = top && top.score >= 10 ? top.id : 'unknown';
  const mechanismDef = MECHANISMS[mechanismId] || MECHANISMS.unknown;
  const confidence =
    top && top.score >= 10 ? clamp(Math.round(100 - 60 * Math.exp(-top.score / 28)), 10, 97) : 15;

  // ---------------- 凭证 ----------------
  const headerCookies =
    authCookies.length > 0
      ? [
          ...authCookies.map((item) => item.c),
          ...extraFunctionalCookies(credentialCookies, authCookies),
        ].slice(0, 12)
      : credentialCookies.filter((cookie) => !TRACKING_COOKIE.test(cookie.name)).slice(0, 12);

  const candidates = {
    token:
      bestToken && isUsableToken(bestToken.value)
        ? { value: bestToken.value, source: bestToken.source, area: bestToken.area, key: bestToken.key, url: bestToken.url }
        : null,
    customToken: found.customTokens.find((item) => isUsableToken(item.value)) || null,
    apiKey: found.apiKeys.find((item) => isUsableToken(item.value)) || null,
    basic: found.basic.find((item) => item.value.length >= 8) || null,
    cookie: headerCookies.length > 0 ? { cookies: headerCookies } : null,
  };

  const order = {
    'bearer-token': ['token', 'customToken', 'apiKey', 'basic', 'cookie'],
    'oauth2-oidc': ['token', 'cookie', 'customToken'],
    'session-cookie': ['cookie', 'token'],
    'jwt-cookie': ['cookie', 'token'],
    'saml-sso': ['cookie', 'token'],
    'cas-sso': ['cookie', 'token'],
    'api-key': ['apiKey', 'customToken', 'token', 'cookie'],
    'token-header': ['customToken', 'token', 'apiKey', 'cookie'],
    'basic-auth': ['basic', 'cookie', 'token'],
    ntlm: ['cookie', 'basic', 'token'],
    unknown: ['token', 'customToken', 'apiKey', 'basic', 'cookie'],
  }[mechanismId] || ['token', 'cookie'];

  let picked = 'none';
  for (const key of order) {
    if (candidates[key]) {
      picked = key;
      break;
    }
  }

  const auth = buildAuth(picked, candidates, authCookies, found, bestToken);
  auth.mechanism = mechanismDef.label;
  auth.mechanismId = mechanismId;
  auth.mechanismShort = mechanismDef.short;
  auth.description = mechanismDef.description;
  auth.confidence = confidence;

  // ---------------- 推荐请求头 ----------------
  const headers = [];
  const seenHeader = new Set();
  const pushHeader = (name, value, note, noteKey) => {
    const key = name.toLowerCase();
    if (!value || seenHeader.has(key)) return;
    seenHeader.add(key);
    headers.push({ name, value, note, noteKey });
  };

  if (auth.kind === 'cookie') pushHeader('Cookie', auth.raw, '会话 Cookie', 'cred');
  if (auth.kind === 'bearer') pushHeader('Authorization', `Bearer ${auth.raw}`, 'Bearer Token', 'cred');
  if (auth.kind === 'basic') pushHeader('Authorization', `Basic ${auth.raw}`, 'HTTP Basic 凭证', 'cred');
  if (auth.kind === 'api-key') pushHeader(auth.headerName || 'X-API-Key', auth.raw, 'API Key', 'cred');
  if (auth.kind === 'custom-header') pushHeader(auth.headerName || 'X-Auth-Token', auth.raw, '自定义 Token 头', 'cred');

  const cookieish = ['session-cookie', 'jwt-cookie', 'saml-sso', 'cas-sso', 'ntlm'].includes(mechanismId);
  if (auth.kind !== 'cookie' && authCookies.length > 0) {
    pushHeader(
      'Cookie',
      cookieHeaderValue(authCookies.map((item) => item.c)),
      '同时携带的会话 Cookie',
    );
  } else if (cookieish && headerCookies.length > 0) {
    pushHeader('Cookie', cookieHeaderValue(headerCookies), '同时需要的会话 Cookie', 'cred');
  }
  if (auth.kind === 'cookie' && bestToken && bestToken.source === 'request') {
    pushHeader('Authorization', `Bearer ${bestToken.value}`, '同时携带的 Token', 'cred');
  }
  for (const item of found.csrf) {
    pushHeader(item.name, item.value, 'CSRF 防护头', 'csrf');
  }
  // 多租户 / 多应用 API 的上下文头（如 x-tenant-id、x-app-id），不带往往直接 403
  const contextHeaders = [...found.contextHeaders.values()].sort((a, b) => b.count - a.count).slice(0, 4);
  for (const item of contextHeaders) {
    pushHeader(item.name, item.value, '应用上下文头', 'context');
  }

  // ---------------- 过期时间 ----------------
  let expiresAt = null;
  if (isPlausibleExp(auth.token?.claims?.exp)) {
    expiresAt = new Date(auth.token.claims.exp * 1000).toISOString();
  } else if (auth.kind === 'cookie' && auth.items.length > 0) {
    const times = auth.items.map((item) => item.expiresAt).filter(Boolean);
    if (times.length > 0) expiresAt = times.sort()[0];
  }

  // ---------------- 风险提示 ----------------
  const warnings = [];
  if (!page.https) {
    warnings.push({ id: 'insecure', level: 'warn', text: '站点未使用 HTTPS，凭证在传输过程中可能被截获。' });
  }
  if (auth.kind === 'none') {
    warnings.push({ id: 'no-credential', level: 'danger', text: '没有识别到可用的认证凭证，请确认已完成登录。' });
  }
  if (auth.kind === 'none' && page.loginPageLikely) {
    warnings.push({ id: 'login-page', level: 'info', text: '当前页面看起来仍是登录页，请先完成登录再分析。' });
  }
  if (isPlausibleExp(auth.token?.claims?.exp) && auth.token.claims.exp * 1000 < now) {
    warnings.push({ id: 'expired', level: 'danger', text: '识别到的 Token 已过期（JWT exp 早于当前时间），请重新登录后再分析。' });
  }
  if (found.invalidBearer > 0 && found.bearer.length === 0 && auth.kind !== 'none') {
    warnings.push({
      id: 'invalid-bearer',
      level: 'info',
      text: '页面发出的 Authorization 头里没有真实 Token（空值或前端占位值），说明登录态并不依赖 Bearer；已按 Cookie / 存储中的凭证识别。',
    });
  }
  if (found.queryTokens.length > 0) {
    warnings.push({ id: 'query-token', level: 'warn', text: '凭证出现在 URL 查询参数中，容易被日志或 Referer 泄露。' });
  }
  if (requests.length === 0) {
    warnings.push({
      id: 'no-requests',
      level: 'info',
      text: '没有捕获到网络请求：启用后请刷新页面，让采集脚本在页面加载时注入，再重新分析。',
    });
  }
  if (headers.filter((h) => /^(cookie|authorization)$/i.test(h.name)).length > 1) {
    warnings.push({
      id: 'multi',
      level: 'info',
      text: '站点同时使用 Cookie 与 Token，调用接口时需一并携带，建议使用「复制用法说明」。',
    });
  }
  if (refreshToken) {
    warnings.push({ id: 'refresh-token', level: 'info', text: '同时发现 refresh_token，可用它换取新的 access_token。' });
  }
  if (mechanismId === 'unknown' && auth.kind !== 'none') {
    warnings.push({ id: 'unknown-mech', level: 'warn', text: '未匹配到已知鉴权特征，凭证按启发式规则汇总，请人工确认。' });
  }
  if (auth.kind === 'basic') {
    warnings.push({ id: 'basic', level: 'warn', text: 'Basic 凭证等同于账号密码，请勿分享给不可信的第三方。' });
  }
  if (page.loginPageLikely && auth.kind !== 'none') {
    warnings.push({ id: 'login-form', level: 'info', text: '页面中仍存在密码输入框，若凭证不完整请先完成登录。' });
  }

  // ---------------- 需要额外授权的域名 ----------------
  const suggestedOrigins = [];
  for (const [host, origin] of found.hosts) {
    if (host === page.host) continue;
    if (!sameSite(host, page.host)) continue;
    if (isProviderHost(host)) continue;
    if (suggestedOrigins.some((item) => item.host === host)) continue;
    suggestedOrigins.push({ host, origin, reason: '该域名参与了登录或接口请求' });
  }
  const parent = parentDomain(page.host);
  if (cookies.length === 0 && parent) {
    if (!suggestedOrigins.some((item) => item.host === parent)) {
      suggestedOrigins.push({ host: parent, origin: `https://${parent}`, reason: '登录 Cookie 可能在父域名（当前权限读不到）' });
    }
    warnings.push({
      id: 'parent-domain',
      level: 'info',
      params: { parent },
      text: `没有读取到任何 Cookie。若登录 Cookie 设置在父域名 .${parent}（尤其是 HttpOnly），需要补充授权 ${parent} 才能读取完整登录态。`,
    });
  }

  if (suggestedOrigins.length > 0) {
    warnings.push({
      id: 'suggested-origins',
      level: 'info',
      params: { hosts: suggestedOrigins.map((item) => item.host).join(', ') },
      text: `检测到其他相关域名：${suggestedOrigins.map((item) => item.host).join('、')}，可补充授权后重新分析。`,
    });
  }

  // ---------------- 后续建议 ----------------
  const nextSteps = [];
  if (requests.length === 0) nextSteps.push('启用后刷新页面，再点击分析，可以捕获更多请求与响应。');
  if (auth.kind === 'cookie') nextSteps.push('Cookie 在退出登录或会话超时后失效，失效后重新登录并再次分析即可。');
  if (auth.kind === 'bearer') nextSteps.push('接口返回 401 时，请检查 Token 是否过期，或重新登录后再次分析。');
  if (auth.kind === 'basic') nextSteps.push('Basic 凭证由账号密码生成，修改密码后需要重新分析。');
  if (suggestedOrigins.length > 0) nextSteps.push('如果登录发生在其他域名，请先补充授权，再刷新登录页重新分析。');
  if (auth.kind !== 'none') nextSteps.push('复制时优先使用「带 Prompt」，其中包含完整的请求头与使用约束。');

  // ---------------- 可选凭证载体（供“高级自定义”使用） ----------------
  const selectedCookieNames = new Set(headerCookies.map((cookie) => cookie.name));
  const cookieOptions = credentialCookies
    .filter((cookie) => !TRACKING_COOKIE.test(cookie.name))
    .slice(0, 20)
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      expiresAt: cookie.expiresAt,
      selected: selectedCookieNames.has(cookie.name),
    }));

  const queryOptions = found.queryTokens.slice(0, 5).map((item) => ({
    name: item.name,
    value: item.value,
    url: item.url,
    selected: false,
  }));

  // ---------------- 统计 ----------------
  const stats = {
    cookies: cookies.length,
    authCookies: authCookies.length,
    requests: requests.length,
    loginRequests: found.loginRequests,
    storageEntries: storage.local.length + storage.session.length,
  };

  return {
    version: 1,
    analyzedAt: new Date(now).toISOString(),
    origin: page.origin,
    host: page.host,
    url: page.url,
    title: page.title,
    referrer: page.referrer,
    auth,
    headers,
    evidence: evidence.list,
    alternatives: ranked
      .filter((item) => item.id !== mechanismId && item.score >= 8)
      .slice(0, 3)
      .map((item) => ({
        id: item.id,
        label: (MECHANISMS[item.id] || MECHANISMS.unknown).label,
        confidence: clamp(Math.round(100 - 60 * Math.exp(-item.score / 28)) - 6, 5, 90),
      })),
    warnings,
    nextSteps,
    suggestedOrigins,
    cookieOptions,
    queryOptions,
    stats,
  };
}

function buildAuth(picked, candidates, authCookies, found, bestToken) {
  if (picked === 'cookie' && candidates.cookie) {
    const cookies = candidates.cookie.cookies;
    const raw = cookieHeaderValue(cookies);
    const expiries = cookies.map((cookie) => cookie.expiresAt).filter(Boolean).sort();
    const jwtCookie = cookies
      .map((cookie) => ({ cookie, claims: isJwt(cookie.value) ? decodeJwt(cookie.value) : null }))
      .find((item) => item.claims);
    return {
      kind: 'cookie',
      label: jwtCookie ? `JWT Cookie（${jwtCookie.cookie.name}）` : `会话 Cookie（${cookies.length} 个）`,
      raw,
      headerName: 'Cookie',
      headerValue: raw,
      scheme: '',
      items: cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        session: cookie.session,
        expiresAt: cookie.expiresAt,
      })),
      token: jwtCookie
        ? { value: jwtCookie.cookie.value, format: 'jwt', claims: jwtCookie.claims, source: 'cookie' }
        : null,
      expiresAt: expiries[0] || null,
      source: 'cookie',
      sourceLabel: '浏览器 Cookie',
      sourceLabelKey: 'cookie',
      multiCredential: false,
    };
  }

  if (picked === 'token' && candidates.token) {
    const token = candidates.token;
    const claims = isJwt(token.value) ? decodeJwt(token.value) : null;
    return {
      kind: 'bearer',
      label: claims ? 'Bearer Token（JWT）' : 'Bearer Token',
      raw: token.value,
      headerName: 'Authorization',
      headerValue: `Bearer ${token.value}`,
      scheme: 'Bearer',
      items: [],
      token: {
        value: token.value,
        format: claims ? 'jwt' : 'opaque',
        claims,
        source: token.source,
      },
      expiresAt: isPlausibleExp(claims?.exp) ? new Date(claims.exp * 1000).toISOString() : null,
      source: token.source,
      sourceLabel: sourceLabelFor(token),
      sourceLabelKey: token.source === 'request' ? 'request' : token.source === 'response' ? 'response' : 'storage',
      multiCredential: false,
    };
  }

  if (picked === 'customToken' && candidates.customToken) {
    const item = candidates.customToken;
    return {
      kind: 'custom-header',
      label: `自定义 Token 头（${item.name}）`,
      raw: item.value,
      headerName: item.name,
      headerValue: item.value,
      scheme: '',
      items: [],
      token: { value: item.value, format: isJwt(item.value) ? 'jwt' : 'opaque', claims: isJwt(item.value) ? decodeJwt(item.value) : null, source: 'request' },
      expiresAt: isJwt(item.value) && decodeJwt(item.value)?.exp ? new Date(decodeJwt(item.value).exp * 1000).toISOString() : null,
      source: 'request',
      sourceLabel: '请求头',
      sourceLabelKey: 'request',
      multiCredential: false,
    };
  }

  if (picked === 'apiKey' && candidates.apiKey) {
    const item = candidates.apiKey;
    return {
      kind: 'api-key',
      label: `API Key（${item.name}）`,
      raw: item.value,
      headerName: item.name,
      headerValue: item.value,
      scheme: '',
      items: [],
      token: null,
      expiresAt: null,
      source: 'request',
      sourceLabel: '请求头',
      sourceLabelKey: 'request',
      multiCredential: false,
    };
  }

  if (picked === 'basic' && candidates.basic) {
    const item = candidates.basic;
    return {
      kind: 'basic',
      label: 'HTTP Basic 凭证',
      raw: item.value,
      headerName: 'Authorization',
      headerValue: `Basic ${item.value}`,
      scheme: 'Basic',
      items: [],
      token: null,
      expiresAt: null,
      source: 'request',
      sourceLabel: '请求头',
      sourceLabelKey: 'request',
      multiCredential: false,
    };
  }

  return {
    kind: 'none',
    label: '未识别',
    raw: '',
    headerName: '',
    headerValue: '',
    scheme: '',
    items: [],
    token: null,
    expiresAt: null,
    source: 'none',
    sourceLabel: '',
    sourceLabelKey: '',
    multiCredential: false,
  };
}
