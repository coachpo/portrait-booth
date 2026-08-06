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

const fakeArtifact = {
  artifactId: "a1",
  blob: new Blob([new Uint8Array(5000)], { type: "image/jpeg" }),
  coverage: { scannedPixels: 100, transparentPixels: 0 },
  manifest: {
    schemaVersion: 1 as const,
    templateId: "us",
    templateVersion: 1,
    widthPx: 600,
    heightPx: 600,
    mime: "image/jpeg" as const,
    orientationNormalized: true as const,
    matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    flipX: false,
  },
};

const saved = {
  key: "A7C2F9",
  keyDisplay: "A7C 2F9",
  deleteSecret: "secret-value-1234567890",
  expiresAt: "2026-09-05T10:00:00Z",
  template: { id: "us", version: 1 },
  photo: { width: 600, height: 600, mime: "image/jpeg" },
};

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

// 终态渲染与检查桩；final-page 与 review-step 保持真实
vi.mock("../render/final-artifact", () => ({
  renderFinalArtifact: vi.fn(async () => fakeArtifact),
}));
vi.mock("../render/checks", () => ({
  buildChecks: vi.fn(async () => []),
}));
vi.mock("../api/save", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/save")>();
  return {
    ...actual,
    createSaveSession: vi.fn(),
    savePhoto: vi.fn(),
    deletePhoto: vi.fn(),
  };
});
vi.mock("../api/service-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/service-policy")>();
  return { ...actual, fetchServicePolicy: vi.fn() };
});

import { createSaveSession, deletePhoto, savePhoto } from "../api/save";
import { fetchServicePolicy } from "../api/service-policy";

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** 走完整流程到终态页并暂存成功 */
async function walkToStaged() {
  render(<CreatePage />);
  click("选择这个模板");
  click("上传照片");
  click("完成上传");
  click("使用这张照片");
  click("完成编辑");
  await screen.findByRole("button", { name: "暂存并生成取回码" });
  click("暂存并生成取回码");
  click("确认并上传");
  await screen.findByText("A7C 2F9");
}

beforeEach(() => {
  vi.clearAllMocks();
  dispose.mockClear();
  vi.mocked(fetchServicePolicy).mockResolvedValue({
    temporaryStorageTtlSeconds: 2592000,
    retrievalMode: "key_only_ephemeral",
    maxUploadBytes: 15728640,
    policyVersion: 1,
  });
  vi.mocked(createSaveSession).mockResolvedValue(undefined);
  vi.mocked(savePhoto).mockResolvedValue(saved);
  vi.mocked(deletePhoto).mockResolvedValue(undefined);
});

describe("CreatePage 暂存回执", () => {
  it("keeps the staging receipt when going back to editing and returning", async () => {
    // 回归：回执只活在 StagingPanel 局部 state，返回编辑即卸载，
    // 取回码与删除密钥一起消失，照片变成谁也删不掉的孤儿
    await walkToStaged();

    click("返回编辑");
    click("完成编辑");

    expect(await screen.findByText("A7C 2F9")).toBeInTheDocument();
    expect(screen.getByText(/secret-value-1234567890/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下载回执/ })).toBeInTheDocument();
    // 服务端没有因为这一趟多出第二张照片，面板也不再提供第二次暂存
    expect(savePhoto).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "暂存并生成取回码" })).toBeNull();
  });

  it("asks for confirmation before restart discards a staged receipt", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await walkToStaged();

      click("重新开始");
      expect(confirm).toHaveBeenCalledTimes(1);
      // 取消：什么都不改，回执还在
      expect(screen.getByText("A7C 2F9")).toBeInTheDocument();

      confirm.mockReturnValue(true);
      click("重新开始");
      expect(screen.getByRole("button", { name: "选择这个模板" })).toBeInTheDocument();
    } finally {
      confirm.mockRestore();
    }
  });
});
