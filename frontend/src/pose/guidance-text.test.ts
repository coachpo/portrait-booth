import { describe, expect, it } from "vitest";

import { ALL_GUIDANCE_HINTS, formatGuidance } from "./guidance-text";
import type { GuidanceHint } from "./tracking";

describe("formatGuidance (O4)", () => {
  it("joins out-of-position hints with comma-space and a period (O4)", () => {
    expect(formatGuidance("out-of-position", ["move-closer", "move-own-right"], "en")).toBe(
      "Face position needs adjustment: move a little closer, move to your own right.",
    );
  });

  it("returns the whole sentence for terminal states without empty fragments (O4)", () => {
    expect(formatGuidance("no-face", [], "en")).toBe(
      "No face detected: please step into the frame.",
    );
    expect(formatGuidance("multi-face", [], "en")).toBe(
      "Multiple faces detected: please make sure only one person is in the frame.",
    );
    // ready copy must keep "not official tolerance" (wording differs from
    // checks' HEURISTIC_NOTICE; must not be merged)
    expect(formatGuidance("ready", [], "en")).toBe(
      "Pose stable, ready to shoot (heuristic judgment, not official tolerance).",
    );
  });

  it("formats unstable hints in yaw/pitch/roll order (O4)", () => {
    expect(
      formatGuidance("unstable", ["turn-own-right", "raise-head", "level-own-left"], "en"),
    ).toBe(
      "Pose needs adjustment: turn slightly to your own right, raise your head a little, tilt your head to your own left to level it.",
    );
    expect(formatGuidance("unstable", [], "en")).toBe("Pose needs adjustment: hold this pose.");
  });

  it("falls back to en for unknown locales (O4)", () => {
    expect(formatGuidance("ready", [], "zh")).toBe(
      "Pose stable, ready to shoot (heuristic judgment, not official tolerance).",
    );
  });

  it("covers every hint with an English phrase (O4)", () => {
    for (const hint of ALL_GUIDANCE_HINTS) {
      const text = formatGuidance("unstable", [hint], "en");
      expect(text.length).toBeGreaterThan("Pose needs adjustment: ".length);
    }
    // Every hint must be inside the mapping table (Record<union type> is
    // exhaustive at compile time; this is a runtime backstop)
    const all: GuidanceHint[] = [...ALL_GUIDANCE_HINTS];
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });

  it("keeps the shell for out-of-position fallback hint (O4)", () => {
    expect(formatGuidance("out-of-position", ["adjust-position"], "en")).toBe(
      "Face position needs adjustment: adjust your position.",
    );
  });
});
