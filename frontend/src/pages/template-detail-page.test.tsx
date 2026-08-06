import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchTemplateCatalog } from "../lib/templates/catalog";
import type { TemplateEntry } from "../lib/templates/types";
import { TemplateDetailPage } from "./template-detail-page";

vi.mock("../lib/templates/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/templates/catalog")>();
  return { ...actual, fetchTemplateCatalog: vi.fn() };
});

function entry(
  overrides: Partial<TemplateEntry["revision"]> = {},
  pub: Partial<TemplateEntry["publication"]> = {},
): TemplateEntry {
  return {
    revision: {
      revisionId: "rich@1",
      id: "rich",
      version: 1,
      schemaVersion: 1,
      label: { zh: "富模板" },
      jurisdiction: "US",
      documentType: "passport",
      submissionChannel: "digital_upload",
      applicantClass: "adult",
      sources: [
        {
          id: "a",
          url: "https://a.example/spec",
          title: "源A规格",
          authority: "机构甲",
          accessedAt: "2026-08-01",
          sourceUpdatedAt: "2026-01-01",
        },
        {
          id: "b",
          url: "https://b.example/spec",
          title: "源B规格",
          authority: "机构乙",
          accessedAt: "2026-08-02",
        },
      ],
      output: {
        kind: "exact_pixels",
        widthPx: 600,
        heightPx: 600,
        aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
      },
      cropRules: [
        {
          id: "crop1",
          metric: "head-height",
          min: 32,
          max: 36,
          unit: "mm",
          anchors: ["crown", "chin"],
          axis: "y",
          bounds: "inclusive",
          coordinateSpace: "normalized",
          evaluation: "automatic",
          enforcement: "mandatory",
          provenance: "source_literal",
          sourceRefs: ["ref-1"],
          sourceLiteral: "32-36 mm crown point (without hair/beard) to chin tip",
        },
      ],
      captureRules: [
        {
          id: "cap1",
          check: "mirror",
          expected: false,
          evaluation: "automatic",
          enforcement: "mandatory",
          provenance: "source_literal",
          sourceRefs: [],
          sourceLiteral: "no mirror",
        },
      ],
      overlay: { kind: "none", ruleIds: [] },
      capabilities: {
        selfCapture: "allowed",
        crop: "warn",
        rotate: "forbidden",
        mirror: "warn",
        retouch: "forbidden",
        backgroundReplace: "allowed",
        requiresOriginalCameraFile: true,
        requiresProfessionalPhotographer: false,
      },
      sourceNotes: { zh: ["注记一", "注记二", "注记三"] },
      ...overrides,
    },
    contentHash: "abc123",
    publication: {
      revisionId: "rich@1",
      status: "active",
      statusReason: "复核通过，可正常使用",
      owner: "内容维护",
      reviewer: "内容复核",
      verifiedAt: "2026-08-06",
      reviewDueAt: "2026-11-04",
      effectiveAt: "2026-08-06",
      publicationRevision: 1,
      ...pub,
    },
  } as unknown as TemplateEntry;
}

function renderDetail(entries: TemplateEntry[], path = "/templates/rich@1") {
  vi.mocked(fetchTemplateCatalog).mockResolvedValue({
    schemaVersion: 1,
    catalogVersion: "v",
    templates: entries,
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/templates/:revisionId" element={<TemplateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TemplateDetailPage", () => {
  it("renders all source notes, not just the first one (P4)", async () => {
    renderDetail([entry()]);
    expect(await screen.findByRole("heading", { name: "富模板" })).toBeInTheDocument();
    expect(screen.getByText("注记二")).toBeInTheDocument();
    expect(screen.getByText("注记三")).toBeInTheDocument();
  });

  it("renders a readable value for an expected:false capture rule (P4)", async () => {
    renderDetail([entry()]);
    await screen.findByRole("heading", { name: "富模板" });
    expect(screen.getByText(/必须不满足/)).toBeInTheDocument();
  });

  it("discloses source update times, accessed times and links (P4)", async () => {
    renderDetail([entry()]);
    await screen.findByRole("heading", { name: "富模板" });
    expect(screen.getByText("访问于 2026-08-01")).toBeInTheDocument();
    expect(screen.getByText("访问于 2026-08-02")).toBeInTheDocument();
    expect(screen.getByText(/官方更新于 2026-01-01/)).toBeInTheDocument();
    // 缺失 sourceUpdatedAt 的来源显示明确措辞，不是空串
    const missing = screen.getByText("官方未标注更新时间");
    expect(missing).toBeInTheDocument();
    const linkB = screen.getByRole("link", { name: /源B规格/ });
    expect(linkB.getAttribute("href")).toBe("https://b.example/spec");
    expect(linkB.getAttribute("rel")).toContain("noopener");
  });

  it("shows governance dates and statusReason for active and reference_only (P4)", async () => {
    renderDetail(
      [
        entry(),
        entry(
          { revisionId: "ref@1" },
          { revisionId: "ref@1", status: "reference_only", statusReason: "尚未通过校准打印测试" },
        ),
      ],
      "/templates/ref@1",
    );
    await screen.findByRole("heading", { name: "富模板" });
    expect(screen.getAllByText("2026-08-06").length).toBeGreaterThan(0); // verifiedAt
    expect(screen.getByText("2026-11-04")).toBeInTheDocument(); // reviewDueAt
    expect(screen.getByText("尚未通过校准打印测试")).toBeInTheDocument();
  });

  it("renders all eight capability fields with distinct boolean wording (P4)", async () => {
    renderDetail([entry()]);
    await screen.findByRole("heading", { name: "富模板" });
    const liText = (text: string) =>
      screen.getByText((_, el) => el?.tagName === "LI" && el?.textContent?.includes(text));
    expect(liText("自行拍摄：允许")).toBeInTheDocument();
    expect(liText("调整构图：警告")).toBeInTheDocument();
    expect(liText("旋转：禁止")).toBeInTheDocument();
    expect(liText("镜像：警告")).toBeInTheDocument();
    expect(liText("修饰：禁止")).toBeInTheDocument();
    expect(liText("背景替换：允许")).toBeInTheDocument();
    expect(liText("原始相机文件：要求")).toBeInTheDocument();
    expect(liText("认证摄影师：不要求")).toBeInTheDocument();
  });

  it("never claims submittability for reference_only templates (P4)", async () => {
    renderDetail(
      [
        entry(
          { revisionId: "ref@1" },
          { revisionId: "ref@1", status: "reference_only", statusReason: "尚未通过校准打印测试" },
        ),
      ],
      "/templates/ref@1",
    );
    await screen.findByRole("heading", { name: "富模板" });
    expect(screen.getByText("尚未通过校准打印测试")).toBeInTheDocument();
    expect(screen.queryByText(/可提交/)).toBeNull();
    expect(screen.queryByText(/已合规/)).toBeNull();
    expect(screen.queryByText(/符合官方要求/)).toBeNull();
    expect(screen.queryByRole("button", { name: /用此模板创建/ })).toBeNull();
  });

  it("marks non-official templates and shows empty-rule wording (P4)", async () => {
    renderDetail(
      [
        entry({
          revisionId: "portrait@1",
          id: "portrait",
          label: { zh: "通用肖像" },
          documentType: "portrait",
          cropRules: [],
          captureRules: [],
        }),
      ],
      "/templates/portrait@1",
    );
    await screen.findByRole("heading", { name: "通用肖像" });
    expect(screen.getByText("非证件模板")).toBeInTheDocument();
    expect(screen.getByText("本模板未声明裁剪规则。")).toBeInTheDocument();
    expect(screen.getByText("本模板未声明拍摄规则。")).toBeInTheDocument();
  });

  it("shows a clear missing state for unknown revision ids (P4)", async () => {
    renderDetail([entry()], "/templates/nope@9");
    expect(await screen.findByText("模板不存在")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回模板列表" })).toBeInTheDocument();
  });

  it("offers a working retry when the catalog fetch fails (P4)", async () => {
    vi.mocked(fetchTemplateCatalog)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        catalogVersion: "v",
        templates: [entry()],
      });
    renderDetail([]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("模板目录加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "富模板" })).toBeInTheDocument();
    expect(fetchTemplateCatalog).toHaveBeenCalledTimes(2);
  });
});
