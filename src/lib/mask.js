/**
 * 凭证脱敏展示工具（只用于界面与证据描述，复制时始终使用原值）。
 */

export function maskSecret(value, options = {}) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '';
  const head = Number.isInteger(options.head) ? options.head : 8;
  const tail = Number.isInteger(options.tail) ? options.tail : 4;
  if (text.length <= head + tail + 3) return '•'.repeat(Math.min(16, Math.max(6, text.length)));
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** 截断长文本，用于证据描述，避免把完整凭证写进报告。 */
export function brief(value, max = 64) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}