import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { SourceImage } from "../image/source";
import type { TemplateEntry } from "../lib/templates/types";
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

// 源图要明显大于模板输出（600×600），避免 EDT-004 分辨率不足警告干扰
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
  SourceStep: ({ onReady }: { onReady: (s: SourceImage) => void }) => (
    <button type="button" onClick={() => onReady(fakeSource())}>
      完成上传
    </button>
  ),
}));

vi.mock("./capture-step", () => ({
  CaptureStep: () => <p>拍摄步骤桩</p>,
}));

vi.mock("../render/final-page", () => ({
  FinalPage: ({ onBack }: { onBack: () => void }) => (
    <>
      <p>终态页</p>
      <button type="button" onClick={onBack}>
        返回编辑
      </button>
    </>
  ),
}));

// EditorStep 与 ReviewStep 用真实实现

function mount() {
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/create"] })} />);
}

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function walkToEditor() {
  mount();
  click("选择这个模板");
  click("上传照片");
  click("完成上传");
  click("使用这张照片");
  expect(screen.getByRole("heading", { name: "编辑照片" })).toBeInTheDocument();
}

function scaleInput(): HTMLInputElement {
  return screen.getByLabelText("缩放数值") as HTMLInputElement;
}

describe("CreatePage 编辑状态保留（A4）", () => {
  it("keeps unsubmitted transform and undo history when returning from the editor", () => {
    // 回归：返回确认页再回来，缩放/撤销栈曾全部归零
    walkToEditor();
    expect(scaleInput().value).toBe("1");
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();

    fireEvent.change(scaleInput(), { target: { value: "1.6" } });
    click("返回重新选择照片");
    expect(screen.getByRole("heading", { name: "确认这张照片" })).toBeInTheDocument();

    click("使用这张照片");
    expect(scaleInput().value).toBe("1.6");
    expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();
  });

  it("keeps the state committed at the last final-check submission", () => {
    // 二次提交场景：退回上次提交点，而不是全部归零
    walkToEditor();
    fireEvent.change(scaleInput(), { target: { value: "1.6" } });
    click("下一步（终态检查）");
    expect(screen.getByText("终态页")).toBeInTheDocument();

    click("返回编辑");
    expect(scaleInput().value).toBe("1.6");
    fireEvent.change(scaleInput(), { target: { value: "2.4" } });

    click("返回重新选择照片");
    click("使用这张照片");
    expect(scaleInput().value).toBe("2.4");
  });

  it("resets the editor state when the photo is actually replaced", () => {
    // 反向锁不变式 2：真换了照片，编辑状态必须作废归零
    walkToEditor();
    fireEvent.change(scaleInput(), { target: { value: "1.6" } });

    click("返回重新选择照片");
    click("重新选择文件");
    click("完成上传");
    click("使用这张照片");

    expect(scaleInput().value).toBe("1");
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
  });
});
