import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceImage } from "../image/source";
import type { TemplateEntry } from "../lib/templates/types";
import type { EditorState } from "../editor/edit-transform";
import { CreatePage } from "./create-page";

const template = {
  revision: {
    revisionId: "us@1",
    id: "us",
    version: 1,
    schemaVersion: 1,
    label: { zh: "美国签证" },
    jurisdiction: "US",
    documentType: "visa",
    submissionChannel: "digital_upload",
    applicantClass: "adult",
    sources: [],
    output: {
      kind: "exact_pixels",
      widthPx: 600,
      heightPx: 600,
      aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
    },
    cropRules: [],
    captureRules: [],
    overlay: { kind: "none", ruleIds: [] },
    capabilities: {
      selfCapture: "allowed",
      crop: "allowed",
      rotate: "allowed",
      mirror: "forbidden",
      retouch: "forbidden",
      backgroundReplace: "forbidden",
      requiresOriginalCameraFile: false,
      requiresProfessionalPhotographer: false,
    },
    sourceNotes: {},
  },
  contentHash: "abc",
  publication: {
    revisionId: "us@1",
    status: "active",
    statusReason: "ok",
    owner: "o",
    reviewer: "r",
    verifiedAt: "2026-08-06",
    reviewDueAt: "2026-11-04",
    effectiveAt: "2026-08-06",
    publicationRevision: 1,
  },
} as unknown as TemplateEntry;

const dispose = vi.fn();

function fakeSource(): SourceImage {
  return {
    file: new Blob([new Uint8Array(4)], { type: "image/jpeg" }),
    format: "jpeg",
    orientation: 1,
    rawWidth: 1200,
    rawHeight: 1200,
    width: 1200,
    height: 1200,
    bitmap: { width: 1200, height: 1200, close: vi.fn() } as unknown as ImageBitmap,
    previewUrl: "blob:fake",
    dispose,
  } as unknown as SourceImage;
}

vi.mock("./template-step", () => ({
  TemplateStep: ({ onSelect }: { onSelect: (t: TemplateEntry) => void }) => (
    <button type="button" onClick={() => onSelect(template)}>
      选择这个模板
    </button>
  ),
}));

vi.mock("./source-step", () => ({
  SourceStep: ({ onReady, onBack }: { onReady: (s: SourceImage) => void; onBack: () => void }) => (
    <>
      <button type="button" onClick={() => onReady(fakeSource())}>
        完成上传
      </button>
      <button type="button" onClick={onBack}>
        上传步骤返回
      </button>
    </>
  ),
}));

vi.mock("./capture-step", () => ({
  CaptureStep: ({ onReady }: { onReady: (s: SourceImage) => void }) => (
    <button type="button" onClick={() => onReady(fakeSource())}>
      完成拍摄
    </button>
  ),
}));

vi.mock("../editor/editor-step", async () => {
  const { INITIAL_EDITOR_STATE } = await import("../editor/edit-transform");
  return {
    EditorStep: ({
      initialState,
      onDone,
      onBack,
    }: {
      initialState?: EditorState | null;
      onDone: (s: EditorState) => void;
      onBack: () => void;
    }) => (
      <>
        <p>编辑器：缩放 {initialState?.transform.scale ?? "初始"}</p>
        <p>撤销栈 {initialState?.history.undo.length ?? 0}</p>
        <button
          type="button"
          onClick={() =>
            onDone({
              transform: { ...INITIAL_EDITOR_STATE.transform, scale: 1.75 },
              history: { undo: [INITIAL_EDITOR_STATE.transform], redo: [] },
            })
          }
        >
          完成编辑
        </button>
        <button type="button" onClick={onBack}>
          编辑器返回
        </button>
      </>
    ),
  };
});

vi.mock("../render/final-page", () => ({
  FinalPage: ({ onBack, onRestart }: { onBack: () => void; onRestart: () => void }) => (
    <>
      <p>终态页</p>
      <button type="button" onClick={onBack}>
        返回编辑
      </button>
      <button type="button" onClick={onRestart}>
        重新开始
      </button>
    </>
  ),
}));

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** 走到编辑器之前的公共路径 */
function walkToEditor() {
  render(<CreatePage />);
  click("选择这个模板");
  click("上传照片");
  click("完成上传");
  click("使用这张照片");
}

beforeEach(() => {
  dispose.mockClear();
});

describe("CreatePage 状态机", () => {
  it("shows a progress bar with the current step", () => {
    render(<CreatePage />);
    const bar = screen.getByRole("list", { name: "创建进度" });
    expect(bar).toBeInTheDocument();
    expect(screen.getByText("1. 选择模板").getAttribute("aria-current")).toBe("step");
  });

  it("inserts a review step between capture and the editor (SPEC 流程)", () => {
    // 回归：拍摄或上传后曾直接跳进编辑器，用户没有确认或重拍的机会
    render(<CreatePage />);
    click("选择这个模板");
    click("使用摄像头拍摄");
    click("完成拍摄");
    expect(screen.getByRole("heading", { name: "确认这张照片" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新拍摄" })).toBeInTheDocument();
  });

  it("labels the retake action by where the photo came from", () => {
    walkToEditor();
    click("编辑器返回");
    expect(screen.getByRole("button", { name: "重新选择文件" })).toBeInTheDocument();
  });

  it("keeps transform and undo history when returning from the final page", () => {
    // 回归：从终态返回编辑会丢掉全部裁剪参数与撤销栈，等于从头再来一遍
    walkToEditor();
    expect(screen.getByText("编辑器：缩放 初始")).toBeInTheDocument();

    click("完成编辑");
    expect(screen.getByText("终态页")).toBeInTheDocument();

    click("返回编辑");
    expect(screen.getByText("编辑器：缩放 1.75")).toBeInTheDocument();
    expect(screen.getByText("撤销栈 1")).toBeInTheDocument();
  });

  it("keeps the photo when stepping back from the editor to review", () => {
    walkToEditor();
    click("编辑器返回");
    expect(screen.getByRole("heading", { name: "确认这张照片" })).toBeInTheDocument();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("drops the editor state when the photo itself is replaced", () => {
    walkToEditor();
    click("完成编辑");
    click("返回编辑");
    expect(screen.getByText("编辑器：缩放 1.75")).toBeInTheDocument();

    click("编辑器返回");
    click("重新选择文件");
    expect(dispose).toHaveBeenCalled();
    click("完成上传");
    click("使用这张照片");
    expect(screen.getByText("编辑器：缩放 初始")).toBeInTheDocument();
  });

  it("returns to the template step on restart", () => {
    walkToEditor();
    click("完成编辑");
    click("重新开始");
    expect(screen.getByRole("button", { name: "选择这个模板" })).toBeInTheDocument();
    expect(screen.getByText("1. 选择模板").getAttribute("aria-current")).toBe("step");
  });

  it("advances the progress bar as the flow moves forward", () => {
    walkToEditor();
    expect(screen.getByText("4. 编辑").getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("1. 选择模板").className).toContain("done");
  });
});
