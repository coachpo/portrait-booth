/**
 * Template disclosure (TMP-002): fetching restriction phrases and source notes.
 * The single source for capabilities copy is ./policy.ts (round-3 convention);
 * this module only re-exports and never builds a second mapping; sourceNotesFor
 * does the locale fallback.
 */

import type { TemplateRevision } from "./types";
import { capabilityRestrictions, type RestrictionPhrase } from "./policy";

export { capabilityRestrictions };
export type { RestrictionPhrase };

/**
 * Fallback per locale → "en" → first available key, returning all entries of
 * the selected locale only, never merging multiple locales; tolerates
 * undefined / {} / missing locale keys.
 */
export function sourceNotesFor(rev: TemplateRevision, locale: string): string[] {
  const notes = rev.sourceNotes;
  if (!notes) return [];
  const keys = Object.keys(notes);
  if (keys.length === 0) return [];
  const pick = [locale, "en", "zh", keys[0]].find((k) => notes[k] !== undefined);
  if (!pick) return [];
  return notes[pick] ?? [];
}
