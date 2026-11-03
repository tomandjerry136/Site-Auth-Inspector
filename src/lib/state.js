/**
 * 扩展的本地状态读写。
 *  - sites / settings / reportMeta 存放在 chrome.storage.local（长期保存，不含凭证）
 *  - 完整分析结果（含凭证）存放在 chrome.storage.session（随浏览器会话清除）
 */

import { attachCopies } from './format.js';
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_SETTINGS } from './settings.js';
import { buildCustomCopies } from './customize.js';

const SETTINGS_KEY = 'settings';
const SITES_KEY = 'sites';
const REPORT_META_KEY = 'reportMeta';
const FLOWS_KEY = 'flows';
const REPORTS_KEY = 'reports';

async function readLocal(key, fallback) {
  const data = await chrome.storage.local.get(key);
  return data[key] ?? fallback;
}

export async function getSettings() {
  const stored = await readLocal(SETTINGS_KEY, null);
  const settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  // 旧版本会把中文默认模板整段存下来；迁移成空值，让模板跟随界面语言
  if (settings.promptTemplate === DEFAULT_PROMPT_TEMPLATE) settings.promptTemplate = '';
  return settings;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings() {
  const next = { ...DEFAULT_SETTINGS };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getSites() {
  const sites = await readLocal(SITES_KEY, {});
  return sites && typeof sites === 'object' ? sites : {};
}

export async function getSite(host) {
  const sites = await getSites();
  return sites[host] || null;
}

export async function upsertSite(host, patch) {
  const sites = await getSites();
  const next = { ...(sites[host] || { host }), ...patch };
  sites[host] = next;
  await chrome.storage.local.set({ [SITES_KEY]: sites });
  return next;
}

export async function removeSite(host) {
  const sites = await getSites();
  delete sites[host];
  await chrome.storage.local.set({ [SITES_KEY]: sites });
}

export async function getReportMeta(host) {
  const meta = await readLocal(REPORT_META_KEY, {});
  return (meta && meta[host]) || null;
}

export async function setReportMeta(host, value) {
  const meta = await readLocal(REPORT_META_KEY, {});
  if (value) meta[host] = value;
  else delete meta[host];
  await chrome.storage.local.set({ [REPORT_META_KEY]: meta });
}

export async function clearReportMeta(host) {
  await setReportMeta(host, null);
}

export async function getReport(host) {
  const reports = await readSession(REPORTS_KEY, {});
  return reports[host] || null;
}

export async function setReport(host, report) {
  const reports = await readSession(REPORTS_KEY, {});
  reports[host] = report;
  await chrome.storage.session.set({ [REPORTS_KEY]: reports });
}

export async function clearReport(host) {
  const reports = await readSession(REPORTS_KEY, {});
  if (!(host in reports)) return;
  delete reports[host];
  await chrome.storage.session.set({ [REPORTS_KEY]: reports });
}

/** 「开始记录」状态（按站点）：用于弹出页面内悬浮框与避免重复弹窗 */
export async function getFlow(host) {
  const flows = await readLocal(FLOWS_KEY, {});
  return (flows && flows[host]) || null;
}

export async function setFlow(host, value) {
  const flows = await readLocal(FLOWS_KEY, {});
  if (value) flows[host] = value;
  else delete flows[host];
  await chrome.storage.local.set({ [FLOWS_KEY]: flows });
  return value || null;
}

export async function clearFlow(host) {
  await setFlow(host, null);
}

/** 修改提示词模板后，刷新已有分析结果的 copies，避免复制出旧模板文本。 */
export async function refreshReportCopies(settings) {
  const reports = await readSession(REPORTS_KEY, {});
  const hosts = Object.keys(reports);
  if (hosts.length === 0) return;
  const next = {};
  for (const host of hosts) {
    const report = reports[host];
    const updated = attachCopies(report, settings);
    // 用户做过「高级自定义」时，自定义结果也要按新语言/模板重新生成
    if (report?.custom?.selection) {
      const custom = buildCustomCopies(report, report.custom.selection, settings);
      updated.custom = {
        ...report.custom,
        copies: { raw: custom.raw, prompt: custom.prompt, headers: custom.headers },
        headers: custom.report.headers,
        auth: {
          kind: custom.report.auth.kind,
          label: custom.report.auth.label,
          raw: custom.report.auth.raw,
          sourceLabel: report.custom.auth?.sourceLabel || '',
          sourceLabelKey: report.custom.auth?.sourceLabelKey || 'custom',
        },
        summary: custom.summary,
      };
    }
    next[host] = updated;
  }
  await chrome.storage.session.set({ [REPORTS_KEY]: next });
}

async function readSession(key, fallback) {
  try {
    const data = await chrome.storage.session.get(key);
    return data[key] ?? fallback;
  } catch {
    return fallback;
  }
}