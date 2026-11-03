/**
 * 自定义复制内容：
 *  - 勾选 / 编辑 / 删除 / 新增「请求头、Cookie、URL 参数」
 *  - 右侧实时预览「登录信息」「用法说明」「请求时带上这些」
 *  - 改动自动保存到会话报告，popup 里的复制按钮同步更新
 */

import { getSettings } from './lib/state.js';
import {
  applyI18n,
  applyLanguageSetting,
  has,
  localizeCredentialLabel,
  localizeMechanism,
  t,
} from './lib/i18n.js';
import {
  buildCandidates,
  buildCustomCopies,
  getSavedSelection,
  normalizeSelection,
} from './lib/customize.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const host = params.get('host') || '';
const SOURCE_LABEL = () => ({
  header: t('customize.source.header'),
  cookie: t('customize.source.cookie'),
  query: t('customize.source.query'),
});

const state = {
  report: null,
  selection: [],
  settings: null,
  filter: 'all',
  busy: false,
  saveTimer: null,
  previewTimer: null,
  savedAt: null,
  error: '',
};

init().catch((error) => {
  console.error(error);
  setSiteLine(t('popup.loadFailed', { message: error?.message || error }));
  toast(t('customize.error.load'));
});

async function init() {
  applyI18n();
  if (!host) {
    setSiteLine(t('customize.noHost'));
    showEmpty(t('customize.empty.message'));
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'CA_GET_CUSTOMIZE', host });
  if (!response?.ok) {
    setSiteLine(host);
    showEmpty(response?.error || t('customize.empty.noReport'));
    return;
  }

  state.report = response.report;
  state.settings = (await getSettings()) || {};
  state.selection = Array.isArray(response.selection) && response.selection.length
    ? normalizeSelection(response.report, response.selection)
    : getSavedSelection(response.report);

  const auth = response.report?.auth || {};
  const mechanismName = localizeMechanism(auth.mechanismId)?.name || auth.mechanism || t('mech.unknown.short');
  setSiteLine(`${host} · ${mechanismName}`);
  $('back-link').href = `${chrome.runtime.getURL('src/popup.html')}?host=${encodeURIComponent(host)}`;
  bindEvents();
  renderRows();
  renderPreview();
  renderSummary();
}

function setSiteLine(text) {
  $('site-line').textContent = text;
}

function showEmpty(message) {
  $('rows').innerHTML = '';
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = message;
  $('rows').append(empty);
  $('add-form').classList.add('hidden');
  $('reset-btn').classList.add('hidden');
}

function bindEvents() {
  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    state.filter = tab.dataset.filter;
    for (const button of $('tabs').querySelectorAll('.tab')) {
      button.classList.toggle('is-active', button === tab);
    }
    renderRows();
  });

  $('rows').addEventListener('input', (event) => {
    const input = event.target.closest('input[data-role]');
    if (!input) return;
    const row = input.closest('.row');
    const item = state.selection.find((entry) => entry.id === row.dataset.id);
    if (!item) return;
    if (input.dataset.role === 'value') item.value = input.value;
    if (input.dataset.role === 'name') item.name = input.value;
    schedulePreview();
    scheduleSave();
  });

  $('rows').addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    const row = checkbox.closest('.row');
    const item = state.selection.find((entry) => entry.id === row.dataset.id);
    if (!item) return;
    item.enabled = checkbox.checked;
    row.classList.toggle('is-off', !checkbox.checked);
    schedulePreview();
    scheduleSave();
    renderSummary();
  });

  $('rows').addEventListener('click', (event) => {
    const remove = event.target.closest('.remove');
    if (!remove) return;
    const row = remove.closest('.row');
    state.selection = state.selection.filter((entry) => entry.id !== row.dataset.id);
    renderRows();
    schedulePreview();
    scheduleSave();
    renderSummary();
  });

  $('add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    addCustomItem();
  });

  $('reset-btn').addEventListener('click', () => {
    state.selection = buildCandidates(state.report);
    renderRows();
    schedulePreview();
    saveNow();
    renderSummary();
    toast(t('customize.toast.reset'));
  });

  $('copy-raw').addEventListener('click', () => copyButton('raw', $('copy-raw')));
  $('copy-prompt').addEventListener('click', () => copyButton('prompt', $('copy-prompt')));
  $('copy-headers').addEventListener('click', () => copyButton('headers', $('copy-headers')));

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveNow();
    }
  });
}

function addCustomItem() {
  const source = $('add-source').value;
  const name = $('add-name').value.trim();
  const value = $('add-value').value;
  if (!name) {
    toast(t('customize.toast.needName'));
    return;
  }
  if (state.selection.some((item) => item.source === source && item.name.toLowerCase() === name.toLowerCase())) {
    toast(t('customize.toast.duplicate'));
    return;
  }
  state.selection.push({
    id: `${source}:${name.toLowerCase()}`,
    source,
    name,
    value,
    note: t('customize.note.custom'),
    enabled: true,
  });
  $('add-name').value = '';
  $('add-value').value = '';
  state.filter = 'all';
  for (const button of $('tabs').querySelectorAll('.tab')) {
    button.classList.toggle('is-active', button.dataset.filter === 'all');
  }
  renderRows();
  schedulePreview();
  saveNow();
  renderSummary();
  toast(t('customize.toast.added'));
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function renderRows() {
  const container = $('rows');
  container.innerHTML = '';
  const items = state.selection.filter(
    (item) => state.filter === 'all' || item.source === state.filter,
  );

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = t('customize.empty.rows');
    container.append(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = `row${item.enabled ? '' : ' is-off'}`;
    row.dataset.id = item.id;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = item.enabled;
    check.setAttribute('aria-label', t('customize.toggleAria', { name: item.name }));

    const fields = document.createElement('div');
    fields.className = 'fields';

    const name = document.createElement('input');
    name.type = 'text';
    name.value = item.name;
    name.dataset.role = 'name';
    name.setAttribute('aria-label', t('customize.nameAria'));
    name.spellcheck = false;

    const value = document.createElement('input');
    value.type = 'text';
    value.value = item.value;
    value.dataset.role = 'value';
    value.setAttribute('aria-label', t('customize.valueAria'));
    value.spellcheck = false;

    fields.append(name, value);

    if (item.note) {
      const note = document.createElement('p');
      note.className = 'note';
      const noteText = localizeNote(item);
      if (!noteText) {
        fields.classList.add('no-note');
      } else {
        note.textContent = t('customize.notePrefix', {
          source: SOURCE_LABEL()[item.source] || '',
          note: noteText,
        });
      }
      fields.append(note);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = t('customize.remove');
    remove.setAttribute('aria-label', t('customize.removeAria', { name: item.name }));

    row.append(check, fields, remove);
    container.append(row);
  }
}

/** 备注本地化：优先用 noteKey；旧数据里存的是中文，用别名兜底 */
const NOTE_ALIASES = {
  自定义: 'customize.note.custom',
  HttpOnly: 'customize.note.httpOnly',
  '出现在 URL 里': 'customize.note.fromQuery',
  '来自推荐请求头': 'customize.note.fromHeader',
  认证凭证: 'note.cred',
  'CSRF 防护头': 'note.csrf',
  应用上下文头: 'note.context',
  '会话 Cookie': 'note.cred',
  'Bearer Token': 'note.cred',
  'HTTP Basic 凭证': 'note.cred',
  'API Key': 'note.cred',
  '自定义 Token 头': 'note.cred',
  '同时需要的会话 Cookie': 'note.cred',
  '同时携带的 Token': 'note.cred',
};

function localizeNote(item) {
  if (item.noteKey) {
    const headerKey = `note.${item.noteKey}`;
    const customKey = `customize.note.${item.noteKey}`;
    if (has(headerKey)) return t(headerKey);
    if (has(customKey)) return t(customKey);
  }
  const alias = NOTE_ALIASES[item.note || ''];
  if (alias && has(alias)) return t(alias);
  return item.note || '';
}

function renderSummary() {
  const enabled = state.selection.filter((item) => item.enabled);
  const count = (source) => enabled.filter((item) => item.source === source).length;
  $('summary').textContent = t('customize.summary', {
    total: enabled.length,
    headers: count('header'),
    cookies: count('cookie'),
    query: count('query'),
  });
}

function schedulePreview() {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(renderPreview, 80);
}

function renderPreview() {
  if (!state.report) return;
  const copies = buildCustomCopies(state.report, state.selection, state.settings || {});

  setCode($('preview-raw'), copies.raw || t('customize.preview.emptyRaw'));
  setCode($('preview-headers'), copies.headers || t('customize.preview.emptyHeaders'));
  setCode($('preview-prompt'), copies.prompt || t('customize.preview.emptyPrompt'));

  $('copy-raw').disabled = !copies.raw;
  $('copy-headers').disabled = !copies.headers;
  $('copy-prompt').disabled = !copies.prompt;
}

function setCode(element, text) {
  element.textContent = text;
  element.classList.toggle('is-empty', !text || text === t('customize.preview.emptyRaw') || text === t('customize.preview.emptyHeaders') || text === t('customize.preview.emptyPrompt'));
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------
function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 600);
}

async function saveNow() {
  clearTimeout(state.saveTimer);
  if (!state.report) return;
  const selection = normalizeSelection(state.report, state.selection);
  setSaveState(t('customize.save.saving'), false);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CA_SAVE_CUSTOMIZE',
      host,
      selection,
    });
    if (!response?.ok) throw new Error(response?.error || t('customize.save.failed', { message: '' }));
    const summary = response.summary || {};
    state.savedAt = new Date();
    setSaveState(
      t('customize.save.saved', {
        headers: summary.headers ?? 0,
        cookies: summary.cookies ?? 0,
        query: summary.query ?? 0,
      }),
      false,
    );
  } catch (error) {
    setSaveState(t('customize.save.failed', { message: error?.message || error }), true);
  }
}

function setSaveState(text, isError) {
  const element = $('save-state');
  element.textContent = text;
  element.classList.toggle('is-error', Boolean(isError));
}

// ---------------------------------------------------------------------------
// 复制 / 提示
// ---------------------------------------------------------------------------
async function copyButton(kind, button) {
  const copies = buildCustomCopies(state.report, state.selection, state.settings || {});
  const text = kind === 'raw' ? copies.raw : kind === 'prompt' ? copies.prompt : copies.headers;
  if (!text) {
    toast(t('customize.toast.noContent'));
    return;
  }
  const ok = await writeClipboard(text);
  toast(ok ? t('customize.toast.copied') : t('customize.toast.copyFailed'));
  if (ok) {
    const original = button.textContent;
    button.textContent = t('customize.toast.copied');
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 回退 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

let toastTimer = null;
function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('is-visible'), 1800);
}