/**
 * 设置页：提示词模板、复制选项、已启用站点管理。
 */

import { formatTime } from './lib/format.js';
import { defaultPromptTemplate, promptPlaceholders } from './lib/settings.js';
import { applyI18n, applyLanguageSetting, getLocale, resolveLanguageSetting, t } from './lib/i18n.js';
import {
  getSettings,
  getSites,
  refreshReportCopies,
  resetSettings,
  saveSettings,
} from './lib/state.js';

const $ = (id) => document.getElementById(id);
let toastTimer = null;
let dirtyBaseline = '';

init().catch((error) => {
  console.error(error);
  toast(t('options.toast.loadFailed'));
});

async function init() {
  const stored = await getSettings();
  applyLanguageSetting(stored.language);
  applyI18n();
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  renderPlaceholders();
  bindEvents();
  await load();
}

/** 切换语言：立即生效并保存（模板仍是默认值时同时切到新语言的默认模板） */
async function onLanguageChange() {
  const value = $('language').value;
  const templateWasDefault =
    $('template').value === defaultPromptTemplate('zh') ||
    $('template').value === defaultPromptTemplate('en');

  applyLanguageSetting(value);
  applyI18n();
  if (templateWasDefault) $('template').value = defaultPromptTemplate(getLocale());
  renderPlaceholders();
  renderSites(await getSites());

  const settings = await saveSettings(collectSettings());
  await refreshReportCopies(settings);
  dirtyBaseline = settings.promptTemplate;
  updateDirtyHint();
  $('language-state').textContent = t('options.language.saved', {
    language: t(`options.language.${resolveLanguageSetting(value)}`),
  });
  toast(t('options.toast.saved'));
}

async function load() {
  const [settings, sites] = await Promise.all([getSettings(), getSites()]);
  $('template').value = settings.promptTemplate || defaultPromptTemplate(getLocale());
  $('language').value = settings.language || 'auto';
  $('include-evidence').checked = settings.includeEvidence !== false;
  $('include-warnings').checked = settings.includeWarnings !== false;
  $('mask-default').checked = settings.maskByDefault !== false;
  renderSites(sites);
  dirtyBaseline = collectSettings().promptTemplate;
}

function collectSettings() {
  const template = $('template').value;
  return {
    language: $('language').value,
    promptTemplate:
      template === defaultPromptTemplate(getLocale()) || template === defaultPromptTemplate('zh')
        ? ''
        : template,
    includeEvidence: $('include-evidence').checked,
    includeWarnings: $('include-warnings').checked,
    maskByDefault: $('mask-default').checked,
  };
}

// ---------------------------------------------------------------------------
// 模板与占位符
// ---------------------------------------------------------------------------
function renderPlaceholders() {
  const container = $('placeholders');
  container.textContent = '';
  for (const item of promptPlaceholders(getLocale())) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `{{${item.key}}}`;
    chip.title = `${item.label}，例如：${item.sample}`;
    chip.dataset.key = item.key;
    container.append(chip);
  }
}

function insertPlaceholder(key) {
  const textarea = $('template');
  const token = `{{${key}}}`;
  const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
  const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start;
  textarea.value = textarea.value.slice(0, start) + token + textarea.value.slice(end);
  textarea.focus();
  const position = start + token.length;
  textarea.setSelectionRange(position, position);
  updateDirtyHint();
}

async function onSave() {
  const button = $('save');
  button.disabled = true;
  try {
    const settings = await saveSettings(collectSettings());
    await refreshReportCopies(settings);
    dirtyBaseline = settings.promptTemplate;
    updateDirtyHint();
    $('save-state').textContent = t('options.savedAt', {
      time: new Date().toLocaleTimeString(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { hour12: false }),
    });
    toast(t('options.toast.saved'));
  } catch (error) {
    toast(t('options.toast.saveFailed', { message: error?.message || error }));
  } finally {
    button.disabled = false;
  }
}

async function onReset() {
  if (!window.confirm(t('options.reset.confirm'))) return;
  try {
    const settings = await resetSettings();
    await refreshReportCopies(settings);
    await load();
    toast(t('options.toast.reset'));
  } catch (error) {
    toast(t('options.toast.resetFailed', { message: error?.message || error }));
  }
}

function updateDirtyHint() {
  const dirty = collectSettings().promptTemplate !== dirtyBaseline;
  $('save-state').textContent = dirty ? t('options.dirty') : '';
}

// ---------------------------------------------------------------------------
// 站点列表
// ---------------------------------------------------------------------------
function renderSites(sites) {
  const list = $('site-list');
  list.textContent = '';
  const entries = Object.values(sites || {}).sort((a, b) =>
    String(a.host || '').localeCompare(String(b.host || '')),
  );
  $('site-empty').classList.toggle('hidden', entries.length > 0);
  list.classList.toggle('hidden', entries.length === 0);

  for (const site of entries) {
    const row = document.createElement('li');
    row.className = 'site-row';

    const info = document.createElement('div');
    info.className = 'site-info';
    const host = document.createElement('b');
    host.textContent = site.host || '';
    const meta = document.createElement('span');
    const parts = [site.origin || ''];
    if (site.enabledAt) parts.push(t('options.siteEnabledAt', { time: formatTime(site.enabledAt) }));
    if (site.lastAnalyzedAt) {
      parts.push(t('options.siteAnalyzedAt', { time: formatTime(site.lastAnalyzedAt) }));
    }
    meta.textContent = parts.filter(Boolean).join(' · ');
    info.append(host, meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-sm';
    remove.textContent = t('options.sites.disable');
    remove.dataset.host = site.host;

    row.append(info, remove);
    list.append(row);
  }
}

async function onSiteListClick(event) {
  const button = event.target.closest('[data-host]');
  if (!button) return;
  const host = button.dataset.host;
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'CA_DISABLE_SITE', host });
    if (!result?.ok) throw new Error(result?.error || '停用失败');
    toast(t('options.toast.disabled', { host }));
    renderSites(await getSites());
  } catch (error) {
    toast(t('options.toast.disableFailed', { message: error?.message || error }));
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------
function bindEvents() {
  $('placeholders').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip) insertPlaceholder(chip.dataset.key);
  });

  $('template').addEventListener('input', updateDirtyHint);
  $('save').addEventListener('click', onSave);
  $('language').addEventListener('change', () => {
    onLanguageChange().catch((error) => {
      toast(t('options.toast.saveFailed', { message: error?.message || error }));
    });
  });
  $('reset').addEventListener('click', onReset);
  $('site-list').addEventListener('click', onSiteListClick);

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave();
    }
  });
}

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('is-visible'), 2000);
}