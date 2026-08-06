import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SourceImage } from "../image/source";
import { entryLabel } from "../lib/templates/catalog";
import type { TemplateEntry } from "../lib/templates/types";
import {
  clampTranslation,
  coverScale,
  IDENTITY_TRANSFORM,
  MAX_SCALE,
  MIN_SCALE,
  normalizeRotationDeg,
  outputSize,
  renderMatrix,
  type EditTransform,
} from "./edit-transform";

export interface EditorStepProps {
  source: SourceImage;
  template: TemplateEntry;
  onDone: (transform: EditTransform) => void;
  onBack: () => void;
}

const UNDO_LIMIT = 50;

interface History {
  undo: EditTransform[];
  redo: EditTransform[];
}

export function EditorStep({ source, template, onDone, onBack }: EditorStepProps) {
  const out = outputSize(template.revision);
  const [transform, setTransform] = useState<EditTransform>(IDENTITY_TRANSFORM);
  const [history, setHistory] = useState<History>({ undo: [], redo: [] });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const transformRef = useRef(transform);
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  const src = useMemo(
    () => ({ width: source.width, height: source.height }),
    [source.width, source.height],
  );
  const caps = template.revision.capabilities;

  const apply = useCallback(
    (next: EditTransform) => {
      const clamped = clampTranslation(next, src, out!);
      setTransform((prev) => {
        setHistory((h) => ({
          undo: [...h.undo.slice(-(UNDO_LIMIT - 1)), prev],
          redo: [],
        }));
        return clamped;
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
    // 蒙版（EDT-008）：裁剪框边框 + 三分线
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, out.width - 2, out.height - 2);
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
  }, [transform, source, src, out]);

  if (!out) {
    return (
      <section aria-label="编辑">
        <h2>编辑照片</h2>
        <p className="muted">
          模板「{entryLabel(template, "zh")}」由官方门户处理裁剪，无需本地编辑。
        </p>
        <div className="step-actions">
          <button type="button" className="primary" onClick={() => onDone(IDENTITY_TRANSFORM)}>
            继续
          </button>
          <button type="button" onClick={onBack}>
            返回
          </button>
        </div>
      </section>
    );
  }

  const handleDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const cur = transformRef.current;
    const dx = (e.clientX - dragRef.current.x) / out.width;
    const dy = (e.clientY - dragRef.current.y) / out.height;
    dragRef.current = { x: e.clientX, y: e.clientY };
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
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              dragRef.current = { x: e.clientX, y: e.clientY };
            }}
            onPointerMove={handleDrag}
            onPointerUp={() => {
              dragRef.current = null;
            }}
            onKeyDown={handleKeyDown}
          />
          <p className="muted">拖移调整位置；方向键微调（Shift 大步）、+/- 缩放、Ctrl+Z 撤销。</p>
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
          {caps.mirror === "warn" && (
            <p className="warn-text">模板对镜像操作有警告：请核对官方规则。</p>
          )}
          {caps.rotate === "warn" && (
            <p className="warn-text">模板对旋转操作有警告：请核对官方规则。</p>
          )}
          <div className="step-actions">
            <button type="button" className="primary" onClick={() => onDone(transform)}>
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
