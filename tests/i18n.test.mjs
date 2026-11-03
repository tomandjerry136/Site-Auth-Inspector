/**
 * 中英文本地化测试：
 *  - 词典完整性（中英 key 必须一致、代码里用到的 key 都存在）
 *  - 语言识别、插值、默认模板
 *  - 分析报告文本（机制 / 判断依据 / 提示 / 来源）的英文渲染
 *  - 悬浮框用的 chrome.i18n messages 全覆盖
 *
 * 用法：node --test tests/i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zh } from '../src/lib/locales/zh.js';
import { en } from '../src/lib/locales/en.js';
import {
  applyLanguageSetting,
  getLocale,
  has,
  localizeCredentialLabel,
  localizeEvidence,
  localizeMechanism,
  localizeSourceLabel,
  localizeWarning,
  resolveLocale,
  setLocale,
  t,
} from '../src/lib/i18n.js';
import { DEFAULT_PROMPT_TEMPLATE, defaultPromptTemplate } from '../src/lib/settings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('中英词典 key 完全一致', () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys);
  assert.ok(zhKeys.length > 300, `词典条目偏少：${zhKeys.length}`);
});

test('词典没有空文案（判断依据的 detail 允许为空）', () => {
  const allowEmpty = (key) => key.endsWith('.detail');
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string', `zh.${key} 应该是字符串`);
    if (!allowEmpty(key)) assert.ok(value.trim().length > 0, `zh.${key} 为空`);
  }
  for (const [key, value] of Object.entries(en)) {
    if (!allowEmpty(key)) assert.ok(value.trim().length > 0, `en.${key} 为空`);
  }
});

test('HTML 的 data-i18n 与 JS 的 t() key 都存在于两种语言', () => {
  const files = walk(join(ROOT, 'src'));
  const keys = new Set();

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.html')) {
      for (const match of text.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria-label)?="([^"]+)"/g)) {
        keys.add(match[1]);
      }
      for (const match of text.matchAll(/__MSG_(\w+)__/g)) keys.add(`manifest.${match[1]}`);
    }
    if (file.endsWith('.js')) {
      for (const match of text.matchAll(/\bt\('([a-zA-Z0-9_.-]+)'/g)) {
        if (match[1] !== 'key') keys.add(match[1]);
      }
    }
  }

  const missingZh = [...keys].filter((key) => !(key in zh));
  const missingEn = [...keys].filter((key) => !(key in en));
  assert.deepEqual(missingZh, [], `缺少中文文案：${missingZh}`);
  assert.deepEqual(missingEn, [], `缺少英文文案：${missingEn}`);
  assert.ok(keys.size > 80, `代码里识别到的 key 偏少：${keys.size}`);
});

test('语言识别：中文 / 英文 / 其他', () => {
  assert.equal(resolveLocale('zh-CN'), 'zh');
  assert.equal(resolveLocale('zh'), 'zh');
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('en_GB'), 'en');
  assert.equal(resolveLocale('fr-FR'), 'en');
  assert.equal(resolveLocale(''), 'en');
});

test('t() 支持插值，缺 key 时回退中文再回退 key', () => {
  assert.equal(t('popup.recording', {}, 'zh'), '记录中');
  assert.equal(t('popup.recording', {}, 'en'), 'Recording');
  assert.equal(t('popup.result.source', { source: 'x' }, 'zh'), '来自：x');
  assert.equal(t('popup.result.source', { source: 'x' }, 'en'), 'From: x');
  assert.equal(t('不存在的 key', {}, 'en'), '不存在的 key');
  assert.equal(has('popup.recording', 'en'), true);
  assert.equal(has('nope', 'en'), false);
});

test('默认模板随语言切换，且中文模板保持原样（便于迁移）', () => {
  assert.equal(defaultPromptTemplate('zh'), DEFAULT_PROMPT_TEMPLATE);
  const english = defaultPromptTemplate('en');
  assert.ok(english.includes('## Request headers'));
  assert.ok(english.includes('{{headers}}'));
  assert.ok(!english.includes('## 请求头'));
  assert.equal(DEFAULT_PROMPT_TEMPLATE.includes('## 请求头'), true);
});

test('手动语言设置：auto 跟随浏览器，zh/en 固定', () => {
  const previous = getLocale();
  setLocale('zh');
  assert.equal(applyLanguageSetting('en'), 'en');
  assert.equal(getLocale(), 'en');
  assert.equal(applyLanguageSetting('zh'), 'zh');
  assert.equal(applyLanguageSetting('auto'), 'zh', '测试环境无 chrome.i18n，回退中文');
  setLocale(previous);
});

test('setLocale 会固定当前语言', () => {
  const previous = getLocale();
  setLocale('en');
  assert.equal(getLocale(), 'en');
  assert.equal(t('popup.retry'), 'Analyze again');
  setLocale(previous);
});

test('机制名 / 凭证标签 / 来源的英文渲染', () => {
  assert.equal(localizeMechanism('bearer-token', 'zh'), null);
  assert.equal(localizeMechanism('bearer-token', 'en').name, 'Bearer token (Authorization header)');
  assert.equal(localizeMechanism('unknown-id', 'en'), null);
  assert.equal(localizeCredentialLabel('cookie', 2, 'en'), 'Session cookies (2)');
  assert.equal(localizeCredentialLabel('bearer', 0, 'en'), 'Bearer token');
  assert.equal(localizeSourceLabel('cookie', '浏览器 Cookie', 'en'), 'Browser cookies');
  assert.equal(localizeSourceLabel('', '自定义', 'en'), '自定义');
});

test('判断依据 / 提示按 id + params 翻译', () => {
  const evidence = {
    id: 'cookie-set',
    title: '识别到 2 个疑似会话 Cookie',
    detail: 'sid、app_session',
    params: { count: 2, names: 'sid、app_session' },
  };
  assert.equal(localizeEvidence(evidence, 'zh'), evidence);
  const english = localizeEvidence(evidence, 'en');
  assert.equal(english.title, '2 likely session cookies found');
  assert.equal(english.detail, 'sid、app_session');

  const warning = {
    id: 'parent-domain',
    level: 'info',
    text: '没有读取到任何 Cookie……',
    params: { parent: 'example.com' },
  };
  assert.match(localizeWarning(warning, 'en').text, /example\.com/);
  assert.equal(localizeWarning({ id: 'custom-unknown', text: '原样' }, 'en').text, '原样');
});

// ---------------------------------------------------------------------------
// 悬浮框（内容脚本走 chrome.i18n，不能 import 模块）
// ---------------------------------------------------------------------------
function readMessages(name) {
  return JSON.parse(readFileSync(join(ROOT, '_locales', name, 'messages.json'), 'utf8'));
}

test('_locales 中英 key 一致，且包含 manifest 用到的文案', () => {
  const zhMsgs = readMessages('zh_CN');
  const enMsgs = readMessages('en');
  assert.deepEqual(Object.keys(enMsgs).sort(), Object.keys(zhMsgs).sort());

  const manifest = readFileSync(join(ROOT, 'manifest.json'), 'utf8');
  const manifestKeys = [...manifest.matchAll(/__MSG_(\w+)__/g)].map((match) => match[1]);
  assert.ok(manifestKeys.length >= 3);
  for (const key of manifestKeys) {
    assert.ok(zhMsgs[key], `zh 缺少 manifest 文案 ${key}`);
    assert.ok(enMsgs[key], `en 缺少 manifest 文案 ${key}`);
    assert.ok(zhMsgs[key].message.trim().length > 0);
    assert.ok(enMsgs[key].message.trim().length > 0);
  }
  assert.equal(manifest.includes('"default_locale"'), true);
});

test('悬浮框里 tr() 用到的每个 key 都有中英文案', () => {
  const collector = readFileSync(join(ROOT, 'src', 'injected', 'collector.js'), 'utf8');
  const keys = [...collector.matchAll(/tr\('([a-zA-Z0-9_]+)'/g)].map((match) => match[1]);
  assert.ok(keys.length >= 20, `识别到的 tr() key 偏少：${keys.length}`);

  const zhMsgs = readMessages('zh_CN');
  const enMsgs = readMessages('en');
  for (const key of new Set(keys)) {
    assert.ok(zhMsgs[key], `zh_CN 缺少 ${key}`);
    assert.ok(enMsgs[key], `en 缺少 ${key}`);
    // 带参数的文案要保留占位符
    const zhText = zhMsgs[key].message;
    const enText = enMsgs[key].message;
    assert.equal(/\$\d/.test(zhText), /\$\d/.test(enText), `${key} 中英占位符不一致`);
  }
});