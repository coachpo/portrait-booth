import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "测试模板" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通用肖像" })).toBeInTheDocument();
  });

  it("shows error and retries on failure", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("网络错误")).mockResolvedValueOnce(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("模板目录加载失败：网络错误")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "测试模板" })).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("filters by jurisdiction chip", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "测试模板" });
    fireEvent.click(screen.getByRole("button", { name: "美国" }));
    expect(screen.queryByRole("heading", { name: "通用肖像" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "测试模板" })).toBeInTheDocument();
  });

  it("marks non-official and reference_only templates", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "测试模板" });
    expect(screen.getByText("非证件模板")).toBeInTheDocument();
    expect(screen.getByText("仅供参考")).toBeInTheDocument();
    expect(screen.getByText("尚未通过校准打印测试")).toBeInTheDocument();
  });

  it("only active templates are selectable", async () => {
    mockedFetch.mockResolvedValue(catalog);
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <TemplateStep onSelect={onSelect} />
      </MemoryRouter>,
    );
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
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "需专业拍摄" });
    const card = screen
      .getByRole("heading", { name: "需专业拍摄" })
      .closest("li.template-card") as HTMLElement;
    // 限制短语（TMP-002，以句号结尾）与前置约束（以分号承接工具说明）各出现一次
    expect(within(card).getByText(/要求认证摄影师拍摄。/)).toBeInTheDocument();
    expect(within(card).getByText(/要求原始相机文件。/)).toBeInTheDocument();
    expect(within(card).getByText(/重新编码的 JPEG/)).toBeInTheDocument();
    expect(within(card).getByText(/本工具不产出认证摄影师出品/)).toBeInTheDocument();
  });

  it("hides requirement markers when all prerequisites are satisfied (P2)", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "测试模板" });
    expect(screen.queryByText(/认证摄影师/)).toBeNull();
    expect(screen.queryByText(/原始相机文件/)).toBeNull();
  });

  it("discloses review date, source update time, notes and restrictions (P3)", async () => {
    // 旧实现：官方模板一条注记都看不到、dl 无复核日期/版本、来源无更新时间
    mockedFetch.mockResolvedValue({
      ...catalog,
      templates: catalog.templates.map((t) =>
        t.revision.revisionId === "t@1"
          ? entry({
              revisionId: "t@1",
              sourceNotes: { zh: ["注记甲", "注记乙"] },
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
            })
          : t,
      ),
    });
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "测试模板" });
    const card = screen
      .getByRole("heading", { name: "测试模板" })
      .closest("li.template-card") as HTMLElement;
    expect(within(card).getByText("2026-08-06")).toBeInTheDocument(); // 本项目复核日期
    expect(within(card).getByText("更新于 2026-01-01")).toBeInTheDocument();
    expect(within(card).getByText("访问于 2026-08-06")).toBeInTheDocument();
    expect(within(card).getByText("注记甲")).toBeInTheDocument();
    expect(within(card).getByText("注记乙")).toBeInTheDocument();
    expect(within(card).getByText(/模板禁止镜像/)).toBeInTheDocument(); // 限制短语
    expect(within(card).getByText("官方来源")).toBeInTheDocument(); // 官方模板保持原标题
  });

  it("links every card to its template detail page (P4)", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "测试模板" });
    const links = screen.getAllByRole("link", { name: "查看模板详情" });
    expect(links).toHaveLength(3);
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/templates/t@1");
    expect(hrefs).toContain("/templates/generic@1");
    expect(hrefs).toContain("/templates/us-paper@1");
  });

  it("places the statusReason above the card details (P3)", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "测试模板" });
    const card = screen
      .getByRole("heading", { name: "美国护照纸质" })
      .closest("li.template-card") as HTMLElement;
    const reason = within(card).getByText("尚未通过校准打印测试");
    const details = card.querySelector(".template-card-details")!;
    // reason 排在 details 之前（旧实现在 dl 之后）
    const following = reason.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(following).toBeTruthy();
  });
});
