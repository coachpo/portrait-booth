/**
 * Pose guidance copy formatting (O4). Pure TS, no react import.
 * tracking.ts only produces GuidanceHint keys; English wording and punctuation
 * live in this module.
 * The language key currently recognizes only "en"; any other value falls back
 * to en.
 */

import type { GuidanceHint, GuidanceStatus } from "./tracking";

export const ALL_GUIDANCE_HINTS: readonly GuidanceHint[] = [
  "move-closer",
  "move-farther",
  "move-own-left",
  "move-own-right",
  "move-up",
  "move-down",
  "adjust-position",
  "turn-own-left",
  "turn-own-right",
  "raise-head",
  "lower-head",
  "level-own-left",
  "level-own-right",
  "hold-still",
];

const EN_HINTS: Record<GuidanceHint, string> = {
  "move-closer": "move a little closer",
  "move-farther": "move a little farther away",
  "move-own-left": "move to your own left",
  "move-own-right": "move to your own right",
  "move-up": "move up a little",
  "move-down": "move down a little",
  "adjust-position": "adjust your position",
  "turn-own-left": "turn slightly to your own left",
  "turn-own-right": "turn slightly to your own right",
  "raise-head": "raise your head a little",
  "lower-head": "lower your head a little",
  "level-own-left": "tilt your head to your own left to level it",
  "level-own-right": "tilt your head to your own right to level it",
  "hold-still": "hold this pose",
};

const EN_SHELLS: Record<GuidanceStatus, string> = {
  "no-face": "No face detected: please step into the frame.",
  "multi-face": "Multiple faces detected: please make sure only one person is in the frame.",
  "out-of-position": "Face position needs adjustment: ",
  unstable: "Pose needs adjustment: ",
  ready: "Pose stable, ready to shoot (heuristic judgment, not official tolerance).",
};

/**
 * Joining rule follows the old implementation: fragments joined with ", " and
 * the sentence ends with ".". Only out-of-position / unstable use the
 * "shell + fragments" form; the other three states always have empty hints and
 * return the whole sentence directly, so "No face detected: ." can never be
 * produced.
 */
export function formatGuidance(
  status: GuidanceStatus,
  hints: GuidanceHint[],
  locale: string,
): string {
  if (locale !== "en") return formatGuidance(status, hints, "en");
  if (status === "out-of-position" || status === "unstable") {
    const effective: GuidanceHint[] =
      hints.length > 0 ? hints : [status === "out-of-position" ? "adjust-position" : "hold-still"];
    return `${EN_SHELLS[status]}${effective.map((h) => EN_HINTS[h]).join(", ")}.`;
  }
  return EN_SHELLS[status];
}
