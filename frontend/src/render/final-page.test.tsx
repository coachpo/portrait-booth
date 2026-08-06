import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_TRANSFORM } from "../editor/edit-transform";
import type { SourceImage } from "../image/source";
import type { TemplateEntry } from "../lib/templates/types";
import { FinalPage, physicalSizeInfo } from "./final-page";

vi.mock("./final-artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./final-artifact")>();
  return { ...actual, renderFinalArtifact: vi.fn() };
});
vi.mock("./checks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./checks")>();
  return { ...actual, buildChecks: vi.fn() };
});

import { RenderError, renderFinalArtifact } from "./final-artifact";
import { buildChecks } from "./checks";

const template = {
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
} as unknown as TemplateEntry;

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

const fakeArtifact = {
  artifactId: "a1",
  blob: new Blob([new Uint8Array(5000)], { type: "image/jpeg" }),
  coverage: { scannedPixels: 500 * 653, transparentPixels: 0 },
  manifest: {
    schemaVersion: 1 as const,
    templateId: "fi",
    templateVersion: 1,
    widthPx: 500,
    heightPx: 653,
    mime: "image/jpeg" as const,
    orientationNormalized: true as const,
    matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    flipX: false,
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

function renderPage(onBack = vi.fn(), onRestart = vi.fn()) {
  return render(
    <FinalPage
      source={source}
      template={template}
      transform={IDENTITY_TRANSFORM}
      onBack={onBack}
      onRestart={onRestart}
      staged={null}
      stagedStale={false}
      onStaged={vi.fn()}
    />,
  );
}

describe("FinalPage", () => {
  it("renders artifact details and check summary (OUT-007)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([
      { id: "exact-pixels", label: "像素尺寸", status: "pass", detail: "500×653" },
      { id: "pose", label: "姿态检查", status: "unknown" },
    ]);
    renderPage();

    expect(await screen.findByText("500×653")).toBeInTheDocument();
    expect(screen.getByText("JPEG · sRGB")).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === "fi@1")).toBeInTheDocument();
    expect(screen.getByText(/4\.9 KB/)).toBeInTheDocument();
    expect(screen.getByText("通过")).toBeInTheDocument();
    expect(screen.getByText("未检查")).toBeInTheDocument();
  });

  it("renders a manual check item as 需人工确认 with the check-manual class (P8)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([
      {
        id: "capture:x",
        label: "拍摄要求",
        status: "manual",
        detail: "官方原文：plain white background",
      },
    ]);
    renderPage();

    expect(await screen.findByText("需人工确认")).toBeInTheDocument();
    expect(screen.getByText("（官方原文：plain white background）")).toBeInTheDocument();
    const li = screen.getByText("需人工确认").closest("li");
    expect(li).not.toBeNull();
    expect(li!.className).toContain("check-manual");
  });

  it("shows the export filename without identity info (OUT-008)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    renderPage();
    const btn = await screen.findByRole("button", { name: /下载/ });
    expect(btn.textContent).toMatch(/^下载 fi-id-digital_upload-\d{8}\.jpg$/);
    expect(btn.textContent).not.toMatch(/photo|KEY|姓名/i);
  });

  it("shows physical size for paper templates", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const paper = {
      ...template,
      revision: {
        ...template.revision,
        output: {
          kind: "physical_raster",
          widthMm: 35,
          heightMm: 45,
          printPpi: 300,
          rounding: "nearest",
          widthPx: 413,
          heightPx: 531,
          pixelDerivation: "round(mm / 25.4 * printPpi)",
          ppiProvenance: "derived",
          calibrationProfileId: "none",
        },
      },
    } as unknown as TemplateEntry;
    render(
      <FinalPage
        source={source}
        template={paper}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    const dd = await screen.findByText(/35×45 毫米/);
    expect(dd).toBeInTheDocument();
    expect(dd.textContent).toContain("参考图");
    expect(screen.queryByText(/可按实际尺寸打印/)).toBeNull();
  });

  it("labels portal_verified + active paper as 可按实际尺寸打印 (P5)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const paper = {
      ...template,
      publication: { ...template.publication, status: "active" as const },
      revision: {
        ...template.revision,
        output: {
          kind: "physical_raster",
          widthMm: 35,
          heightMm: 45,
          printPpi: 300,
          rounding: "nearest",
          widthPx: 413,
          heightPx: 531,
          pixelDerivation: "round(mm / 25.4 * printPpi)",
          ppiProvenance: "portal_verified",
          calibrationProfileId: "none",
        },
      },
    } as unknown as TemplateEntry;
    render(
      <FinalPage
        source={source}
        template={paper}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    const dd = await screen.findByText(/35×45 毫米/);
    expect(dd.textContent).toContain("可按实际尺寸打印");
    expect(dd.textContent).not.toContain("参考图");
  });

  it("never labels portal_verified + reference_only paper as printable (P5)", async () => {
    // 合取判据：只看 ppiProvenance 会把尚未通过校准打印的模板误标成可打印
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const paper = {
      ...template,
      publication: { ...template.publication, status: "reference_only" as const },
      revision: {
        ...template.revision,
        output: {
          kind: "physical_raster",
          widthMm: 35,
          heightMm: 45,
          printPpi: 300,
          rounding: "nearest",
          widthPx: 413,
          heightPx: 531,
          pixelDerivation: "round(mm / 25.4 * printPpi)",
          ppiProvenance: "portal_verified",
          calibrationProfileId: "none",
        },
      },
    } as unknown as TemplateEntry;
    render(
      <FinalPage
        source={source}
        template={paper}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    const dd = await screen.findByText(/35×45 毫米/);
    expect(dd.textContent).toContain("参考图");
    expect(screen.queryByText(/可按实际尺寸打印/)).toBeNull();
  });

  it("physicalSizeInfo judges print-readiness by provenance and status (P5)", () => {
    const base = {
      ...template,
      publication: { ...template.publication, status: "active" as const },
      revision: {
        ...template.revision,
        output: {
          kind: "physical_raster",
          widthMm: 35,
          heightMm: 45,
          printPpi: 300,
          rounding: "nearest",
          widthPx: 413,
          heightPx: 531,
          pixelDerivation: "round(mm / 25.4 * printPpi)",
          ppiProvenance: "source_literal",
          calibrationProfileId: "none",
        },
      },
    } as unknown as TemplateEntry;
    const withProvenance = (ppiProvenance: string) =>
      ({
        ...base,
        revision: { ...base.revision, output: { ...base.revision.output, ppiProvenance } },
      }) as unknown as TemplateEntry;
    expect(physicalSizeInfo(withProvenance("source_literal"))!.printReady).toBe(false);
    expect(physicalSizeInfo(withProvenance("derived"))!.printReady).toBe(false);
    expect(physicalSizeInfo(withProvenance("portal_verified"))!.printReady).toBe(true);
    expect(physicalSizeInfo(template as unknown as TemplateEntry)).toBeNull(); // exact_pixels 无物理尺寸
    expect(physicalSizeInfo(withProvenance("portal_verified"))!.mm).toBe("35×45 毫米");
  });

  it("does not show mm or print claims for pixel templates (P5)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    renderPage();
    await screen.findByRole("heading", { name: "终态照片" });
    expect(screen.queryByText(/毫米/)).toBeNull();
    expect(screen.queryByText(/打印/)).toBeNull();
  });

  it("shows an error with retry when rendering fails", async () => {
    vi.mocked(renderFinalArtifact).mockRejectedValue(new Error("渲染失败"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("渲染失败");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("offers a downgrade to the default size on size-limit errors (P6)", async () => {
    vi.mocked(renderFinalArtifact).mockRejectedValue(
      new RenderError("size-limit", "已尝试所有压缩档位，仍超出文件体积上限"),
    );
    const onUseDefaultSize = vi.fn();
    render(
      <FinalPage
        source={source}
        template={template}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
        selectedSize={{ width: 1200, height: 1200 }}
        onUseDefaultSize={onUseDefaultSize}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("已尝试所有压缩档位");
    // 模板默认 500×653：重试跑同一尺寸必然再次失败，必须给出降档出口
    const downgrade = screen.getByRole("button", { name: "改用 500×653 重新生成" });
    fireEvent.click(downgrade);
    expect(onUseDefaultSize).toHaveBeenCalled();
  });

  it("does not offer the downgrade when already on the default size (P6)", async () => {
    vi.mocked(renderFinalArtifact).mockRejectedValue(
      new RenderError("size-limit", "已尝试所有压缩档位，仍超出文件体积上限"),
    );
    renderPage(); // selectedSize 未传 = 默认档
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /重新生成/ })).toBeNull();
  });

  it("discloses sources, restrictions and review notes on the final page (P3)", async () => {
    // 旧实现：终态页无来源、无限制短语、无复核注记
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const withSources = {
      ...template,
      revision: {
        ...template.revision,
        sources: [
          {
            id: "s1",
            url: "https://example.com/spec",
            title: "官方规格",
            authority: "测试机构",
            accessedAt: "2026-08-06",
            sourceUpdatedAt: "2026-01-01",
          },
        ],
        sourceNotes: { zh: ["复核注记甲", "复核注记乙"] },
      },
    } as unknown as TemplateEntry;
    render(
      <FinalPage
        source={source}
        template={withSources}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "终态照片" });
    expect(screen.getByText("2026-08-06")).toBeInTheDocument(); // 本项目复核日期
    expect(screen.getByText("更新于 2026-01-01")).toBeInTheDocument();
    expect(screen.getByText("复核注记甲")).toBeInTheDocument();
    expect(screen.getByText("复核注记乙")).toBeInTheDocument();
    // 限制短语：fi 夹具的 mirror/retouch/backgroundReplace 都是 forbidden
    expect(screen.getByText(/模板禁止镜像/)).toBeInTheDocument();
    // 不出现无依据的合规/可提交文案
    expect(screen.queryByText(/可提交成品/)).toBeNull();
    expect(screen.queryByText(/已合规/)).toBeNull();
  });

  it("offers escape hatches when rendering fails (A3)", async () => {
    // 回归：失败态只剩「重试」，没有回编辑/重开的出口
    vi.mocked(renderFinalArtifact).mockRejectedValue(new Error("BOOM"));
    const onBack = vi.fn();
    const onRestart = vi.fn();
    renderPage(onBack, onRestart);

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "返回编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "重新开始" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("starts the retry from a clean slate (A3)", async () => {
    // 回归：失败一次再重试成功，旧错误提示与「重试」按钮必须消失
    vi.mocked(renderFinalArtifact)
      .mockRejectedValueOnce(new Error("BOOM"))
      .mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    renderPage();

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("button", { name: /下载/ });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("drops the stale artifact when a re-render fails (A3)", async () => {
    // 回归：先成功后失败，旧成品的「下载」「暂存」入口不得残留
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const view = renderPage();
    await screen.findByRole("button", { name: /下载/ });

    vi.mocked(renderFinalArtifact).mockRejectedValue(new Error("BOOM"));
    view.rerender(
      <FinalPage
        source={source}
        template={template}
        transform={{ ...IDENTITY_TRANSFORM }}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /下载/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /暂存/ })).toBeNull();
  });

  it("navigates back to editing and restart", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const onBack = vi.fn();
    const onRestart = vi.fn();
    renderPage(onBack, onRestart);
    await screen.findByRole("button", { name: /下载/ });
    const back = screen.getByRole("button", { name: "返回编辑" });
    back.click();
    expect(onBack).toHaveBeenCalledTimes(1);
    const restart = screen.getByRole("button", { name: "重新开始" });
    restart.click();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("keeps the artifact immutable across re-renders", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const { rerender } = renderPage();
    await screen.findByRole("button", { name: /下载/ });
    rerender(
      <FinalPage
        source={source}
        template={template}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    expect(renderFinalArtifact).toHaveBeenCalledTimes(1);
  });
});
