import { describe, expect, it } from "vitest";

import { ALL_GUIDANCE_HINTS, formatGuidance } from "./guidance-text";
import type { GuidanceHint } from "./tracking";

describe("formatGuidance (O4)", () => {
  it("joins out-of-position hints with full-width commas and a period (O4)", () => {
    expect(formatGuidance("out-of-position", ["move-closer", "move-own-right"], "zh")).toBe(
      "人脸位置需调整：请靠近一些，请向你自己的右侧移动。",
    );
  });

  it("returns the whole sentence for terminal states without empty fragments (O4)", () => {
    expect(formatGuidance("no-face", [], "zh")).toBe("未检测到人脸：请进入画面。");
    expect(formatGuidance("multi-face", [], "zh")).toBe("检测到多张人脸：请确保画面中只有一个人。");
    // ready 文案必须保留「非官方容差」（与 checks 的 HEURISTIC_NOTICE 措辞不同，不得合并）
    expect(formatGuidance("ready", [], "zh")).toBe(
      "姿势稳定，可以拍摄（启发式判断，非官方容差）。",
    );
  });

  it("formats unstable hints in yaw/pitch/roll order (O4)", () => {
    expect(
      formatGuidance("unstable", ["turn-own-right", "raise-head", "level-own-left"], "zh"),
    ).toBe("姿势需调整：请向你自己的右侧转一点，请抬头一点，请把头向你自己的左侧摆正。");
    expect(formatGuidance("unstable", [], "zh")).toBe("姿势需调整：请保持当前姿势。");
  });

  it("falls back to zh for unknown locales (O4)", () => {
    expect(formatGuidance("ready", [], "en")).toBe(
      "姿势稳定，可以拍摄（启发式判断，非官方容差）。",
    );
  });

  it("covers every hint with a Chinese phrase (O4)", () => {
    for (const hint of ALL_GUIDANCE_HINTS) {
      const text = formatGuidance("unstable", [hint], "zh");
      expect(text.length).toBeGreaterThan("姿势需调整：".length);
    }
    // 全部 hint 都应在映射表内（Record<联合类型> 编译期已穷尽；这里做运行期兜底）
    const all: GuidanceHint[] = [...ALL_GUIDANCE_HINTS];
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });

  it("keeps the shell for out-of-position fallback hint (O4)", () => {
    expect(formatGuidance("out-of-position", ["adjust-position"], "zh")).toBe(
      "人脸位置需调整：请调整站位。",
    );
  });
});
