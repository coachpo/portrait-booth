import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SourceImage } from "../image/source";
import { buildOverlayGuides, headEllipse, type OverlayGuide } from "./overlay";
import { entryLabel } from "../lib/templates/catalog";
import { editorPolicy } from "../lib/templates/policy";
import { uiLocale } from "../lib/locale";
import type { TemplateEntry } from "../lib/templates/types";
import { PolicyNotices } from "./policy-notice";
import {
  coverScale,
  fitTransform,
  IDENTITY_TRANSFORM,
  INITIAL_EDITOR_STATE,
  isValidTransform,
  MAX_SCALE,
  MIN_SCALE,
  normalizeRotationDeg,
  outputSize,
  renderMatrix,
  type EditorHistory,
  type EditorState,
  type EditTransform,
  type OutputSizeOption,
} from "./edit-transform";

export interface EditorStepProps {
  source: SourceImage;
  template: TemplateEntry;
  /** State from the last time the editor was left; starts from the
   * initial transform when absent */
  initialState?: EditorState | null;
  /** The user-selected output size for ranged_pixels templates; template
   * default when absent (P6) */
  size?: OutputSizeOption | null;
  onDone: (state: EditorState) => void;
  onBack: (state: EditorState) => void;
}

const UNDO_LIMIT = 50;

/** Step size of one pan button press (normalized to output size) */
const NUDGE_STEP = 0.02;

const BAND_FILL = "rgba(56, 189, 248, 0.18)";
const BAND_EDGE = "rgba(56, 189, 248, 0.9)";
const ELLIPSE_STROKE = "rgba(255, 255, 255, 0.75)";

/**
 * Draw the template's allowed ranges onto the canvas (EDT-008).
 *
 * Before this, the editor only drew a generic rule-of-thirds grid - unrelated
 * to any template rules; the source-verified numbers in cropRules / overlay
 * were completely invisible in the UI.
 */
function drawTemplateOverlay(
  ctx: CanvasRenderingContext2D,
  guides: OverlayGuide[],
  out: { width: number; height: number },
): void {
  const ellipse = headEllipse(guides, out);
  if (ellipse) {
    ctx.save();
    ctx.strokeStyle = ELLIPSE_STROKE;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.ellipse(ellipse.cx, ellipse.cy, ellipse.rx, ellipse.ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  for (const guide of guides) {
    ctx.save();
    ctx.fillStyle = BAND_FILL;
    ctx.strokeStyle = BAND_EDGE;
    ctx.lineWidth = 1;
    if (guide.enforcement !== "mandatory") ctx.setLineDash([4, 4]);

    if (guide.kind === "horizontal-band") {
      ctx.fillRect(0, guide.fromPx, out.width, guide.toPx - guide.fromPx);
      for (const y of [guide.fromPx, guide.toPx]) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(out.width, y);
        ctx.stroke();
      }
    } else if (guide.kind === "vertical-band") {
      ctx.fillRect(guide.fromPx, 0, guide.toPx - guide.fromPx, out.height);
      for (const x of [guide.fromPx, guide.toPx]) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, out.height);
        ctx.stroke();
      }
    } else if (guide.kind === "size-y") {
      // Allowed size is a length constraint, not a position constraint; draw
      // it as a ruler on the right: two segments from the same start, whose
      // lengths are the allowed minimum and maximum.
      // A single (max − min) line is wrong - that is the tolerance width; for
      // a 25–35 mm head height it is only 10 mm long, and users would size
      // their head to a third of the allowed size.
      const x = out.width - 10;
      for (const length of [guide.fromPx, guide.toPx]) {
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x, 8 + length);
        ctx.stroke();
        // End-cap ticks make the two segments' endpoints distinguishable
        ctx.beginPath();
        ctx.moveTo(x - 6, 8 + length);
        ctx.lineTo(x + 4, 8 + length);
        ctx.stroke();
      }
    } else {
      const y = out.height - 10;
      for (const length of [guide.fromPx, guide.toPx]) {
        ctx.beginPath();
        ctx.moveTo(8, y);
        ctx.lineTo(8 + length, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(8 + length, y - 6);
        ctx.lineTo(8 + length, y + 4);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

type History = EditorHistory;

export function EditorStep({
  source,
  template,
  initialState,
  size,
  onDone,
  onBack,
}: EditorStepProps) {
  const out = size ?? outputSize(template.revision);
  const policy = editorPolicy(template.revision);
  const [transform, setTransform] = useState<EditTransform>(() => {
    if (out !== null && policy.composeLocked && initialState) {
      // Composition-lock backstop: inherited scale/translate must not carry
      // over; only rotation/mirror are kept and re-fitted to the new template
      return fitTransform(
        {
          ...IDENTITY_TRANSFORM,
          rotationDeg: initialState.transform.rotationDeg,
          flipX: initialState.transform.flipX,
        },
        { width: source.width, height: source.height },
        out,
      );
    }
    return initialState?.transform ?? IDENTITY_TRANSFORM;
  });
  const [history, setHistory] = useState<History>(initialState?.history ?? { undo: [], redo: [] });
  const [autoScaled, setAutoScaled] = useState(false);
  // With an external transform mounted (returning to edit after a
  // same-session template switch), the out-of-bounds guard must also be
  // evaluated once at mount
  const [outOfBounds, setOutOfBounds] = useState(() => {
    if (out === null) return false;
    const t = initialState?.transform;
    if (!t) return false;
    return !isValidTransform(t, { width: source.width, height: source.height }, out);
  });
  const [showOverlay, setShowOverlay] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null);
  const transformRef = useRef(transform);
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  const src = useMemo(
    () => ({ width: source.width, height: source.height }),
    [source.width, source.height],
  );

  // EDT-004: when cover itself is above 1, the source resolution is already
  // below the template's output requirement. Zoom is not locked here - users
  // still need to adjust composition when resolution is insufficient - but a
  // cannot-be-ignored warning is shown.
  const coverUpscale = useMemo(() => (out ? coverScale(src, out) : 1), [src, out]);
  const guides = useMemo(
    () => (out ? buildOverlayGuides(template.revision, out) : []),
    [template, out],
  );
  const effectiveUpscale = coverUpscale * transform.scale;

  const apply = useCallback(
    (next: EditTransform) => {
      // Clamping translation alone is not enough: rotation is about the canvas
      // center, so any angle throws the crop corners outside the source,
      // leaving transparent pixels at the artifact corners that become black
      // after JPEG encoding. fitTransform first adds the needed scale.
      const fitted = fitTransform(next, src, out!);
      setAutoScaled(fitted.scale > next.scale + 1e-6);
      setOutOfBounds(!isValidTransform(fitted, src, out!));
      setTransform((prev) => {
        setHistory((h) => ({
          undo: [...h.undo.slice(-(UNDO_LIMIT - 1)), prev],
          redo: [],
        }));
        return fitted;
      });
    },
    [src, out],
  );

  const undo = useCallback(() => {
    setHistory((h) => {
      const prev = h.undo.at(-1);
      if (!prev) return h;
      setTransform((cur) => {
        setHistory({ undo: h.undo.slice(0, -1), redo: [...h.redo, cur] });
        return prev;
      });
      return h;
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      const next = h.redo.at(-1);
      if (!next) return h;
      setTransform((cur) => {
        setHistory({ undo: [...h.undo, cur], redo: h.redo.slice(0, -1) });
        return next;
      });
      return h;
    });
  }, []);

  const reset = useCallback(() => {
    setTransform((cur) => {
      if (cur === IDENTITY_TRANSFORM) return cur;
      setHistory((h) => ({ undo: [...h.undo, cur], redo: [] }));
      return IDENTITY_TRANSFORM;
    });
  }, []);

  const rotate90 = useCallback(
    (clockwise: boolean) => {
      if (!out) return;
      if (policy.rotateLocked) return;
      // After a 90° rotation the cover ratio may change; raise scale
      // automatically to keep coverage (EDT-003)
      const rotated = { width: src.height, height: src.width };
      const csOld = coverScale(src, out);
      const csNew = coverScale(rotated, out);
      apply({
        ...transform,
        rotationDeg: normalizeRotationDeg(transform.rotationDeg + (clockwise ? 90 : -90)),
        scale: transform.scale * Math.max(1, csNew / csOld),
      });
    },
    [apply, out, policy.rotateLocked, src, transform],
  );

  const toggleFlip = useCallback(() => {
    if (policy.mirrorLocked) return;
    apply({ ...transform, flipX: !transform.flipX });
  }, [apply, policy.mirrorLocked, transform]);

  // Preview drawing: preview and export share renderMatrix (§4.5.1)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !out) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const m = renderMatrix(transform, src, out);
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(source.bitmap, 0, 0, source.width, source.height);
    // Mask (EDT-008): crop-frame border + the template's allowed ranges
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, out.width - 2, out.height - 2);
    if (showOverlay && guides.length > 0) {
      drawTemplateOverlay(ctx, guides, out);
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      for (const t of [1 / 3, 2 / 3]) {
        ctx.beginPath();
        ctx.moveTo(out.width * t, 0);
        ctx.lineTo(out.width * t, out.height);
        ctx.moveTo(0, out.height * t);
        ctx.lineTo(out.width, out.height * t);
        ctx.stroke();
      }
    }
  }, [transform, source, src, out, guides, showOverlay]);

  if (!out) {
    return (
      <section aria-label="Edit">
        <h2>Edit photo</h2>
        <p className="muted">
          Template "{entryLabel(template, uiLocale())}" is cropped by the official portal; no local
          editing needed.
        </p>
        <div className="step-actions">
          <button
            type="button"
            className="primary"
            onClick={() => onDone(initialState ?? INITIAL_EDITOR_STATE)}
          >
            Continue
          </button>
          <button type="button" onClick={() => onBack(INITIAL_EDITOR_STATE)}>
            Back
          </button>
        </div>
      </section>
    );
  }

  const pointerDistance = (): number => {
    const [a, b] = [...pointersRef.current.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (policy.composeLocked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      pinchRef.current = {
        distance: pointerDistance(),
        scale: transformRef.current.scale,
      };
      dragRef.current = null;
    } else {
      dragRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (policy.composeLocked) return;
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two-finger pinch zoom
    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const distance = pointerDistance();
      if (distance > 0 && pinchRef.current.distance > 0) {
        const next = (pinchRef.current.scale * distance) / pinchRef.current.distance;
        apply({
          ...transformRef.current,
          scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)),
        });
      }
      return;
    }

    if (!dragRef.current) return;
    const cur = transformRef.current;
    // The normalization denominator must be the canvas **display** size.
    // Using output pixels as the denominator, on mobile where CSS squeezes
    // the canvas to 360px wide, the image follows the finger at 0.6×.
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - dragRef.current.x) / (rect.width || out.width);
    const dy = (e.clientY - dragRef.current.y) / (rect.height || out.height);
    dragRef.current = { x: e.clientX, y: e.clientY };
    apply({ ...cur, translateX: cur.translateX + dx, translateY: cur.translateY + dy });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) dragRef.current = null;
  };

  /** EDT-007 / WCAG 2.5.7: equivalent single-point operations beyond drag */
  const nudge = (dx: number, dy: number) => {
    if (policy.composeLocked) return;
    const cur = transformRef.current;
    apply({ ...cur, translateX: cur.translateX + dx, translateY: cur.translateY + dy });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Composition lock: arrow keys and +/- zoom are disabled (undo/redo
    // kept), and arrow keys are prevented from scrolling the page
    if (
      policy.composeLocked &&
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-"].includes(e.key)
    ) {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
      }
      return;
    }
    const cur = transformRef.current;
    const step = e.shiftKey ? 5 : 1;
    const move = (tx: number, ty: number) => {
      e.preventDefault();
      apply({ ...cur, translateX: cur.translateX + tx, translateY: cur.translateY + ty });
    };
    switch (e.key) {
      case "ArrowLeft":
        move(-0.01 * step, 0);
        break;
      case "ArrowRight":
        move(0.01 * step, 0);
        break;
      case "ArrowUp":
        move(0, -0.01 * step);
        break;
      case "ArrowDown":
        move(0, 0.01 * step);
        break;
      case "+":
      case "=":
        e.preventDefault();
        apply({ ...cur, scale: Math.min(MAX_SCALE, cur.scale + 0.1) });
        break;
      case "-":
        e.preventDefault();
        apply({ ...cur, scale: Math.max(MIN_SCALE, cur.scale - 0.1) });
        break;
      case "z":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        }
        break;
      case "y":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          redo();
        }
        break;
    }
  };

  return (
    <section aria-label="Edit">
      <h2>Edit photo</h2>
      <p className="muted">
        Selected template: {entryLabel(template, uiLocale())} ({out.width}×{out.height} pixels).
        Rotation corrects scan or camera canvas orientation and does not imply pose compliance
        (EDT-006).
      </p>
      <div className="editor-layout">
        <div className="editor-preview">
          <canvas
            ref={canvasRef}
            width={out.width}
            height={out.height}
            tabIndex={0}
            aria-label={
              policy.composeLocked
                ? "Photo preview (composition locked)"
                : "Photo preview; drag to adjust position"
            }
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleKeyDown}
          />
          <p className="muted">
            {policy.composeLocked
              ? "This template forbids adjusting the composition: zoom, pan, and arrow keys are disabled."
              : "Drag to adjust position, pinch to zoom; arrow keys nudge (Shift for larger steps), +/- zoom, Ctrl+Z undo."}
          </p>

          {guides.length > 0 && (
            <>
              <label className="inline-label">
                <input
                  type="checkbox"
                  checked={showOverlay}
                  onChange={(e) => setShowOverlay(e.target.checked)}
                />
                Show template reference ranges
              </label>
              <details className="sources">
                <summary>Template allowed ranges ({guides.length} items)</summary>
                <ul>
                  {guides.map((g) => (
                    <li key={g.ruleId}>
                      {g.label}
                      {g.enforcement !== "mandatory" && " (recommended)"}
                      {g.sourceLiteral && <span className="muted">: {g.sourceLiteral}</span>}
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  Reference ranges are converted from the template's official sources for alignment;
                  acceptance remains at the issuing authority's discretion.
                </p>
              </details>
            </>
          )}

          {/* EDT-007 / WCAG 2.5.7: equivalent single-point operations must
          exist beyond drag */}
          <div className="nudge-pad" role="group" aria-label="Pan photo">
            <button
              type="button"
              onClick={() => nudge(0, -NUDGE_STEP)}
              aria-label="Move up"
              disabled={policy.composeLocked}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => nudge(-NUDGE_STEP, 0)}
              aria-label="Move left"
              disabled={policy.composeLocked}
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => {
                if (policy.composeLocked) return;
                apply({ ...transform, translateX: 0, translateY: 0 });
              }}
              aria-label="Center"
              disabled={policy.composeLocked}
            >
              ⌾
            </button>
            <button
              type="button"
              onClick={() => nudge(NUDGE_STEP, 0)}
              aria-label="Move right"
              disabled={policy.composeLocked}
            >
              →
            </button>
            <button
              type="button"
              onClick={() => nudge(0, NUDGE_STEP)}
              aria-label="Move down"
              disabled={policy.composeLocked}
            >
              ↓
            </button>
          </div>
          <div className="filter-row">
            <label>
              Horizontal position (−0.5 to 0.5)
              <input
                type="number"
                min={-0.5}
                max={0.5}
                step={0.01}
                value={Math.round(transform.translateX * 100) / 100}
                onChange={(e) => {
                  if (policy.composeLocked) return;
                  apply({ ...transform, translateX: Number(e.target.value) });
                }}
                aria-label="Horizontal position value"
                disabled={policy.composeLocked}
              />
            </label>
            <label>
              Vertical position (−0.5 to 0.5)
              <input
                type="number"
                min={-0.5}
                max={0.5}
                step={0.01}
                value={Math.round(transform.translateY * 100) / 100}
                onChange={(e) => {
                  if (policy.composeLocked) return;
                  apply({ ...transform, translateY: Number(e.target.value) });
                }}
                aria-label="Vertical position value"
                disabled={policy.composeLocked}
              />
            </label>
          </div>
        </div>
        <div className="editor-controls">
          <div className="filter-group">
            <label>
              Zoom (1 = exactly covering)
              <input
                type="range"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={0.05}
                value={transform.scale}
                onChange={(e) => {
                  if (policy.composeLocked) return;
                  apply({ ...transform, scale: Number(e.target.value) });
                }}
                disabled={policy.composeLocked}
              />
              <input
                type="number"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={0.05}
                value={Math.round(transform.scale * 100) / 100}
                onChange={(e) => {
                  if (policy.composeLocked) return;
                  apply({ ...transform, scale: Number(e.target.value) });
                }}
                aria-label="Zoom value"
                disabled={policy.composeLocked}
              />
            </label>
            <label>
              Rotation (degrees)
              <input
                type="range"
                min={-90}
                max={90}
                step={0.5}
                value={Math.max(-90, Math.min(90, transform.rotationDeg))}
                onChange={(e) => {
                  if (policy.rotateLocked) return;
                  apply({
                    ...transform,
                    rotationDeg: normalizeRotationDeg(Number(e.target.value)),
                  });
                }}
                disabled={policy.rotateLocked}
              />
              <input
                type="number"
                min={-180}
                max={180}
                step={0.5}
                value={Math.round(transform.rotationDeg * 10) / 10}
                onChange={(e) => {
                  if (policy.rotateLocked) return;
                  apply({ ...transform, rotationDeg: Number(e.target.value) });
                }}
                aria-label="Rotation value"
                disabled={policy.rotateLocked}
              />
            </label>
            {policy.composeLockReason && <p className="warn-text">{policy.composeLockReason}</p>}
          </div>
          <div className="step-actions">
            <button
              type="button"
              onClick={() => rotate90(true)}
              disabled={policy.rotateLocked}
              title={
                policy.rotateLocked ? "This template forbids rotation" : "Rotate 90° clockwise"
              }
            >
              Rotate 90°
            </button>
            <button
              type="button"
              onClick={toggleFlip}
              disabled={policy.mirrorLocked}
              title={
                policy.mirrorLocked ? "This template forbids mirroring" : "Mirror horizontally"
              }
            >
              Mirror horizontally
            </button>
            <button type="button" onClick={undo} disabled={history.undo.length === 0}>
              Undo
            </button>
            <button type="button" onClick={redo} disabled={history.redo.length === 0}>
              Redo
            </button>
            <button type="button" onClick={reset} disabled={transform === IDENTITY_TRANSFORM}>
              Reset
            </button>
          </div>
          {effectiveUpscale > 1.001 && (
            <p className="warn-text" role="alert">
              Source resolution insufficient: the current composition needs to upscale the source{" "}
              {effectiveUpscale.toFixed(2)}× to fill {out.width}×{out.height} and the artifact
              sharpness will visibly drop.
              {coverUpscale > 1.001
                ? "This photo is already smaller than the template output; consider a higher-resolution photo."
                : "Reducing the zoom removes this warning."}
            </p>
          )}
          {outOfBounds && (
            <p className="warn-text" role="alert">
              The current rotation angle needs a larger zoom, but the source resolution does not
              allow it. Reduce the rotation angle or use a higher-resolution photo.
            </p>
          )}
          {autoScaled && !outOfBounds && (
            <p className="muted" role="status">
              Auto-zoomed to fill the crop frame - without it, the current rotation angle would
              leave blank corners on the artifact.
            </p>
          )}
          <PolicyNotices policy={policy} />
          <div className="step-actions">
            <button
              type="button"
              className="primary"
              onClick={() => onDone({ transform, history })}
              disabled={outOfBounds}
              title={
                outOfBounds
                  ? "crop frame outside the source; the artifact would have blank corners"
                  : undefined
              }
            >
              Next (final checks)
            </button>
            <button type="button" onClick={() => onBack({ transform, history })}>
              Back to choose another photo
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
