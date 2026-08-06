import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SourceImage } from "../image/source";
import { buildOverlayGuides, headEllipse, type OverlayGuide } from "./overlay";
import { entryLabel } from "../lib/templates/catalog";
import type { TemplateEntry } from "../lib/templates/types";
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
} from "./edit-transform";

export interface EditorStepProps {
  source: SourceImage;
  template: TemplateEntry;
  /** 上次离开编辑器时的状态；不传则从初始变换开始 */
  initialState?: EditorState | null;
  onDone: (state: EditorState) => void;
  onBack: () => void;
}

const UNDO_LIMIT = 50;

/** 单次平移按钮的步长（归一化到输出尺寸） */
const NUDGE_STEP = 0.02;

const BAND_FILL = "rgba(56, 189, 248, 0.18)";
const BAND_EDGE = "rgba(56, 189, 248, 0.9)";
const ELLIPSE_STROKE = "rgba(255, 255, 255, 0.75)";

/**
 * 把模板的允许区间画到画布上（EDT-008）。
 *
 * 在这之前编辑器只画了一组通用三分线——与任何模板规则都无关，
 * cropRules / overlay 里那些经过来源核对的数字在界面上完全不可见。
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
      // 允许尺寸画成右侧标尺：它是长度约束，不是位置约束
      const x = out.width - 10;
      ctx.beginPath();
      ctx.moveTo(x, 8);
      ctx.lineTo(x, 8 + (guide.toPx - guide.fromPx));
      ctx.stroke();
    } else {
      const y = out.height - 10;
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.lineTo(8 + (guide.toPx - guide.fromPx), y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

type History = EditorHistory;

export function EditorStep({ source, template, initialState, onDone, onBack }: EditorStepProps) {
  const out = outputSize(template.revision);
  const [transform, setTransform] = useState<EditTransform>(
    initialState?.transform ?? IDENTITY_TRANSFORM,
  );
  const [history, setHistory] = useState<History>(initialState?.history ?? { undo: [], redo: [] });
  const [autoScaled, setAutoScaled] = useState(false);
  const [outOfBounds, setOutOfBounds] = useState(false);
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
  const caps = template.revision.capabilities;

  // EDT-004：cover 本身就大于 1 时，源图分辨率已低于模板输出要求。
  // 这里不锁死缩放——分辨率不足时用户仍然需要能调整构图——而是给出不可忽略的警告。
  const coverUpscale = useMemo(() => (out ? coverScale(src, out) : 1), [src, out]);
  const guides = useMemo(
    () => (out ? buildOverlayGuides(template.revision, out) : []),
    [template, out],
  );
  const effectiveUpscale = coverUpscale * transform.scale;

  const apply = useCallback(
    (next: EditTransform) => {
      // 只夹平移不够：旋转绕画布中心，任意角度都会把裁剪框的角甩出源图，
      // 成品四角留下透明像素并在 JPEG 编码后变成黑角。fitTransform 会先补足所需 scale。
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
      // 旋转 90° 后 cover 比例可能变化，自动抬升 scale 保证覆盖（EDT-003）
      const rotated = { width: src.height, height: src.width };
      const csOld = coverScale(src, out);
      const csNew = coverScale(rotated, out);
      apply({
        ...transform,
        rotationDeg: normalizeRotationDeg(transform.rotationDeg + (clockwise ? 90 : -90)),
        scale: transform.scale * Math.max(1, csNew / csOld),
      });
    },
    [apply, out, src, transform],
  );

  const toggleFlip = useCallback(() => {
    if (caps.mirror === "forbidden") return;
    apply({ ...transform, flipX: !transform.flipX });
  }, [apply, caps.mirror, transform]);

  // 预览绘制：预览与导出共用 renderMatrix（§4.5.1）
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
    // 蒙版（EDT-008）：裁剪框边框 + 模板的允许区间
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
      <section aria-label="编辑">
        <h2>编辑照片</h2>
        <p className="muted">
          模板「{entryLabel(template, "zh")}」由官方门户处理裁剪，无需本地编辑。
        </p>
        <div className="step-actions">
          <button type="button" className="primary" onClick={() => onDone(INITIAL_EDITOR_STATE)}>
            继续
          </button>
          <button type="button" onClick={onBack}>
            返回
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
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // 双指捏合缩放
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
    // 归一化的分母必须是画布的**显示**尺寸。用输出像素做分母时，
    // 画布被 CSS 压到 360px 宽的移动端上，图像只跟着手指走 0.6 倍。
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

  /** EDT-007 / WCAG 2.5.7：拖动之外的等效操作 */
  const nudge = (dx: number, dy: number) => {
    const cur = transformRef.current;
    apply({ ...cur, translateX: cur.translateX + dx, translateY: cur.translateY + dy });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
    <section aria-label="编辑">
      <h2>编辑照片</h2>
      <p className="muted">
        已选模板：{entryLabel(template, "zh")}（{out.width}×{out.height} 像素）。
        旋转用于纠正扫描或相机画布方向，不代表姿态合规（EDT-006）。
      </p>
      <div className="editor-layout">
        <div className="editor-preview">
          <canvas
            ref={canvasRef}
            width={out.width}
            height={out.height}
            tabIndex={0}
            aria-label="照片预览，可拖移调整位置"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleKeyDown}
          />
          <p className="muted">
            拖移调整位置，双指捏合缩放；方向键微调（Shift 大步）、+/- 缩放、Ctrl+Z 撤销。
          </p>

          {guides.length > 0 && (
            <>
              <label className="inline-label">
                <input
                  type="checkbox"
                  checked={showOverlay}
                  onChange={(e) => setShowOverlay(e.target.checked)}
                />
                显示模板参考区间
              </label>
              <details className="sources">
                <summary>模板允许区间（{guides.length} 项）</summary>
                <ul>
                  {guides.map((g) => (
                    <li key={g.ruleId}>
                      {g.label}
                      {g.enforcement !== "mandatory" && "（建议）"}
                      {g.sourceLiteral && <span className="muted">：{g.sourceLiteral}</span>}
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  参考区间由模板的官方来源换算而来，用于对位；是否受理仍以签发机关为准。
                </p>
              </details>
            </>
          )}

          {/* EDT-007 / WCAG 2.5.7：拖动之外必须有等效的单点操作 */}
          <div className="nudge-pad" role="group" aria-label="平移照片">
            <button type="button" onClick={() => nudge(0, -NUDGE_STEP)} aria-label="上移">
              ↑
            </button>
            <button type="button" onClick={() => nudge(-NUDGE_STEP, 0)} aria-label="左移">
              ←
            </button>
            <button
              type="button"
              onClick={() => apply({ ...transform, translateX: 0, translateY: 0 })}
              aria-label="居中"
            >
              ⌾
            </button>
            <button type="button" onClick={() => nudge(NUDGE_STEP, 0)} aria-label="右移">
              →
            </button>
            <button type="button" onClick={() => nudge(0, NUDGE_STEP)} aria-label="下移">
              ↓
            </button>
          </div>
          <div className="filter-row">
            <label>
              水平位置（−0.5～0.5）
              <input
                type="number"
                min={-0.5}
                max={0.5}
                step={0.01}
                value={Math.round(transform.translateX * 100) / 100}
                onChange={(e) => apply({ ...transform, translateX: Number(e.target.value) })}
                aria-label="水平位置数值"
              />
            </label>
            <label>
              垂直位置（−0.5～0.5）
              <input
                type="number"
                min={-0.5}
                max={0.5}
                step={0.01}
                value={Math.round(transform.translateY * 100) / 100}
                onChange={(e) => apply({ ...transform, translateY: Number(e.target.value) })}
                aria-label="垂直位置数值"
              />
            </label>
          </div>
        </div>
        <div className="editor-controls">
          <div className="filter-group">
            <label>
              缩放（1 = 恰好覆盖）
              <input
                type="range"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={0.05}
                value={transform.scale}
                onChange={(e) => apply({ ...transform, scale: Number(e.target.value) })}
              />
              <input
                type="number"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={0.05}
                value={Math.round(transform.scale * 100) / 100}
                onChange={(e) => apply({ ...transform, scale: Number(e.target.value) })}
                aria-label="缩放数值"
              />
            </label>
            <label>
              旋转（度）
              <input
                type="range"
                min={-90}
                max={90}
                step={0.5}
                value={Math.max(-90, Math.min(90, transform.rotationDeg))}
                onChange={(e) =>
                  apply({
                    ...transform,
                    rotationDeg: normalizeRotationDeg(Number(e.target.value)),
                  })
                }
              />
              <input
                type="number"
                min={-180}
                max={180}
                step={0.5}
                value={Math.round(transform.rotationDeg * 10) / 10}
                onChange={(e) => apply({ ...transform, rotationDeg: Number(e.target.value) })}
                aria-label="旋转数值"
              />
            </label>
          </div>
          <div className="step-actions">
            <button
              type="button"
              onClick={() => rotate90(true)}
              disabled={caps.rotate === "forbidden"}
              title={caps.rotate === "forbidden" ? "模板禁止旋转" : "顺时针旋转 90°"}
            >
              旋转 90°
            </button>
            <button
              type="button"
              onClick={toggleFlip}
              disabled={caps.mirror === "forbidden"}
              title={caps.mirror === "forbidden" ? "模板禁止镜像" : "水平镜像"}
            >
              水平镜像
            </button>
            <button type="button" onClick={undo} disabled={history.undo.length === 0}>
              撤销
            </button>
            <button type="button" onClick={redo} disabled={history.redo.length === 0}>
              重做
            </button>
            <button type="button" onClick={reset} disabled={transform === IDENTITY_TRANSFORM}>
              重置
            </button>
          </div>
          {effectiveUpscale > 1.001 && (
            <p className="warn-text" role="alert">
              源图分辨率不足：当前构图需要把源图放大 {effectiveUpscale.toFixed(2)} 倍才能填满{" "}
              {out.width}×{out.height}，成品清晰度会明显下降。
              {coverUpscale > 1.001
                ? "这张照片本身就小于模板输出，建议改用分辨率更高的照片。"
                : "缩小放大倍率即可消除本条警告。"}
            </p>
          )}
          {outOfBounds && (
            <p className="warn-text" role="alert">
              当前旋转角度需要更大的放大倍率，但源图分辨率不允许。
              请减小旋转角度，或改用分辨率更高的照片。
            </p>
          )}
          {autoScaled && !outOfBounds && (
            <p className="muted" role="status">
              已自动放大以填满裁剪框——当前旋转角度下不放大会在成品边角留下空白。
            </p>
          )}
          {caps.mirror === "warn" && (
            <p className="warn-text">模板对镜像操作有警告：请核对官方规则。</p>
          )}
          {caps.rotate === "warn" && (
            <p className="warn-text">模板对旋转操作有警告：请核对官方规则。</p>
          )}
          <div className="step-actions">
            <button
              type="button"
              className="primary"
              onClick={() => onDone({ transform, history })}
              disabled={outOfBounds}
              title={outOfBounds ? "裁剪框超出源图，成品会有空白边角" : undefined}
            >
              下一步（终态检查）
            </button>
            <button type="button" onClick={onBack}>
              返回重新选择照片
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
