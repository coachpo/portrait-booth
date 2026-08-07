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
      label: { en: "Rich template" },
      jurisdiction: "US",
      documentType: "passport",
      submissionChannel: "digital_upload",
      applicantClass: "adult",
      sources: [
        {
          id: "a",
          url: "https://a.example/spec",
          title: "Source A spec",
          authority: "Authority A",
          accessedAt: "2026-08-01",
          sourceUpdatedAt: "2026-01-01",
        },
        {
          id: "b",
          url: "https://b.example/spec",
          title: "Source B spec",
          authority: "Authority B",
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
      sourceNotes: { en: ["note one", "note two", "note three"] },
      ...overrides,
    },
    contentHash: "abc123",
    publication: {
      revisionId: "rich@1",
      status: "active",
      statusReason: "reviewed and approved; safe to use",
      owner: "content maintainer",
      reviewer: "content reviewer",
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
    expect(await screen.findByRole("heading", { name: "Rich template" })).toBeInTheDocument();
    expect(screen.getByText("note two")).toBeInTheDocument();
    expect(screen.getByText("note three")).toBeInTheDocument();
  });

  it("renders a readable value for an expected:false capture rule (P4)", async () => {
    renderDetail([entry()]);
    await screen.findByRole("heading", { name: "Rich template" });
    expect(screen.getByText(/must not hold/)).toBeInTheDocument();
  });

  it("discloses source update times, accessed times and links (P4)", async () => {
    renderDetail([entry()]);
    await screen.findByRole("heading", { name: "Rich template" });
    expect(screen.getByText("Accessed 2026-08-01")).toBeInTheDocument();
    expect(screen.getByText("Accessed 2026-08-02")).toBeInTheDocument();
    expect(screen.getByText(/Officially updated 2026-01-01/)).toBeInTheDocument();
    // A source missing sourceUpdatedAt shows explicit wording, not an empty string
    const missing = screen.getByText("Official update time not provided");
    expect(missing).toBeInTheDocument();
    const linkB = screen.getByRole("link", { name: /Source B spec/ });
    expect(linkB.getAttribute("href")).toBe("https://b.example/spec");
    expect(linkB.getAttribute("rel")).toContain("noopener");
  });

  it("shows governance dates and statusReason for active and reference_only (P4)", async () => {
    renderDetail(
      [
        entry(),
        entry(
          { revisionId: "ref@1" },
          {
            revisionId: "ref@1",
            status: "reference_only",
            statusReason: "not verified by calibrated print tests",
          },
        ),
      ],
      "/templates/ref@1",
    );
    await screen.findByRole("heading", { name: "Rich template" });
    expect(screen.getAllByText("2026-08-06").length).toBeGreaterThan(0); // verifiedAt
    expect(screen.getByText("2026-11-04")).toBeInTheDocument(); // reviewDueAt
    expect(screen.getByText("not verified by calibrated print tests")).toBeInTheDocument();
  });

  it("renders all eight capability fields with distinct boolean wording (P4)", async () => {
    renderDetail([entry()]);
    await screen.findByRole("heading", { name: "Rich template" });
    const liText = (text: string) =>
      screen.getByText((_, el) => el?.tagName === "LI" && el?.textContent?.includes(text));
    expect(liText("Self-capture: Allowed")).toBeInTheDocument();
    expect(liText("Adjust composition: Warning")).toBeInTheDocument();
    expect(liText("Rotation: Forbidden")).toBeInTheDocument();
    expect(liText("Mirroring: Warning")).toBeInTheDocument();
    expect(liText("Retouching: Forbidden")).toBeInTheDocument();
    expect(liText("Background replacement: Allowed")).toBeInTheDocument();
    expect(liText("Original camera file: Required")).toBeInTheDocument();
    expect(liText("Certified photographer: Not required")).toBeInTheDocument();
  });

  it("never claims submittability for reference_only templates (P4)", async () => {
    renderDetail(
      [
        entry(
          { revisionId: "ref@1" },
          {
            revisionId: "ref@1",
            status: "reference_only",
            statusReason: "not verified by calibrated print tests",
          },
        ),
      ],
      "/templates/ref@1",
    );
    await screen.findByRole("heading", { name: "Rich template" });
    expect(screen.getByText("not verified by calibrated print tests")).toBeInTheDocument();
    expect(screen.queryByText(/submittable/i)).toBeNull();
    expect(screen.queryByText(/compliant/i)).toBeNull();
    expect(screen.queryByText(/meets official requirements/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /create with this template/i })).toBeNull();
  });

  it("marks non-official templates and shows empty-rule wording (P4)", async () => {
    renderDetail(
      [
        entry({
          revisionId: "portrait@1",
          id: "portrait",
          label: { en: "Generic portrait" },
          documentType: "portrait",
          cropRules: [],
          captureRules: [],
        }),
      ],
      "/templates/portrait@1",
    );
    await screen.findByRole("heading", { name: "Generic portrait" });
    expect(screen.getByText("Non-document template")).toBeInTheDocument();
    expect(screen.getByText("This template declares no crop rules.")).toBeInTheDocument();
    expect(screen.getByText("This template declares no capture rules.")).toBeInTheDocument();
  });

  it("shows a clear missing state for unknown revision ids (P4)", async () => {
    renderDetail([entry()], "/templates/nope@9");
    expect(await screen.findByText("Template not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to template list" })).toBeInTheDocument();
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
    expect(alert).toHaveTextContent("Template catalog failed to load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Rich template" })).toBeInTheDocument();
    expect(fetchTemplateCatalog).toHaveBeenCalledTimes(2);
  });
});
