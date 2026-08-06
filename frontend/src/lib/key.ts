/**
 * 取回码的输入归一化与显示（SAV-007）。
 *
 * 服务端只接受 6 位大写字母数字。输入期就归一化，用户粘贴带空格、
 * 连字符或小写的取回码时不会被一句「格式错误」挡在门外。
 */

const KEY_LENGTH = 6;
const ALLOWED = /[A-Z0-9]/;

/** 去掉分隔符与大小写差异，截断到 6 位。 */
export function normalizeKeyInput(raw: string): string {
  const chars: string[] = [];
  for (const ch of raw.toUpperCase()) {
    if (ALLOWED.test(ch)) chars.push(ch);
    if (chars.length === KEY_LENGTH) break;
  }
  return chars.join("");
}

/** 分组显示：ABC DEF。与服务端 keyDisplay 的分组一致。 */
export function formatKeyGroups(normalized: string): string {
  if (normalized.length <= 3) return normalized;
  return `${normalized.slice(0, 3)} ${normalized.slice(3)}`;
}

export function isCompleteKey(normalized: string): boolean {
  return normalized.length === KEY_LENGTH;
}

export { KEY_LENGTH };
