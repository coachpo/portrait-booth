/**
 * Retrieval-code input normalization and display (SAV-007).
 *
 * The server only accepts 6 uppercase alphanumeric characters. Normalizing
 * during input means pasting a code with spaces, hyphens, or lowercase never
 * gets blocked by a "format error".
 */

const KEY_LENGTH = 6;
const ALLOWED = /[A-Z0-9]/;

/** Strip separators and case differences, truncating to 6 characters. */
export function normalizeKeyInput(raw: string): string {
  const chars: string[] = [];
  for (const ch of raw.toUpperCase()) {
    if (ALLOWED.test(ch)) chars.push(ch);
    if (chars.length === KEY_LENGTH) break;
  }
  return chars.join("");
}

/** Grouped display: ABC DEF. Matches the server keyDisplay grouping. */
export function formatKeyGroups(normalized: string): string {
  if (normalized.length <= 3) return normalized;
  return `${normalized.slice(0, 3)} ${normalized.slice(3)}`;
}

export function isCompleteKey(normalized: string): boolean {
  return normalized.length === KEY_LENGTH;
}

export { KEY_LENGTH };
