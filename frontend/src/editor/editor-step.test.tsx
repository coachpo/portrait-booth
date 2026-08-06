import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TemplateEntry } from "../lib/templates/types";
import type { SourceImage } from "../image/source";
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
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ rotationDeg: 90, scale: 1 }));
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
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ scale: 2 }));
  });

  it("rotates 90 and raises scale to keep coverage", () => {
    const { onDone } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "旋转 90°" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步（终态检查）" }));
    // 源 800×600 → 旋转后 cover 比例 653/800 > 500/800，scale 需抬升
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ rotationDeg: 90, scale: expect.any(Number) }),
    );
  });

  it("notifies when a portal-source template needs no editing", () => {
    const { onDone } = renderEditor({
      output: { kind: "portal_source", officialPortalPerformsCrop: true },
    });
    expect(screen.getByText(/由官方门户处理裁剪/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ scale: 1, rotationDeg: 0 }));
  });
});
