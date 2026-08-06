import { describe, expect, it } from "vitest";

import { applyTransform, type Transform2D } from "../image/exif";
import {
  clampTranslation,
  coverScale,
  IDENTITY_TRANSFORM,
  invert,
  isValidTransform,
  normalizeRotationDeg,
  renderMatrix,
  type EditTransform,
} from "./edit-transform";

const SRC = { width: 200, height: 100 };
const OUT = { width: 100, height: 100 };

function at(m: Transform2D, x: number, y: number): [number, number] {
  return applyTransform(m, x, y);
}

describe("cover math (§4.5.1)", () => {
  it("picks the larger axis ratio", () => {
    expect(coverScale({ width: 200, height: 100 }, { width: 100, height: 100 })).toBe(1);
    expect(coverScale({ width: 50, height: 100 }, { width: 100, height: 100 })).toBe(2);
    expect(coverScale({ width: 100, height: 200 }, { width: 100, height: 100 })).toBe(1);
  });

  it("centers a wider source", () => {
    const m = renderMatrix(IDENTITY_TRANSFORM, SRC, OUT);
    expect(at(m, 0, 0)).toEqual([-50, 0]); // 源左边缘 → 画布外左侧
    expect(at(m, 100, 50)).toEqual([50, 50]); // 源中心 → 画布中心
    expect(at(m, 200, 100)).toEqual([150, 100]); // 源右边缘 → 画布外右侧
  });

  it("scales up a taller source to cover", () => {
    const m = renderMatrix(IDENTITY_TRANSFORM, { width: 50, height: 100 }, OUT);
    expect(at(m, 0, 0)).toEqual([0, -50]);
    expect(at(m, 50, 100)).toEqual([100, 150]);
  });
});

describe("renderMatrix composition (cover → scale → flipX → rotation → translation)", () => {
  it("applies user scale relative to cover around the canvas center", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, scale: 2 };
    const m = renderMatrix(t, SRC, OUT);
    expect(at(m, 0, 0)).toEqual([-150, -50]); // 源左边缘 → 画布左外
    expect(at(m, 100, 50)).toEqual([50, 50]); // 中心不动
    expect(at(m, 200, 100)).toEqual([250, 150]);
  });

  it("mirrors horizontally around the canvas center", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, flipX: true };
    const m = renderMatrix(t, SRC, OUT);
    expect(at(m, 0, 0)).toEqual([150, 0]); // 源左边缘 → 画布右外
    expect(at(m, 100, 50)).toEqual([50, 50]); // 中心不动
    expect(at(m, 200, 100)).toEqual([-50, 100]);
  });

  it("translates in normalized output units", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.5, translateY: -0.5 };
    const m = renderMatrix(t, SRC, OUT);
    expect(at(m, 0, 0)).toEqual([0, -50]);
    expect(at(m, 100, 50)).toEqual([100, 0]);
  });

  it("rotates around the canvas center (90°)", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, rotationDeg: 90 };
    const m = renderMatrix(t, SRC, OUT);
    const [cx, cy] = at(m, 100, 50);
    expect(cx).toBeCloseTo(50, 9); // 中心不动
    expect(cy).toBeCloseTo(50, 9);
    // 源 (0,0) → cover+scale(-50,0) → 绕中心旋转 → (0,150)
    const [x, y] = at(m, 0, 0);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(150, 9);
  });

  it("composes all five operations in order", () => {
    const t: EditTransform = {
      translateX: 0.25,
      translateY: 0.1,
      scale: 1.5,
      rotationDeg: 90,
      flipX: true,
    };
    const m = renderMatrix(t, SRC, OUT);
    // 源中心 (100,50) → cover 到画布中心 → 所有绕中心操作不变 → 仅平移生效
    expect(at(m, 100, 50)).toEqual([75, 60]);
  });
});

describe("isValidTransform (EDT-003)", () => {
  it("accepts identity cover", () => {
    expect(isValidTransform(IDENTITY_TRANSFORM, SRC, OUT)).toBe(true);
  });

  it("rejects under-covered rotation", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, rotationDeg: 45 };
    expect(isValidTransform(t, SRC, OUT)).toBe(false);
  });

  it("accepts rotation once scale covers the rotated bounds", () => {
    const t: EditTransform = {
      ...IDENTITY_TRANSFORM,
      rotationDeg: 45,
      scale: 1.5,
    };
    expect(isValidTransform(t, { width: 300, height: 300 }, OUT)).toBe(true);
  });

  it("rejects translation that exposes an edge", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.75 };
    expect(isValidTransform(t, SRC, OUT)).toBe(false);
  });

  it("accepts x-translation at high scale (y is edge-bound)", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.5, translateY: 0, scale: 4 };
    expect(isValidTransform(t, SRC, OUT)).toBe(true);
  });

  it("rejects y-translation beyond cover at scale 1", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateY: 0.1 };
    expect(isValidTransform(t, SRC, OUT)).toBe(false);
  });
});

describe("clampTranslation (EDT-003)", () => {
  it("keeps valid transforms unchanged", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.2 };
    expect(clampTranslation(t, SRC, OUT)).toEqual(t);
  });

  it("projects an over-translated point back to the valid region", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 5, translateY: 5 };
    const c = clampTranslation(t, SRC, OUT);
    expect(isValidTransform(c, SRC, OUT)).toBe(true);
    expect(c.translateX).toBeLessThan(1);
    expect(c.scale).toBe(1);
  });

  it("clamps toward the nearest boundary along the center ray", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.8 };
    const c = clampTranslation(t, SRC, OUT);
    // 恰好 cover 时 x 方向最多平移 0.5（源宽 200，画布 100，cover 1x）
    expect(c.translateX).toBeCloseTo(0.5, 3);
    expect(isValidTransform(c, SRC, OUT)).toBe(true);
  });
});

describe("invert", () => {
  it("round-trips a composed matrix", () => {
    const t: EditTransform = {
      translateX: 0.3,
      translateY: -0.2,
      scale: 2.5,
      rotationDeg: 30,
      flipX: true,
    };
    const m = renderMatrix(t, SRC, OUT);
    const inv = invert(m);
    for (const [x, y] of [
      [0, 0],
      [100, 50],
      [200, 100],
    ] as Array<[number, number]>) {
      const [mx, my] = at(m, x, y);
      const [bx, by] = at(inv, mx, my);
      expect(bx).toBeCloseTo(x, 6);
      expect(by).toBeCloseTo(y, 6);
    }
  });
});

describe("normalizeRotationDeg", () => {
  it("wraps to (-180, 180]", () => {
    expect(normalizeRotationDeg(370)).toBe(10);
    expect(normalizeRotationDeg(-190)).toBe(170);
    expect(normalizeRotationDeg(90)).toBe(90);
    expect(normalizeRotationDeg(-90)).toBe(-90);
  });
});
