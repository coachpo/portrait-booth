/**
 * 非破坏性编辑变换（EDT-001, §4.5.1）。
 * 只保存参数快照，不重采样位图；预览与终态渲染共用 renderMatrix。
 * 矩阵约定：列向量、CSS 像素中心坐标，组合顺序 cover → scale → flipX → rotation → translation。
 */

import type { Transform2D } from "../image/exif";
import type { TemplateRevision } from "../lib/templates/types";

export interface EditTransform {
  /** 归一化到输出宽度 */
  translateX: number;
  /** 归一化到输出高度 */
  translateY: number;
  /** 相对「刚好 cover」的倍率，>= 1（EDT-004 下限） */
  scale: number;
  rotationDeg: number;
  flipX: boolean;
}

export const IDENTITY_TRANSFORM: EditTransform = {
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotationDeg: 0,
  flipX: false,
};

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

export interface Rect {
  width: number;
  height: number;
}

export function coverScale(src: Rect, out: Rect): number {
  return Math.max(out.width / src.width, out.height / src.height);
}

/** 列向量矩阵组合：a · b（先应用 b） */
function compose(a: Transform2D, b: Transform2D): Transform2D {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

export function invert(m: Transform2D): Transform2D {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) throw new Error("singular matrix");
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  const e = -(a * m.e + c * m.f);
  const f = -(b * m.e + d * m.f);
  return { a, b, c, d, e, f };
}

const identity = (): Transform2D => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** 把方向已归一化的源位图映射到输出画布的最终矩阵（§4.5.1）。 */
export function renderMatrix(transform: EditTransform, src: Rect, out: Rect): Transform2D {
  const cs = coverScale(src, out);
  const offX = (out.width - src.width * cs) / 2;
  const offY = (out.height - src.height * cs) / 2;
  const theta = (transform.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const cx = out.width / 2;
  const cy = out.height / 2;

  // cover：缩放后按缩放后尺寸居中（单一仿射）
  const CS: Transform2D = { a: cs, b: 0, c: 0, d: cs, e: offX, f: offY };
  // 用户 scale 绕画布中心放大（中心不动，EDT-004）
  const S: Transform2D = { a: transform.scale, b: 0, c: 0, d: transform.scale, e: 0, f: 0 };
  const T_center: Transform2D = { a: 1, b: 0, c: 0, d: 1, e: cx, f: cy };
  const T_centerBack: Transform2D = { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy };
  const F: Transform2D = transform.flipX
    ? { a: -1, b: 0, c: 0, d: 1, e: out.width, f: 0 }
    : identity();
  const R: Transform2D = { a: cos, b: -sin, c: sin, d: cos, e: 0, f: 0 };
  const T_trans: Transform2D = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: transform.translateX * out.width,
    f: transform.translateY * out.height,
  };

  // 从右到左：cover → 绕中心用户缩放 → 镜像 → 绕中心旋转 → 平移
  return compose(
    T_trans,
    compose(
      T_center,
      compose(
        R,
        compose(T_centerBack, compose(F, compose(T_center, compose(S, compose(T_centerBack, CS))))),
      ),
    ),
  );
}

/** 裁剪框四角是否全部落在源图内（EDT-003：不允许透明/空白边缘）。 */
export function isValidTransform(transform: EditTransform, src: Rect, out: Rect): boolean {
  const inv = invert(renderMatrix(transform, src, out));
  const corners: Array<[number, number]> = [
    [0, 0],
    [out.width, 0],
    [0, out.height],
    [out.width, out.height],
  ];
  for (const [x, y] of corners) {
    const sx = inv.a * x + inv.c * y + inv.e;
    const sy = inv.b * x + inv.d * y + inv.f;
    if (sx < -1e-6 || sx > src.width + 1e-6 || sy < -1e-6 || sy > src.height + 1e-6) return false;
  }
  return true;
}

/**
 * 把平移投影回合法区域：合法集为含中心 (0,0) 的凸多边形，
 * 沿中心到目标点的线段二分找最近合法点（EDT-003）。
 */
export function clampTranslation(transform: EditTransform, src: Rect, out: Rect): EditTransform {
  if (isValidTransform(transform, src, out)) return transform;
  const base: EditTransform = { ...transform, translateX: 0, translateY: 0 };
  const tx = transform.translateX;
  const ty = transform.translateY;
  let lo = 0;
  let hi = 1;
  // 线段参数 t：合法则提高 lo，非法则降低 hi
  const probe = (t: number): boolean => {
    const candidate: EditTransform = { ...base, translateX: tx * t, translateY: ty * t };
    return isValidTransform(candidate, src, out);
  };
  if (!probe(1)) {
    for (let i = 0; i < 24 && hi - lo > 1e-5; i++) {
      const mid = (lo + hi) / 2;
      if (probe(mid)) lo = mid;
      else hi = mid;
    }
  }
  return { ...base, translateX: tx * lo, translateY: ty * lo };
}

/**
 * 让当前旋转角合法所需的最小 scale（EDT-003）。
 *
 * 旋转是绕画布中心做的，即使源图原本刚好 cover，任意非零角度都会把裁剪框的角
 * 甩出源图边界——差几度就足以在成品四角留下透明像素，JPEG 编码后表现为黑角。
 * isValidTransform 对 scale 单调，直接二分即可。返回 null 表示 MAX_SCALE 也救不回来。
 */
export function minScaleForRotation(
  transform: EditTransform,
  src: Rect,
  out: Rect,
  maxScale: number = MAX_SCALE,
): number | null {
  const at = (scale: number): boolean =>
    isValidTransform({ ...transform, translateX: 0, translateY: 0, scale }, src, out);
  if (at(transform.scale)) return transform.scale;
  if (!at(maxScale)) return null;
  let lo = Math.max(MIN_SCALE, transform.scale);
  let hi = maxScale;
  for (let i = 0; i < 30 && hi - lo > 1e-4; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * 把任意变换投影成合法变换：先补足旋转所需的 scale，再把平移拉回合法区域。
 * 编辑器每次改动后都应该经过这里，终态渲染只做最后一道断言。
 *
 * maxScale 允许收紧上限——EDT-004 要求分辨率不足时不得无限放大。
 * 上限不足以覆盖当前角度时保持 scale 不动，由调用方给出可见的警告。
 */
export function fitTransform(
  transform: EditTransform,
  src: Rect,
  out: Rect,
  maxScale: number = MAX_SCALE,
): EditTransform {
  const scale = minScaleForRotation(transform, src, out, maxScale);
  if (scale === null) return clampTranslation(transform, src, out);
  return clampTranslation({ ...transform, scale }, src, out);
}

/** 模板渲染尺寸；portal_source/guidance_only 模板不需要本地编辑 */
export function outputSize(rev: TemplateRevision): { width: number; height: number } | null {
  switch (rev.output.kind) {
    case "exact_pixels":
      return { width: rev.output.widthPx, height: rev.output.heightPx };
    case "ranged_pixels":
      return { width: rev.output.defaultWidthPx, height: rev.output.defaultHeightPx };
    case "physical_raster":
      return { width: rev.output.widthPx, height: rev.output.heightPx };
    default:
      return null;
  }
}

export interface OutputSizeOption {
  width: number;
  height: number;
}

/**
 * ranged_pixels 模板的候选尺寸档（P6）。
 * allowedSizes 存在时严格用它（并剔除不满足 min/max 与宽高比的项）；
 * 不存在时只返回 {default, max} 两档，两者相同则一档。候选集只含官方
 * 支撑的值，不凭空生造中间档（SPEC:446 推导值不得冒充官方原文）。
 * 非 ranged 的 kind 一律返回空数组。
 */
export function allowedOutputSizes(rev: TemplateRevision): OutputSizeOption[] {
  const out = rev.output;
  if (out.kind !== "ranged_pixels") return [];
  const inRange = (w: number, h: number) =>
    w >= out.minWidthPx &&
    w <= out.maxWidthPx &&
    h >= out.minHeightPx &&
    h <= out.maxHeightPx &&
    w * out.aspect.height === h * out.aspect.width;
  if (out.allowedSizes && out.allowedSizes.length > 0) {
    return out.allowedSizes
      .map((s) => ({ width: s.widthPx, height: s.heightPx }))
      .filter((s) => inRange(s.width, s.height));
  }
  const cands: OutputSizeOption[] = [
    { width: out.defaultWidthPx, height: out.defaultHeightPx },
    { width: out.maxWidthPx, height: out.maxHeightPx },
  ];
  return cands.filter(
    (c, i) => cands.findIndex((x) => x.width === c.width && x.height === c.height) === i,
  );
}

/**
 * 选定尺寸的解析入口（P6）：非 ranged 一律忽略 selected 与 outputSize 行为
 * 完全一致；ranged 时 selected 为空、越界、破宽高比或不在白名单内都回落
 * default。所有消费方（确认页/编辑器/终态渲染/检查摘要/服务端除外）共用。
 */
export function resolveOutputSize(
  rev: TemplateRevision,
  selected?: OutputSizeOption | null,
): OutputSizeOption | null {
  if (rev.output.kind !== "ranged_pixels") return outputSize(rev);
  const fallback = {
    width: rev.output.defaultWidthPx,
    height: rev.output.defaultHeightPx,
  };
  if (!selected) return fallback;
  const valid = allowedOutputSizes(rev).some(
    (s) => s.width === selected.width && s.height === selected.height,
  );
  return valid ? selected : fallback;
}

export interface EditorHistory {
  undo: EditTransform[];
  redo: EditTransform[];
}

/** 编辑器的完整可恢复状态：从终态页返回时原样带回来，裁剪参数与撤销栈都不丢。 */
export interface EditorState {
  transform: EditTransform;
  history: EditorHistory;
}

export const INITIAL_EDITOR_STATE: EditorState = {
  transform: IDENTITY_TRANSFORM,
  history: { undo: [], redo: [] },
};

export type ReprojectNote = "refit" | "reset" | "mirror-cleared" | "rotation-cleared";

function sameTransform(a: EditTransform, b: EditTransform): boolean {
  return (
    a.translateX === b.translateX &&
    a.translateY === b.translateY &&
    a.scale === b.scale &&
    a.rotationDeg === b.rotationDeg &&
    a.flipX === b.flipX
  );
}

/**
 * 换模板投影（SPEC:95「更换模板必须重新计算裁剪…不可静默沿用不兼容变换」）。
 * 固定顺序：按新模板 capabilities 归一化 → fitTransform 重新适配输出尺寸 →
 * 仍不合法则回落 IDENTITY_TRANSFORM；history 每一项走同一条流水线，栈长度不变。
 */
export function reprojectEditorState(
  state: EditorState,
  src: Rect,
  rev: TemplateRevision,
): { state: EditorState; notes: ReprojectNote[] } {
  const notes: ReprojectNote[] = [];
  const normalize = (t: EditTransform): EditTransform => {
    const next = { ...t };
    if (rev.capabilities.mirror === "forbidden") next.flipX = false;
    if (rev.capabilities.rotate === "forbidden") next.rotationDeg = 0;
    return next;
  };
  const out = outputSize(rev);
  const project = (t: EditTransform): EditTransform => {
    const next = normalize(t);
    if (out === null) return next;
    const fitted = fitTransform(next, src, out);
    return isValidTransform(fitted, src, out) ? fitted : { ...IDENTITY_TRANSFORM };
  };

  let transform = normalize(state.transform);
  if (state.transform.flipX && rev.capabilities.mirror === "forbidden") {
    notes.push("mirror-cleared");
  }
  if (state.transform.rotationDeg !== 0 && rev.capabilities.rotate === "forbidden") {
    notes.push("rotation-cleared");
  }
  if (out !== null) {
    const fitted = fitTransform(transform, src, out);
    if (!sameTransform(fitted, transform)) {
      transform = fitted;
      notes.push("refit");
    }
    if (!isValidTransform(transform, src, out)) {
      transform = { ...IDENTITY_TRANSFORM };
      notes.push("reset");
    }
  }

  return {
    state: {
      transform,
      history: {
        undo: state.history.undo.map(project),
        redo: state.history.redo.map(project),
      },
    },
    notes,
  };
}

/** 剪辑旋转到 ±360°，方便撤销栈比较。 */
export function normalizeRotationDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
