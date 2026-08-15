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
      label: { en: "Test template" },
      jurisdiction: "US",
      documentType: "passport",
      submissionChannel: "digital_upload",
      applicantClass: "adult",
      sources: [
        {
          id: "s1",
          url: "https://example.com/spec",
          title: "Official specification",
          authority: "Test authority",
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
      label: { en: "Generic portrait" },
      jurisdiction: "generic",
      documentType: "portrait",
      sourceNotes: { en: ["Unofficial document template."] },
    }),
    entry(
      {
        revisionId: "us-paper@1",
        id: "us-paper",
        label: { en: "US passport paper" },
        submissionChannel: "paper",
      },
      {
        revisionId: "us-paper@1",
        status: "reference_only",
        statusReason: "not verified by calibrated print tests",
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
    expect(await screen.findByRole("heading", { name: "Test template" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Generic portrait" })).toBeInTheDocument();
  });

  it("shows error and retries on failure", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/could not load the photo templates/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Test template" })).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("filters by jurisdiction chip", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Test template" });
    fireEvent.click(screen.getByRole("button", { name: "United States" }));
    expect(screen.queryByRole("heading", { name: "Generic portrait" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Test template" })).toBeInTheDocument();
  });

  it("marks non-official and reference_only templates", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Test template" });
    expect(screen.getByText("Non-document template")).toBeInTheDocument();
    expect(screen.getByText("Reference only")).toBeInTheDocument();
    expect(screen.getByText("not verified by calibrated print tests")).toBeInTheDocument();
  });

  it("only active templates are selectable", async () => {
    mockedFetch.mockResolvedValue(catalog);
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <TemplateStep onSelect={onSelect} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Test template" });
    const selectable = screen.getAllByRole("button", { name: "Select this template" });
    expect(selectable).toHaveLength(2);
    fireEvent.click(selectable[0]);
    expect(onSelect).toHaveBeenCalledOnce();
    const disabled = screen.getByRole("button", { name: "Not submittable" });
    expect(disabled).toBeDisabled();
  });

  it("keeps non-submittable templates out of the main list but still discloses them", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Test template" });

    // The collapsed group is closed by default, so the customer meets
    // selectable templates first instead of a wall of disabled buttons
    const group = screen.getByText(/not yet submittable/);
    const details = group.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");

    // Disclosure is preserved, not removed: the card and its reason are inside
    expect(details).toContainElement(screen.getByRole("button", { name: "Not submittable" }));
    expect(details).toContainElement(screen.getByText("not verified by calibrated print tests"));

    // The selectable cards are outside the collapsed group
    for (const button of screen.getAllByRole("button", { name: "Select this template" })) {
      expect(details).not.toContainElement(button);
    }
  });

  it("explains an all-unavailable filter result instead of showing dead ends only", async () => {
    mockedFetch.mockResolvedValue({
      ...catalog,
      templates: catalog.templates.filter((t) => t.publication.status !== "active"),
    });
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(
        /no template matching these filters can produce a submittable photo/i,
      ),
    ).toBeInTheDocument();
  });

  it("shows source requirement markers when the template demands them (P2)", async () => {
    mockedFetch.mockResolvedValue({
      ...catalog,
      templates: [
        ...catalog.templates,
        entry({
          revisionId: "pro@1",
          id: "pro",
          label: { en: "Professional capture required" },
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
    await screen.findByRole("heading", { name: "Professional capture required" });
    const card = screen
      .getByRole("heading", { name: "Professional capture required" })
      .closest("li.template-card") as HTMLElement;
    // The restriction phrase (TMP-002, ending in a period) and the
    // prerequisite constraint (continuing with the tool note) each appear once
    expect(within(card).getByText(/certified photographer is required\./i)).toBeInTheDocument();
    expect(within(card).getByText(/original camera file is required\./i)).toBeInTheDocument();
    expect(within(card).getByText(/re-encoded JPEG/)).toBeInTheDocument();
    expect(within(card).getByText(/not produce certified-photographer output/)).toBeInTheDocument();
  });

  it("hides requirement markers when all prerequisites are satisfied (P2)", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Test template" });
    expect(screen.queryByText(/certified photographer/i)).toBeNull();
    expect(screen.queryByText(/original camera file/i)).toBeNull();
  });

  it("discloses review date, source update time, notes and restrictions (P3)", async () => {
    // Old implementation: official templates showed no notes at all, the
    // dl had no review date/version, and sources had no update time
    mockedFetch.mockResolvedValue({
      ...catalog,
      templates: catalog.templates.map((t) =>
        t.revision.revisionId === "t@1"
          ? entry({
              revisionId: "t@1",
              sourceNotes: { en: ["note one", "note two"] },
              sources: [
                {
                  id: "s1",
                  url: "https://example.com/spec",
                  title: "Official specification",
                  authority: "Test authority",
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
    await screen.findByRole("heading", { name: "Test template" });
    const card = screen
      .getByRole("heading", { name: "Test template" })
      .closest("li.template-card") as HTMLElement;
    expect(within(card).getByText("2026-08-06")).toBeInTheDocument(); // review date for this project
    expect(within(card).getByText("updated 2026-01-01")).toBeInTheDocument();
    expect(within(card).getByText("accessed 2026-08-06")).toBeInTheDocument();
    expect(within(card).getByText("note one")).toBeInTheDocument();
    expect(within(card).getByText("note two")).toBeInTheDocument();
    expect(within(card).getByText(/forbids mirroring/i)).toBeInTheDocument(); // restriction phrase
    expect(within(card).getByText("Official sources")).toBeInTheDocument(); // official templates keep the original heading
  });

  it("links every card to its template detail page (P4)", async () => {
    mockedFetch.mockResolvedValue(catalog);
    render(
      <MemoryRouter>
        <TemplateStep onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Test template" });
    const links = screen.getAllByRole("link", { name: "View template details" });
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
    await screen.findByRole("heading", { name: "Test template" });
    const card = screen
      .getByRole("heading", { name: "US passport paper" })
      .closest("li.template-card") as HTMLElement;
    const reason = within(card).getByText("not verified by calibrated print tests");
    const details = card.querySelector(".template-card-details")!;
    // reason precedes details (the old implementation had it after the dl)
    const following = reason.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(following).toBeTruthy();
  });
});
