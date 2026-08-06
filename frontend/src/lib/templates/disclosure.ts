/**
 * 模板披露（TMP-002）：限制短语与来源注记的取数。
 * capabilities 文案映射的唯一来源是 ./policy.ts（第 3 轮约定），
 * 本模块只 re-export，不另建第二份映射；sourceNotesFor 做 locale 回退。
 */

import type { TemplateRevision } from "./types";
import { capabilityRestrictions, type RestrictionPhrase } from "./policy";

export { capabilityRestrictions };
export type { RestrictionPhrase };

/**
 * 按 locale → "zh" → "en" → 第一个可用 key 回退，只返回选中那一个 locale
 * 的全部条目，绝不合并多个 locale；容忍 undefined / {} / 缺 locale 键。
 */
export function sourceNotesFor(rev: TemplateRevision, locale: string): string[] {
  const notes = rev.sourceNotes;
  if (!notes) return [];
  const keys = Object.keys(notes);
  if (keys.length === 0) return [];
  const pick = [locale, "zh", "en", keys[0]].find((k) => notes[k] !== undefined);
  if (!pick) return [];
  return notes[pick] ?? [];
}
