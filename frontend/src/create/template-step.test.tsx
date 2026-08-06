import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchTemplateCatalog } from "../lib/templates/catalog";
import type { TemplateCatalog, TemplateEntry } from "../lib/templates/types";
import { TemplateStep } from "./template-step";

vi.mock("../lib/templates/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/templates/catalog")>();
  return { ...actual, fetchTemplateCatalog: vi.fn() };
});

const mockedFetch = vi.mocked(fetchTemplateCatalog);

function entry(
  overrides: Partial<TemplateEntry["revision"]> = {},
  publication: Partial<TemplateEntry["publication"]> = {},
): TemplateEntry {
  return {
    revision: {
      revisionId: "t@1",
      id: "t",
      version: 1,
      schemaVersion: 1,
      label: { zh: "测试模板" },
      jurisdiction: "US",
      documentType: "passport",
      submissionChannel: "digital_upload",
      applicantClass: "adult",
      sources: [
        {
          id: "s1",
          url: "https://example.com/spec",
          title: "官方规格",
          authority: "测试机构",
          accessedAt: "2026-08-06",
        },
      ],
      output: {
        kind: "exact_pixels",
        widthPx: 100,
        heightPx: 100,
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
      ...overrides,
    },
    contentHash: "abc",
    publication: {
      revisionId: "t@1",
      status: "active",
      statusReason: "ok",
      owner: "o",
      reviewer: "r",
      verifiedAt: "2026-08-06",
      reviewDueAt: "2026-11-04",
      effectiveAt: "2026-08-06",
      publicationRevision: 1,
      ...publication,
    },
  };
}

const catalog: TemplateCatalog = {
  schemaVersion: 1,
  catalogVersion: "v",
  templates: [
    entry(),
    entry({
      revisionId: "generic@1",
      id: "generic",
      label: { zh: "通用肖像" },
      jurisdiction: "generic",
      documentType: "portrait",
      sourceNotes: { zh: ["非官方证件模板。"] },
    }),
    entry(
      {
        revisionId: "us-paper@1",
        id: "us-paper",
        label: { zh: "美国护照纸质" },
        submissionChannel: "paper",
      },
      {
        revisionId: "us-paper@1",
        status: "reference_only",
        statusReason: "尚未通过校准打印测试",
      },
    ),
  ],
};

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("TemplateStep", () => {
  it("renders templates after catalog loads", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(<TemplateStep onSelect={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "测试模板" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通用肖像" })).toBeInTheDocument();
  });

  it("shows error and retries on failure", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("网络错误")).mockResolvedValueOnce(catalog);
    render(<TemplateStep onSelect={vi.fn()} />);
    expect(await screen.findByText("模板目录加载失败：网络错误")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "测试模板" })).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("filters by jurisdiction chip", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(<TemplateStep onSelect={vi.fn()} />);
    await screen.findByRole("heading", { name: "测试模板" });
    fireEvent.click(screen.getByRole("button", { name: "美国" }));
    expect(screen.queryByRole("heading", { name: "通用肖像" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "测试模板" })).toBeInTheDocument();
  });

  it("marks non-official and reference_only templates", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(<TemplateStep onSelect={vi.fn()} />);
    await screen.findByRole("heading", { name: "测试模板" });
    expect(screen.getByText("非证件模板")).toBeInTheDocument();
    expect(screen.getByText("仅供参考")).toBeInTheDocument();
    expect(screen.getByText("尚未通过校准打印测试")).toBeInTheDocument();
  });

  it("only active templates are selectable", async () => {
    mockedFetch.mockResolvedValue(catalog);
    const onSelect = vi.fn();
    render(<TemplateStep onSelect={onSelect} />);
    await screen.findByRole("heading", { name: "测试模板" });
    const selectable = screen.getAllByRole("button", { name: "选择此模板" });
    expect(selectable).toHaveLength(2);
    fireEvent.click(selectable[0]);
    expect(onSelect).toHaveBeenCalledOnce();
    const disabled = screen.getByRole("button", { name: "不可用于提交" });
    expect(disabled).toBeDisabled();
  });

  it("shows source requirement markers when the template demands them (P2)", async () => {
    mockedFetch.mockResolvedValue({
      ...catalog,
      templates: [
        ...catalog.templates,
        entry({
          revisionId: "pro@1",
          id: "pro",
          label: { zh: "需专业拍摄" },
          capabilities: {
            selfCapture: "certified_only",
            crop: "allowed",
            rotate: "allowed",
            mirror: "forbidden",
            retouch: "forbidden",
            backgroundReplace: "forbidden",
            requiresOriginalCameraFile: true,
            requiresProfessionalPhotographer: true,
          },
        }),
      ],
    });
    render(<TemplateStep onSelect={vi.fn()} />);
    await screen.findByRole("heading", { name: "需专业拍摄" });
    expect(screen.getByText(/要求认证摄影师拍摄/)).toBeInTheDocument();
    expect(screen.getByText(/原始相机文件/)).toBeInTheDocument();
    expect(screen.getByText(/认证渠道拍摄/)).toBeInTheDocument();
  });

  it("hides requirement markers when all prerequisites are satisfied (P2)", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(<TemplateStep onSelect={vi.fn()} />);
    await screen.findByRole("heading", { name: "测试模板" });
    expect(screen.queryByText(/认证摄影师/)).toBeNull();
    expect(screen.queryByText(/原始相机文件/)).toBeNull();
  });
});
