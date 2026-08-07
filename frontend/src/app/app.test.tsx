import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearServicePolicyCache } from "../api/service-policy";
import { clearTemplateCatalogCache } from "../lib/templates/catalog";
import { routes } from "./App";
import { ErrorBoundary } from "./error-boundary";

vi.mock("../create/create-page", () => ({ CreatePage: () => <p>create flow placeholder</p> }));
vi.mock("../pages/retrieve-page", () => ({ RetrievePage: () => <p>retrieve flow placeholder</p> }));
vi.mock("../pages/template-detail-page", () => ({
  TemplateDetailPage: () => <p>template detail placeholder</p>,
}));

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  clearServicePolicyCache();
  clearTemplateCatalogCache();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          temporaryStorageTtlSeconds: 2592000,
          retrievalMode: "key_only_ephemeral",
          maxUploadBytes: 15728640,
          policyVersion: 1,
        }),
    }),
  );
});

describe("App shell", () => {
  it("renders the home page with both entry points", () => {
    renderAt("/");
    expect(screen.getByRole("heading", { name: "Portrait Booth", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start creating" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enter retrieval code" })).toBeInTheDocument();
  });

  it("shows global navigation on every page", () => {
    // Regression: inner pages used to have no way back home
    for (const path of ["/", "/create", "/retrieve", "/privacy"]) {
      const { unmount } = renderAt(path);
      expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Portrait Booth" })).toBeInTheDocument();
      unmount();
    }
  });

  it("falls back to a 404 page instead of a blank screen", () => {
    renderAt("/no-such-page");
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("/no-such-page", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to home" })).toBeInTheDocument();
  });

  it("renders the template detail page for /templates/:revisionId (P4)", () => {
    // Regression: this path used to hit the * fallback route and render NotFoundPage
    renderAt("/templates/fi-police-digital@1");
    expect(screen.getByText("template detail placeholder")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Page not found" })).toBeNull();
  });

  it("renders the privacy page from server policy, not hard-coded numbers", async () => {
    renderAt("/privacy");
    expect(
      await screen.findByText("30 days (auto-deleted on expiry; no renewal offered)"),
    ).toBeInTheDocument();
    expect(screen.getByText(/retrieval by retrieval code only/i)).toBeInTheDocument();
    expect(screen.getByText("15 MB")).toBeInTheDocument();
  });

  it("offers a retry when the service policy cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    renderAt("/privacy");
    expect(await screen.findByRole("alert")).toHaveTextContent("unable to load the service policy");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("ErrorBoundary", () => {
  function Boom(): never {
    throw new Error("render exploded");
  }

  it("shows a recoverable message instead of a white screen", () => {
    // React logs render errors to console.error; keep it out of the output
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByText(/render exploded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
  });
});
