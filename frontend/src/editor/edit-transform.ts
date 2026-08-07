/**
 * Non-destructive edit transforms (EDT-001, §4.5.1).
 * Only parameter snapshots are kept, never resampled bitmaps; preview and
 * final render share renderMatrix.
 * Matrix convention: column vectors, CSS-pixel center coordinates, composed
 * as cover → scale → flipX → rotation → translation.
 */

import type { Transform2D } from "../image/exif";
import type { TemplateRevision } from "../lib/templates/types";

export interface EditTransform {
  /** Normalized to the output width */
  translateX: number;
  /** Normalized to the output height */
  translateY: number;
  /** Multiplier relative to "exactly cover", >= 1 (EDT-004 floor) */
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

/** Column-vector matrix composition: a · b (applies b first) */
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

/** The final matrix mapping the orientation-normalized source bitmap onto
 * the output canvas (§4.5.1). */
export function renderMatrix(transform: EditTransform, src: Rect, out: Rect): Transform2D {
  const cs = coverScale(src, out);
  const offX = (out.width - src.width * cs) / 2;
  const offY = (out.height - src.height * cs) / 2;
  const theta = (transform.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const cx = out.width / 2;
  const cy = out.height / 2;

  // cover: center at the scaled size after scaling (single affine)
  const CS: Transform2D = { a: cs, b: 0, c: 0, d: cs, e: offX, f: offY };
  // user scale zooms about the canvas center (center fixed, EDT-004)
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

  // Right to left: cover → user scale about center → flip → rotation about
  // center → translation
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

/** Whether all four crop corners fall inside the source (EDT-003: no
 * transparent/blank edges allowed). */
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
 * Project the translation back into the valid region: the valid set is a
 * convex polygon containing the center (0,0); binary-search the segment from
 * the center to the target for the nearest valid point (EDT-003).
 */
export function clampTranslation(transform: EditTransform, src: Rect, out: Rect): EditTransform {
  if (isValidTransform(transform, src, out)) return transform;
  const base: EditTransform = { ...transform, translateX: 0, translateY: 0 };
  const tx = transform.translateX;
  const ty = transform.translateY;
  let lo = 0;
  let hi = 1;
  // Segment parameter t: valid raises lo, invalid lowers hi
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
 * The minimum scale that makes the current rotation angle valid (EDT-003).
 *
 * Rotation happens about the canvas center, so even when the source exactly
 * covers, any nonzero angle throws the crop corners outside the source -
 * a few degrees suffice to leave transparent pixels at the artifact corners,
 * which show as black corners after JPEG encoding. isValidTransform is
 * monotonic in scale, so a plain binary search works. Returns null when even
 * MAX_SCALE cannot save it.
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
 * Project an arbitrary transform into a valid one: first add the scale the
 * rotation needs, then pull the translation back into the valid region.
 * Every editor mutation should go through this; final render only does the
 * last assertion.
 *
 * maxScale allows tightening the ceiling - EDT-004 requires not scaling up
 * without bound when resolution is insufficient. When the ceiling cannot
 * cover the current angle, scale is left alone and the caller shows a
 * visible warning.
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

/** Template render size; portal_source/guidance_only templates need no local
 * editing */
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
 * Candidate size bands for ranged_pixels templates (P6).
 * When allowedSizes exists, use it strictly (dropping items failing
 * min/max and the aspect ratio); otherwise return only the {default, max}
 * pair, one band when equal. The candidate set contains only officially
 * supported values; intermediate bands are never invented (SPEC:446 derived
 * values must not pose as official source text).
 * Non-ranged kinds always return an empty array.
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
 * Resolution entry for the selected size (P6): non-ranged ignores selected
 * and behaves exactly like outputSize; ranged falls back to default when
 * selected is empty, out of range, breaks the aspect, or is not in the
 * whitelist. Shared by all consumers (confirm page/editor/final
 * render/check summary; server excluded).
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

/** The editor's full restorable state: carried back verbatim when returning
 * from the final page; crop parameters and the undo stack are never lost. */
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
 * Template-switch projection (SPEC:95 "switching templates must recompute the
 * crop... incompatible transforms must not be silently carried over").
 * Fixed order: normalize per the new template's capabilities → fitTransform
 * to re-fit the output size → fall back to IDENTITY_TRANSFORM when still
 * invalid; every history entry goes through the same pipeline with the stack
 * length unchanged.
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

/** Clip rotation to ±360°, for easy undo-stack comparison. */
export function normalizeRotationDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
