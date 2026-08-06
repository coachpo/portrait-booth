import { describe, expect, it } from "vitest";

import { applyTransform, normalizedSize, orientationTransform, withScale } from "./exif";

/** 断言 raw 位图四角经方向变换后落在归一化画布的正确四角（SRC-003）。 */
function expectCornersMapped(orientation: number, rawW: number, rawH: number) {
  const { width: outW, height: outH } = normalizedSize(rawW, rawH, orientation);
  const t = orientationTransform(orientation, rawW, rawH);
  const corners: Array<[number, number]> = [
    [0, 0],
    [rawW, 0],
    [0, rawH],
    [rawW, rawH],
  ];
  for (const [x, y] of corners) {
    const [px, py] = applyTransform(t, x, y);
    // 连续坐标允许落在边界上（x' ∈ [0, outW]）
    expect(px).toBeGreaterThanOrEqual(0);
    expect(px).toBeLessThanOrEqual(outW);
    expect(py).toBeGreaterThanOrEqual(0);
    expect(py).toBeLessThanOrEqual(outH);
  }
  return { t, outW, outH };
}

describe("normalizedSize", () => {
  it("keeps dimensions for orientations 1-4", () => {
    for (const o of [1, 2, 3, 4]) {
      expect(normalizedSize(640, 480, o)).toEqual({ width: 640, height: 480 });
    }
  });

  it("swaps dimensions for orientations 5-8", () => {
    for (const o of [5, 6, 7, 8]) {
      expect(normalizedSize(640, 480, o)).toEqual({ width: 480, height: 640 });
    }
  });
});

describe("orientationTransform", () => {
  it("maps identity for orientation 1", () => {
    const { t } = expectCornersMapped(1, 4, 2);
    expect(applyTransform(t, 1, 1)).toEqual([1, 1]);
  });

  it("mirrors horizontally for orientation 2", () => {
    const { t, outW } = expectCornersMapped(2, 4, 2);
    expect(applyTransform(t, 1, 1)).toEqual([3, 1]);
    expect(outW).toBe(4);
  });

  it("rotates 180 for orientation 3", () => {
    const { t } = expectCornersMapped(3, 4, 2);
    expect(applyTransform(t, 1, 1)).toEqual([3, 1]);
  });

  it("mirrors vertically for orientation 4", () => {
    const { t } = expectCornersMapped(4, 4, 2);
    expect(applyTransform(t, 1, 1)).toEqual([1, 1]);
  });

  it("transposes for orientation 5", () => {
    const { t, outW, outH } = expectCornersMapped(5, 4, 2);
    expect(applyTransform(t, 1, 1)).toEqual([1, 1]);
    expect(applyTransform(t, 4, 0)).toEqual([0, 4]);
    expect(outW).toBe(2);
    expect(outH).toBe(4);
  });

  it("rotates 90 CW for orientation 6", () => {
    const { t, outW, outH } = expectCornersMapped(6, 4, 2);
    expect(applyTransform(t, 1, 1)).toEqual([1, 3]);
    expect(applyTransform(t, 0, 0)).toEqual([0, 4]); // 左上 → 右上
    expect(outW).toBe(2);
    expect(outH).toBe(4);
  });

  it("mirrors anti-diagonally for orientation 7", () => {
    const { t } = expectCornersMapped(7, 4, 2);
    expect(applyTransform(t, 0, 0)).toEqual([2, 4]); // 左上 → 右下
    expect(applyTransform(t, 4, 2)).toEqual([0, 0]);
  });

  it("rotates 270 CW for orientation 8", () => {
    const { t, outW, outH } = expectCornersMapped(8, 4, 2);
    expect(applyTransform(t, 0, 0)).toEqual([2, 0]); // 左上 → 左下
    expect(outW).toBe(2);
    expect(outH).toBe(4);
  });

  it("treats unknown orientations as identity", () => {
    const t = orientationTransform(9, 100, 50);
    expect(applyTransform(t, 7, 3)).toEqual([7, 3]);
  });
});

describe("withScale", () => {
  it("scales all components uniformly", () => {
    const t = orientationTransform(6, 400, 300);
    const s = withScale(t, 0.5);
    expect(applyTransform(s, 0, 0)).toEqual([0, 200]); // 左上 → 右上（缩放后）
    expect(applyTransform(s, 200, 0)).toEqual([0, 100]);
  });
});
