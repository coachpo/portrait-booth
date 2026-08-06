import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceImage } from "../image/source";
import type { TemplateEntry } from "../lib/templates/types";
import type { EditorState } from "../editor/edit-transform";
import { routes } from "../app/App";

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

vi.mock("../render/final-page", () => {
  const saved = {
    key: "ABC123",
    keyDisplay: "ABC-123",
    deleteSecret: "secret-value-1234567890",
    expiresAt: "2026-09-05T10:00:00Z",
    template: { id: "us", version: 1 },
    photo: { width: 600, height: 600, mime: "image/jpeg" },
  };
  return {
    FinalPage: ({
      onBack,
      onRestart,
      onStaged,
    }: {
      onBack: () => void;
      onRestart: () => void;
      onStaged: (r: { saved: typeof saved; idempotencyKey: string } | null) => void;
    }) => (
      <>
        <p>终态页</p>
        <button type="button" onClick={onBack}>
          返回编辑
        </button>
        <button type="button" onClick={onRestart}>
          重新开始
        </button>
        <button type="button" onClick={() => onStaged({ saved, idempotencyKey: "k" })}>
          模拟暂存成功
        </button>
      </>
    ),
  };
});

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** 带真实 Layout 导航与路由拦截图腾的挂载（useBlocker 需要数据路由上下文） */
function mount() {
  const router = createMemoryRouter(routes, { initialEntries: ["/create"] });
  render(<RouterProvider router={router} />);
  return router;
}

/** 走到编辑器之前的公共路径 */
function walkToEditor() {
  mount();
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
    mount();
    const bar = screen.getByRole("list", { name: "创建进度" });
    expect(bar).toBeInTheDocument();
    expect(screen.getByText("1. 选择模板").getAttribute("aria-current")).toBe("step");
  });

  it("inserts a review step between capture and the editor (SPEC 流程)", () => {
    // 回归：拍摄或上传后曾直接跳进编辑器，用户没有确认或重拍的机会
    mount();
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

describe("离开创建流程的拦截（A11）", () => {
  it.each(["取回照片", "隐私说明", "Portrait Booth", "隐私与留存说明"])(
    "blocks leaving via the %s link and keeps the flow intact",
    (exit) => {
      // 回归：四个出口任一点击即静默卸载，照片/裁剪/撤销栈全部蒸发
      walkToEditor();

      fireEvent.click(screen.getByRole("link", { name: exit }));
      // 编辑步骤仍在、资源未释放、出现应用内确认块
      expect(screen.getByText("编辑器：缩放 初始")).toBeInTheDocument();
      expect(dispose).not.toHaveBeenCalled();
      expect(screen.getByRole("alertdialog")).toHaveTextContent(/未保存/);

      fireEvent.click(screen.getByRole("button", { name: "留在本页" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(screen.getByText("编辑器：缩放 初始")).toBeInTheDocument();
      expect(dispose).not.toHaveBeenCalled();
    },
  );

  it("releases resources only after confirming the leave", () => {
    walkToEditor();
    fireEvent.click(screen.getByRole("link", { name: "取回照片" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(dispose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "继续离开" }));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "取回照片" })).toBeInTheDocument();
  });

  it("names the retrieval code and delete secret in the staged leave confirmation", () => {
    // 已暂存时确认文案必须点名取回码与删除密钥无法找回，并就地提供回执下载
    mount();
    click("选择这个模板");
    click("上传照片");
    click("完成上传");
    click("使用这张照片");
    click("完成编辑");
    fireEvent.click(screen.getByRole("button", { name: "模拟暂存成功" }));

    fireEvent.click(screen.getByRole("link", { name: "取回照片" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("取回码");
    expect(dialog).toHaveTextContent("删除密钥");
    expect(dialog).toHaveTextContent("无法找回");
    expect(screen.getByRole("button", { name: /下载回执/ })).toBeInTheDocument();
  });

  it("does not silently drop the flow on the browser back gesture", async () => {
    const router = createMemoryRouter(routes, {
      initialEntries: ["/", "/create"],
      initialIndex: 1,
    });
    render(<RouterProvider router={router} />);
    click("选择这个模板");
    click("上传照片");
    click("完成上传");
    click("使用这张照片");

    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.getByText("编辑器：缩放 初始")).toBeInTheDocument();
    expect(dispose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/未保存/);
  });

  it("does not block when navigating to the same route", () => {
    // 防过度修复：已在 /create 时点「创建照片」不弹确认
    walkToEditor();
    fireEvent.click(screen.getByRole("link", { name: "创建照片" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(dispose).not.toHaveBeenCalled();
    expect(screen.getByText("编辑器：缩放 初始")).toBeInTheDocument();
  });
});
