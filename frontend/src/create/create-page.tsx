/**
 * 创建流程的状态机。
 *
 * 两条不变式：
 * 1. 「返回」只改变当前步骤，不销毁下游状态——从终态返回编辑、从编辑返回确认、
 *    会话内更换模板都必须能看到原来的裁剪参数与撤销栈，否则每次核对都等于
 *    从头再来一遍；换模板时变换按新模板的输出尺寸重新投影；
 * 2. 只有源照片真正被替换时，编辑状态才作废；换到禁止调整构图的模板时
 *    编辑状态同样作废（构图锁定不能被继承的构图绕过）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";

import type { SaveResponse } from "../api/save";
import type { TemplateEntry } from "../lib/templates/types";
import type { SourceImage } from "../image/source";
import { EditorStep } from "../editor/editor-step";
import {
  reprojectEditorState,
  resolveOutputSize,
  type EditTransform,
  type EditorState,
  type OutputSizeOption,
  type ReprojectNote,
} from "../editor/edit-transform";
import { FinalPage } from "../render/final-page";
import { downloadReceipt } from "../render/staging-panel";
import { editorPolicy } from "../lib/templates/policy";
import { CaptureStep } from "./capture-step";
import { ReviewStep } from "./review-step";
import { SourceStep } from "./source-step";
import { TemplateStep } from "./template-step";

type Step = "template" | "source" | "capture" | "upload" | "review" | "edit" | "final";

interface StepGroup {
  key: string;
  label: string;
  steps: Step[];
}

const STEP_GROUPS: StepGroup[] = [
  { key: "template", label: "选择模板", steps: ["template"] },
  { key: "source", label: "获取照片", steps: ["source", "capture", "upload"] },
  { key: "review", label: "确认照片", steps: ["review"] },
  { key: "edit", label: "编辑", steps: ["edit"] },
  { key: "final", label: "终态检查", steps: ["final"] },
];

function groupIndexOf(step: Step): number {
  return STEP_GROUPS.findIndex((g) => g.steps.includes(step));
}

const TEMPLATE_NOTE_TEXT: Record<ReprojectNote, string> = {
  refit: "模板输出尺寸变化，裁剪参数已重新适配",
  "mirror-cleared": "新模板禁止镜像，已取消水平镜像",
  "rotation-cleared": "新模板禁止旋转，已取消旋转",
  reset: "无法在新尺寸下保留原裁剪，已重置",
};

export function CreatePage() {
  const [step, setStep] = useState<Step>("template");
  const [selected, setSelected] = useState<TemplateEntry | null>(null);
  const [sourceMode, setSourceMode] = useState<"upload" | "camera" | null>(null);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  // ranged_pixels 模板的用户选定输出尺寸（P6）；null = 模板默认档
  const [selectedSize, setSelectedSize] = useState<OutputSizeOption | null>(null);
  // 已暂存回执（仅会话内存，不落盘）：从终态返回编辑再回来时原样恢复，
  // 服务端不会因为这一趟多出第二张照片（§9.2 编辑状态只在会话内存）
  const [staged, setStaged] = useState<{
    saved: SaveResponse;
    idempotencyKey: string;
    source: SourceImage;
    transform: EditTransform;
  } | null>(null);
  // 换模板投影后的可见说明（role=status，渲染在确认页）
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  // 当前模板的来源前置约束（渲染在模板卡与「选择照片来源」步骤）
  const sourcePolicy = selected ? editorPolicy(selected.revision) : null;

  // 有未保存内容才算脏：只选了模板（还没取照片）时离开不丢任何东西
  const dirty = !!source || !!editorState || staged !== null;
  // 站内导航与返回手势的统一拦截：同路径点击（已在 /create 再点「创建照片」）不拦
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        dirty && currentLocation.pathname !== nextLocation.pathname,
      [dirty],
    ),
  );
  const sourceRef = useRef<SourceImage | null>(null);
  const stepHeadingRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  useEffect(
    () => () => {
      sourceRef.current?.dispose();
      sourceRef.current = null;
    },
    [],
  );

  // 步骤切换时把焦点移到新步骤，键盘与读屏用户才不会停在上一屏的位置
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepHeadingRef.current?.focus();
  }, [step]);

  // 刷新或误关标签页会丢掉全部内存态：照片、裁剪参数、撤销栈都不落盘（§9.2）。
  // 与 dirty 同判：只选了模板时不该弹刷新确认（站内跳转由上面的 blocker 拦截）
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const replaceSource = useCallback((next: SourceImage | null) => {
    sourceRef.current?.dispose();
    sourceRef.current = next;
    setSource(next);
    // 源照片换了，此前的裁剪参数就不再对应任何东西
    setEditorState(null);
  }, []);

  const restart = useCallback(() => {
    if (
      staged !== null &&
      !window.confirm(
        "这张照片已暂存，重新开始会丢失取回码与删除密钥。请先「下载回执」；确定继续吗？",
      )
    ) {
      return;
    }
    replaceSource(null);
    setSourceMode(null);
    setSelected(null);
    setSelectedSize(null);
    setStaged(null);
    setStep("template");
  }, [replaceSource, staged]);

  const selectedOut = selected ? resolveOutputSize(selected.revision, selectedSize) : null;

  const currentGroup = groupIndexOf(step);

  return (
    <>
      <h1>创建照片</h1>
      <ol className="step-bar" aria-label="创建进度">
        {STEP_GROUPS.map((group, index) => (
          <li
            key={group.key}
            className={index < currentGroup ? "done" : undefined}
            aria-current={index === currentGroup ? "step" : undefined}
          >
            {index + 1}. {group.label}
          </li>
        ))}
      </ol>

      {/* tabIndex=-1 容器只用于步骤切换后的焦点落点，不进 Tab 序列 */}
      <div ref={stepHeadingRef} tabIndex={-1}>
        {step === "template" && (
          <>
            <TemplateStep
              onSelect={(entry) => {
                setSelected(entry);
                // 换模板后尺寸档回到该模板默认（不改 editorState，见 P6 坑 10）
                setSelectedSize(null);
                if (source === null) {
                  // 首次选模板：还没有照片，照旧进来源选择
                  setStep("source");
                  return;
                }
                const templateChanged =
                  selected !== null && selected.revision.revisionId !== entry.revision.revisionId;
                if (editorState !== null) {
                  if (templateChanged && entry.revision.capabilities.crop === "forbidden") {
                    // 新模板禁止调整构图：继承的 scale/translate 必须作废（P2 收口）
                    setEditorState(null);
                    setTemplateNotice("新模板禁止调整构图，裁剪已重置为默认构图。");
                  } else {
                    // 会话内换模板：保留照片与编辑状态，按新模板重新投影
                    const { state, notes } = reprojectEditorState(
                      editorState,
                      { width: source.width, height: source.height },
                      entry.revision,
                    );
                    setEditorState(state);
                    setTemplateNotice(notes.map((n) => TEMPLATE_NOTE_TEXT[n]).join("；"));
                  }
                } else {
                  setTemplateNotice(null);
                }
                setStep("review");
              }}
            />
            {source !== null && (
              <div className="step-actions">
                <button type="button" onClick={() => setStep("review")}>
                  返回（保留当前模板）
                </button>
              </div>
            )}
          </>
        )}

        {step === "source" && selected && (
          <section aria-label="选择照片来源">
            <h2>选择照片来源</h2>
            <p className="muted">上传已有照片，或使用摄像头拍摄新照片。</p>
            {sourcePolicy && sourcePolicy.sourceRequirements.length > 0 && (
              <ul className="muted">
                {sourcePolicy.sourceRequirements.map((r) => (
                  <li key={r.id}>{r.text}</li>
                ))}
              </ul>
            )}
            <div className="step-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setSourceMode("upload");
                  setStep("upload");
                }}
              >
                上传照片
              </button>
              <button
                type="button"
                onClick={() => {
                  setSourceMode("camera");
                  setStep("capture");
                }}
              >
                使用摄像头拍摄
              </button>
            </div>
            <div className="step-actions">
              <button type="button" onClick={() => setStep("template")}>
                返回重新选择模板
              </button>
            </div>
          </section>
        )}

        {step === "upload" && selected && (
          <SourceStep
            template={selected}
            onReady={(next) => {
              replaceSource(next);
              setStep("review");
            }}
            onBack={() => setStep("source")}
          />
        )}

        {step === "capture" && selected && (
          <CaptureStep
            template={selected}
            onReady={(next) => {
              replaceSource(next);
              setStep("review");
            }}
            onBack={() => setStep("source")}
          />
        )}

        {step === "review" && selected && source && (
          <ReviewStep
            source={source}
            template={selected}
            origin={sourceMode === "camera" ? "camera" : "upload"}
            selectedSize={selectedSize}
            onSizeChange={setSelectedSize}
            onConfirm={() => setStep("edit")}
            onRetake={() => {
              replaceSource(null);
              setStep(sourceMode === "camera" ? "capture" : "upload");
            }}
            onBack={() => {
              replaceSource(null);
              setStep("source");
            }}
            onChangeTemplate={() => setStep("template")}
            notice={templateNotice}
          />
        )}

        {step === "edit" && selected && source && (
          <EditorStep
            source={source}
            template={selected}
            size={selectedOut}
            initialState={editorState}
            onDone={(state) => {
              setEditorState(state);
              setStep("final");
            }}
            // 返回确认步骤：编辑状态由本回调显式写回，返回再进来时原样保留
            onBack={(state) => {
              setEditorState(state);
              setStep("review");
            }}
          />
        )}

        {step === "final" && selected && source && editorState && (
          <FinalPage
            source={source}
            template={selected}
            transform={editorState.transform}
            selectedSize={selectedSize}
            onUseDefaultSize={() => setSelectedSize(null)}
            onBack={() => setStep("edit")}
            onRestart={restart}
            staged={staged}
            stagedStale={
              staged !== null &&
              (staged.source !== source ||
                staged.transform.translateX !== editorState.transform.translateX ||
                staged.transform.translateY !== editorState.transform.translateY ||
                staged.transform.scale !== editorState.transform.scale ||
                staged.transform.rotationDeg !== editorState.transform.rotationDeg ||
                staged.transform.flipX !== editorState.transform.flipX)
            }
            onStaged={(receipt) =>
              receipt === null
                ? setStaged(null)
                : setStaged({ ...receipt, source, transform: editorState.transform })
            }
          />
        )}
      </div>

      {blocker.state === "blocked" && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="leave-title"
          className="confirm-box"
        >
          <h3 id="leave-title">离开创建流程？</h3>
          {staged ? (
            <>
              <p>
                这张照片已暂存成功。取回码与删除密钥只显示一次，离开后无法找回；
                尚未暂存的照片与编辑内容也会丢失。
              </p>
              <div className="step-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => downloadReceipt(staged.saved)}
                >
                  下载回执（含取回码与删除密钥）
                </button>
              </div>
            </>
          ) : (
            <p>当前有未保存的照片与编辑内容（裁剪参数、撤销栈），离开后都会丢失。</p>
          )}
          <div className="step-actions">
            <button type="button" className="primary" onClick={() => blocker.proceed()}>
              继续离开
            </button>
            <button type="button" onClick={() => blocker.reset()}>
              留在本页
            </button>
          </div>
        </div>
      )}
    </>
  );
}
