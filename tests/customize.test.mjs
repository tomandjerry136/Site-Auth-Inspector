/**
 * 高级自定义：候选整理、选择清洗、自定义复制内容。
 *
 * 用法：node --test tests/customize.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../src/lib/analyzer.js';
import { attachCopies } from '../src/lib/format.js';
import {
  buildCandidates,
  buildCustomCopies,
  getSavedSelection,
  normalizeSelection,
} from '../src/lib/customize.js';

function makeJwt(payload = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: 'demo-user',
    exp: now + 3600,
    ...payload,
  })}.c2lnbmF0dXJl`;
}

const JWT = makeJwt();

function cookie(name, value, overrides = {}) {
  return {
    name,
    value,
    domain: 'example.com',
    path: '/',
    httpOnly: true,
    secure: true,
    session: false,
    expirationDate: Math.floor(Date.now() / 1000) + 86400,
    ...overrides,
  };
}

function makeReport() {
  return attachCopies(
    analyze({
      page: { url: 'https://example.com/console', origin: 'https://example.com', host: 'example.com' },
      cookies: [
        cookie('sid', 'sess-abc'),
        cookie('is_login', '1', { httpOnly: false }),
        cookie('_ga', 'GA1.2.3', { httpOnly: false }),
      ],
      requests: [
        {
          url: 'https://example.com/api/me',
          method: 'GET',
          status: 200,
          headers: { authorization: `Bearer ${JWT}`, 'x-csrf-token': 'csrf-1' },
        },
      ],
    }),
    {},
  );
}

test('候选列表：不含 Cookie 汇总头，排除埋点 Cookie', () => {
  const report = makeReport();
  const candidates = buildCandidates(report);
  const names = candidates.map((item) => `${item.source}:${item.name}`);

  assert.ok(names.includes('header:Authorization'));
  assert.ok(names.includes('header:x-csrf-token'));
  assert.ok(names.includes('cookie:sid'));
  assert.ok(names.includes('cookie:is_login'));
  assert.ok(!names.includes('cookie:_ga'), '埋点 Cookie 不应成为候选项');
  assert.ok(!names.some((name) => /^header:Cookie$/i.test(name)), 'Cookie 头拆成单项，不再重复出现');
  assert.ok(
    candidates.filter((item) => item.source !== 'query').every((item) => item.enabled),
    '推荐项默认勾选',
  );
});

test('只保留 Cookie：输出 Cookie 头，不再带 Authorization', () => {
  const report = makeReport();
  const candidates = buildCandidates(report);
  const selection = candidates.map((item) => ({ ...item, enabled: item.source === 'cookie' }));
  const copies = buildCustomCopies(report, selection, {});

  assert.equal(copies.raw, 'sid=sess-abc; is_login=1');
  assert.match(copies.headers, /^Cookie: sid=sess-abc; is_login=1$/m);
  assert.ok(!copies.headers.includes('Authorization'), '请求头里不应再有 Authorization');
  assert.ok(!copies.prompt.includes('Authorization: Bearer'), '用法说明里也不应再出现 Authorization 头');
  assert.match(copies.prompt, /认证方式[\s\S]*Cookie 会话/, '认证方式随选择更新');
});

test('只保留请求头 + 追加 URL 参数：纯值附带参数，说明里有参数段', () => {
  const report = makeReport();
  const selection = [
    ...buildCandidates(report).map((item) => ({ ...item, enabled: item.source === 'header' })),
    { source: 'query', name: 'debug', value: '1', enabled: true },
  ];
  const copies = buildCustomCopies(report, selection, {});

  assert.equal(copies.raw, `${JWT}\ndebug=1`);
  assert.match(copies.headers, /^Authorization: Bearer /m);
  assert.match(copies.prompt, /## URL 参数/);
  assert.match(copies.prompt, /- debug=1/);
  assert.ok(!copies.headers.includes('Cookie'), '未勾选 Cookie 时不应出现 Cookie 头');
});

test('全部取消勾选：输出为空，不会残留旧凭证', () => {
  const report = makeReport();
  const copies = buildCustomCopies(
    report,
    buildCandidates(report).map((item) => ({ ...item, enabled: false })),
    {},
  );
  assert.equal(copies.raw, '');
  assert.equal(copies.headers, '');
  assert.equal(copies.summary.total, 0);
});

test('自定义 JSON 脏数据会被清洗：去空名、限制数量、去重', () => {
  const report = makeReport();
  const selection = normalizeSelection(report, [
    { source: 'header', name: 'X-Trace-Id', value: 'abc', enabled: true },
    { source: 'header', name: '', value: 'skip' },
    { source: 'cookie', name: 'sid', value: 'v', enabled: false },
    { source: 'weird', name: 'X-Weird', value: '1' },
    { source: 'header', name: 'x-trace-id', value: 'dup' },
  ]);
  assert.equal(selection.length, 3);
  assert.ok(selection.every((item) => item.name.trim().length > 0));
  assert.equal(new Set(selection.map((item) => item.id)).size, selection.length, 'id 不重复');
  assert.equal(selection.find((item) => item.name === 'X-Weird').source, 'header');
});

test('恢复上次保存的自定义选择', () => {
  const report = makeReport();
  const saved = [
    { source: 'header', name: 'Authorization', value: `Bearer ${JWT}`, enabled: true },
    { source: 'cookie', name: 'sid', value: 'sess-abc', enabled: false },
  ];
  const withCustom = { ...report, custom: { selection: saved } };
  const selection = getSavedSelection(withCustom);
  assert.equal(selection.length, 2);
  assert.equal(selection.find((item) => item.source === 'cookie').enabled, false);
  assert.equal(selection.find((item) => item.source === 'header').enabled, true);
});