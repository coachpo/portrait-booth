import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TemplateEntry } from "../lib/templates/types";
import type { SourceImage } from "../image/source";
import { IDENTITY_TRANSFORM, type EditorState } from "./edit-transform";
import { EditorStep } from "./editor-step";

function fakeTemplate(overrides: Partial<TemplateEntry["revision"]> = {}): TemplateEntry {
  return {
    revision: {
      revisionId: "fi@1",
      id: "fi",
      version: 1,
      schemaVersion: 1,
      label: { zh: "芬兰警方证件" },
      jurisdiction: "FI",
      documentType: "id",
      submissionChannel: "digital_upload",
      applicantClass: "adult",
      sources: [],
      output: {
        kind: "exact_pixels",
        widthPx: 500,
        heightPx: 653,
        aspect: { width: 500, height: 653, enforcement: "mandatory", provenance: "derived" },
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
      ...overrides,
    },
    contentHash: "abc",
    publication: {
      revisionId: "fi@1",
      status: "active",
      statusReason: "ok",
      owner: "o",
      reviewer: "r",
      verifiedAt: "2026-08-06",
      reviewDueAt: "2026-11-04",
      effectiveAt: "2026-08-06",
      publicationRevision: 1,
    },
  };
}

type Caps = TemplateEntry["revision"]["capabilities"];

const BASE_CAPS: Caps = {
  selfCapture: "allowed",
  crop: "allowed",
  rotate: "allowed",
  mirror: "forbidden",
  retouch: "forbidden",
  backgroundReplace: "forbidden",
  requiresOriginalCameraFile: false,
  requiresProfessionalPhotographer: false,
};

/** capabilities 是整字段替换：按用例合并只改需要的策略 */
function withCaps(partial: Partial<Caps>): Partial<TemplateEntry["revision"]> {
  return { capabilities: { ...BASE_CAPS, ...partial } };
}

const source = {
  file: new File([new Uint8Array(4)], "photo.jpg", { type: "image/jpeg" }),
  format: "jpeg",
  orientation: 1,
  rawWidth: 800,
  rawHeight: 600,
  width: 800,
  height: 600,
  bitmap: { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap,
  previewUrl: "blob:fake",
  dispose: vi.fn(),
} as unknown as SourceImage;

function renderEditor(overrides: Partial<TemplateEntry["revision"]> = {}) {
  // jsdom 的 canvas.getContext 返回 null，组件绘制路径自动跳过；交互断言不依赖像素
  const onDone = vi.fn();
  const onBack = vi.fn();
  const view = render(
    <EditorStep
      source={source}
      template={fakeTemplate(overrides)}
      onDone={onDone}
      onBack={onBack}
    />,
  );
  return { onDone, onBack, ...view };
}

describe("EditorStep", () => {
  it("renders template label and controls", () => {
    renderEditor();
    expect(screen.getByRole("heading", { name: "编辑照片" })).toBeInTheDocument();
    expect(screen.getByText(/芬兰警方证件/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "旋转 90°" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重置" })).toBeDisabled();
  });

  it("disables mirror when the template forbids it (EDT-005)", () => {
    renderEditor();
    expect(screen.getByRole("button", { name: "水平镜像" })).toBeDisabled();
  });

  it("enables mirror when the template allows it", () => {
    renderEditor({
      capabilities: {
        selfCapture: "allowed",
        crop: "allowed",
        rotate: "allowed",
        mirror: "allowed",
        retouch: "forbidden",
        backgroundReplace: "forbidden",
        requiresOriginalCameraFile: false,
        requiresProfessionalPhotographer: false,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "水平镜像" }));
    expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();
  });

  it("records undo history after an edit and restores it", () => {
    const { onDone } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "旋转 90°" }));
    const undoBtn = screen.getByRole("button", { name: "撤销" });
    expect(undoBtn).toBeEnabled();
    fireEvent.click(undoBtn);
    expect(screen.getByRole("button", { name: "重置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重做" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: expect.objectContaining({ rotationDeg: 90, scale: 1 }),
      }),
    );
  });

  it("resets after edits", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "旋转 90°" }));
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled(); // 重置本身可撤销
    expect(screen.getByRole("button", { name: "重置" })).toBeDisabled();
  });

  it("applies scale via slider and keyboard", () => {
    const { onDone } = renderEditor();
    const slider = screen.getByRole("slider", { name: /缩放/ });
    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ transform: expect.objectContaining({ scale: 2 }) }),
    );
  });

  it("rotates 90 and raises scale to keep coverage", () => {
    const { onDone } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "旋转 90°" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));
    // 源 800×600 → 旋转后 cover 比例 653/800 > 500/800，scale 需抬升
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: expect.objectContaining({ rotationDeg: 90, scale: expect.any(Number) }),
      }),
    );
  });

  describe("pointer interaction (EDT-007)", () => {
    function canvasWithSize(width: number, height: number) {
      const canvas = screen.getByLabelText(/照片预览/) as HTMLCanvasElement;
      canvas.setPointerCapture = vi.fn();
      canvas.releasePointerCapture = vi.fn();
      vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        toJSON: () => ({}),
      } as DOMRect);
      return canvas;
    }

    it("normalizes drag by the canvas display size, not the output pixels", () => {
      // 回归：分母曾是输出像素。画布被 CSS 压到 250px 宽时，
      // 图像只跟着手指走一半的距离。
      const { onDone } = renderEditor();
      const canvas = canvasWithSize(250, 326);
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 25, clientY: 0 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));

      const state = onDone.mock.calls[0][0] as { transform: { translateX: number } };
      // 25 / 250 = 0.1；按输出宽度 500 归一化只会得到 0.05
      expect(state.transform.translateX).toBeCloseTo(0.1, 5);
    });

    it("offers button and numeric alternatives to dragging (WCAG 2.5.7)", () => {
      const { onDone } = renderEditor();
      fireEvent.click(screen.getByRole("button", { name: "右移" }));
      fireEvent.click(screen.getByRole("button", { name: "右移" }));
      fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));

      const state = onDone.mock.calls[0][0] as {
        transform: { translateX: number; translateY: number };
      };
      expect(state.transform.translateX).toBeCloseTo(0.04, 5);
      // 源 800×600 在 500×653 上 cover 后高度恰好贴合，纵向没有可平移的余量
      expect(state.transform.translateY).toBe(0);
    });

    it("refuses a nudge that would expose an edge", () => {
      const { onDone } = renderEditor();
      fireEvent.click(screen.getByRole("button", { name: "下移" }));
      fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));

      const state = onDone.mock.calls[0][0] as { transform: { translateY: number } };
      expect(state.transform.translateY).toBe(0);
    });

    it("recenters the photo", () => {
      const { onDone } = renderEditor();
      fireEvent.click(screen.getByRole("button", { name: "右移" }));
      fireEvent.click(screen.getByRole("button", { name: "居中" }));
      fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));

      const state = onDone.mock.calls[0][0] as { transform: { translateX: number } };
      expect(state.transform.translateX).toBe(0);
    });

    it("accepts a typed translation value", () => {
      const { onDone } = renderEditor();
      fireEvent.change(screen.getByLabelText("水平位置数值"), { target: { value: "0.1" } });
      fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));

      const state = onDone.mock.calls[0][0] as { transform: { translateX: number } };
      expect(state.transform.translateX).toBeCloseTo(0.1, 5);
    });

    it("scales with a two-finger pinch", () => {
      const { onDone } = renderEditor();
      const canvas = canvasWithSize(250, 326);
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 200, clientY: 100 });
      fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 300, clientY: 100 });
      fireEvent.pointerUp(canvas, { pointerId: 2 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));

      const state = onDone.mock.calls[0][0] as { transform: { scale: number } };
      // 两指间距从 100 拉到 200：缩放翻倍
      expect(state.transform.scale).toBeCloseTo(2, 5);
    });
  });

  it("notifies when a portal-source template needs no editing", () => {
    const { onDone } = renderEditor({
      output: { kind: "portal_source", officialPortalPerformsCrop: true },
    });
    expect(screen.getByText(/由官方门户处理裁剪/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: expect.objectContaining({ scale: 1, rotationDeg: 0 }),
      }),
    );
  });

  it("passes the restored initialState through for portal templates (P7)", () => {
    // 会话内换模板后带着外来编辑状态回到 !out 分支：继续不能再硬写 INITIAL
    const state: EditorState = {
      transform: { ...IDENTITY_TRANSFORM, scale: 2, flipX: true },
      history: { undo: [IDENTITY_TRANSFORM], redo: [] },
    };
    const onDone = vi.fn();
    render(
      <EditorStep
        source={source}
        template={fakeTemplate({
          output: { kind: "portal_source", officialPortalPerformsCrop: true },
        })}
        initialState={state}
        onDone={onDone}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onDone).toHaveBeenCalledWith(state);
  });
});

describe("capabilities 政策接入（P2）", () => {
  it("locks the rotate inputs and guards their onChange when rotation is forbidden", () => {
    // 回归：旋转禁令曾可被滑杆/数值框绕过——按钮灰了，输入框照样改
    const { onDone } = renderEditor(withCaps({ rotate: "forbidden" }));
    const number = screen.getByLabelText("旋转数值") as HTMLInputElement;
    expect(number).toBeDisabled();
    // jsdom 里 disabled 拦不住 fireEvent.change：回调内守卫才是真断言
    fireEvent.change(number, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));
    const state = onDone.mock.calls[0][0] as { transform: { rotationDeg: number } };
    expect(state.transform.rotationDeg).toBe(0);
  });

  it("locks compose controls and ignores pointer drags when crop is forbidden", () => {
    const { onDone } = renderEditor(withCaps({ crop: "forbidden" }));
    expect(screen.getByLabelText("缩放数值")).toBeDisabled();
    expect(screen.getByLabelText("水平位置数值")).toBeDisabled();
    expect(screen.getByLabelText("垂直位置数值")).toBeDisabled();
    expect(screen.getByRole("button", { name: "右移" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "居中" })).toBeDisabled();
    // 锁定原因（缩放控件外）与操作说明（预览下方）各有一条可见文案
    expect(screen.getByText(/固定在默认覆盖构图/)).toBeInTheDocument();
    expect(screen.getByText(/缩放、平移与方向键均已停用/)).toBeInTheDocument();

    // 指针拖移被输入边界拦截：transform 保持初始默认构图
    const canvas = screen.getByLabelText("照片预览（构图已锁定）");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));
    const state = onDone.mock.calls[0][0] as { transform: { translateX: number; scale: number } };
    expect(state.transform.translateX).toBe(0);
    expect(state.transform.scale).toBe(1);
  });

  it("renders distinguishable notices for retouch warn and backgroundReplace forbidden", () => {
    renderEditor(withCaps({ retouch: "warn" }));
    expect(screen.getByText("模板限制")).toBeInTheDocument();
    expect(screen.getByText(/对修饰有警告/)).toBeInTheDocument();
    expect(screen.getByText(/禁止背景替换/)).toBeInTheDocument();
    expect(screen.getByText(/禁止镜像/)).toBeInTheDocument();
  });
});
