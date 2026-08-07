import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { ApiError, createSaveSession, deletePhoto, savePhoto } from "../api/save";
import { fetchServicePolicy } from "../api/service-policy";
import type { FinalArtifact } from "./final-artifact";
import type { TemplateEntry } from "../lib/templates/types";
import { StagingPanel, type StagingPanelProps } from "./staging-panel";

const template = {
  revision: { id: "us", version: 1 },
} as unknown as TemplateEntry;

function artifact(id = "a1"): FinalArtifact {
  return {
    artifactId: id,
    blob: new Blob([new Uint8Array(64)], { type: "image/jpeg" }),
    coverage: { scannedPixels: 100, transparentPixels: 0 },
    manifest: {
      schemaVersion: 1,
      templateId: "us",
      templateVersion: 1,
      widthPx: 600,
      heightPx: 600,
      mime: "image/jpeg",
      orientationNormalized: true,
      matrix: [1, 0, 0, 1, 0, 0],
      flipX: false,
    },
  };
}

const saved = {
  key: "A7C2F9",
  keyDisplay: "A7C 2F9",
  deleteSecret: "secret-value-1234567890",
  expiresAt: "2026-09-05T10:00:00Z",
  template: { id: "us", version: 1 },
  photo: { width: 600, height: 600, mime: "image/jpeg" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchServicePolicy).mockResolvedValue({
    temporaryStorageTtlSeconds: 2592000,
    retrievalMode: "key_only_ephemeral",
    maxUploadBytes: 15728640,
    policyVersion: 1,
  });
  vi.mocked(createSaveSession).mockResolvedValue(undefined);
});

async function openConfirm(
  entry = artifact(),
  overrides: Partial<Pick<StagingPanelProps, "staged" | "stagedStale" | "onStaged">> = {},
) {
  render(
    <StagingPanel
      artifact={entry}
      template={template}
      staged={overrides.staged ?? null}
      stagedStale={overrides.stagedStale ?? false}
      onStaged={overrides.onStaged ?? vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Stage and generate retrieval code" }));
  // The policy copy comes from the server; wait for it to land
  await screen.findByText(/30 days/i);
}

describe("StagingPanel", () => {
  it("states purpose and retention from the server policy before uploading", async () => {
    await openConfirm();
    expect(
      screen.getByText(/used only to retrieve this photo with the retrieval code/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/retrieval by retrieval code only/i)).toBeInTheDocument();
  });

  it("reuses the same idempotency key when a failed upload is retried", async () => {
    // Regression: every click used to mint a new idempotency key, making
    // SPEC §11's "same idempotency key retry" impossible at the UI level
    vi.mocked(savePhoto).mockRejectedValueOnce(new Error("network down"));
    vi.mocked(savePhoto).mockResolvedValueOnce(saved);
    await openConfirm();

    fireEvent.click(screen.getByRole("button", { name: "Confirm and upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("network down");

    fireEvent.click(screen.getByRole("button", { name: "Retry with the same idempotency key" }));
    await screen.findByText("A7C 2F9");

    expect(savePhoto).toHaveBeenCalledTimes(2);
    const firstKey = vi.mocked(savePhoto).mock.calls[0][3];
    const secondKey = vi.mocked(savePhoto).mock.calls[1][3];
    expect(secondKey).toBe(firstKey);
    // Same-session reuse: a retry must not create another session, or the
    // idempotency namespace changes and the server cannot replay
    expect(createSaveSession).toHaveBeenCalledTimes(1);
  });

  it("recovers from an expired session with a new session and a fresh idempotency key", async () => {
    // Regression: on session expiry (SESSION_REQUIRED), resending with the
    // old idempotency key hits a namespace gone with the old session; the
    // server treats it as a brand-new save and leaves a photo that can never
    // be deleted
    vi.mocked(savePhoto)
      .mockRejectedValueOnce(
        new ApiError("SESSION_REQUIRED", "a save session must be established first", 403),
      )
      .mockResolvedValueOnce(saved);
    await openConfirm();

    fireEvent.click(screen.getByRole("button", { name: "Confirm and upload" }));
    await screen.findByText("A7C 2F9");

    expect(createSaveSession).toHaveBeenCalledTimes(2);
    expect(savePhoto).toHaveBeenCalledTimes(2);
    const firstKey = vi.mocked(savePhoto).mock.calls[0][3];
    const secondKey = vi.mocked(savePhoto).mock.calls[1][3];
    expect(secondKey).not.toBe(firstKey);
  });

  it("reports the staged receipt upward after a successful upload", async () => {
    // The receipt belongs to CreatePage: the panel must report the
    // retrieval code, delete secret, and idempotency key back
    const onStaged = vi.fn();
    vi.mocked(savePhoto).mockResolvedValue(saved);
    await openConfirm(artifact(), { onStaged });

    fireEvent.click(screen.getByRole("button", { name: "Confirm and upload" }));
    await screen.findByText("A7C 2F9");

    expect(onStaged).toHaveBeenCalledTimes(1);
    const receipt = onStaged.mock.calls[0][0];
    expect(receipt.saved).toEqual(saved);
    expect(receipt.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("clears the staged receipt after a successful delete", async () => {
    const onStaged = vi.fn();
    vi.mocked(savePhoto).mockResolvedValue(saved);
    vi.mocked(deletePhoto).mockResolvedValue(undefined);
    await openConfirm(artifact(), { onStaged });

    fireEvent.click(screen.getByRole("button", { name: "Confirm and upload" }));
    await screen.findByText("A7C 2F9");
    fireEvent.click(screen.getByRole("button", { name: "Delete photo" }));

    await waitFor(() => expect(onStaged).toHaveBeenCalledTimes(2));
    expect(onStaged.mock.calls[1][0]).toBeNull();
  });

  it("restores the done panel from a staged receipt and warns when stale", async () => {
    // Controlled: restore the done state from props without a second upload
    render(
      <StagingPanel
        artifact={artifact()}
        template={template}
        staged={{ saved, idempotencyKey: "restored-key" }}
        stagedStale={true}
        onStaged={vi.fn()}
      />,
    );
    expect(screen.getByText("A7C 2F9")).toBeInTheDocument();
    expect(screen.getByText(/secret-value-1234567890/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download receipt/i })).toBeInTheDocument();
    // The receipt's photo has changed: must warn and offer no second staging
    expect(screen.getByRole("alert")).toHaveTextContent(/not staged/i);
    expect(screen.queryByRole("button", { name: "Stage and generate retrieval code" })).toBeNull();
  });

  it("is not a dead end after a failed upload", async () => {
    vi.mocked(savePhoto).mockRejectedValue(new Error("network down"));
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and upload" }));
    await screen.findByRole("alert");

    expect(
      screen.getByRole("button", { name: "Retry with the same idempotency key" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("shows the key, delete secret and authoritative expiry after saving", async () => {
    vi.mocked(savePhoto).mockResolvedValue(saved);
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and upload" }));

    expect(await screen.findByText("A7C 2F9")).toBeInTheDocument();
    expect(screen.getByText(/secret-value-1234567890/)).toBeInTheDocument();
    expect(screen.getByText(/authoritative/)).toBeInTheDocument();
  });

  it("offers a downloadable receipt so the delete secret survives a refresh", async () => {
    // Regression: the delete secret used to live only on screen; a refresh
    // permanently lost the delete right
    vi.mocked(savePhoto).mockResolvedValue(saved);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:receipt"),
      revokeObjectURL: vi.fn(),
    });
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and upload" }));
    await screen.findByText("A7C 2F9");

    fireEvent.click(screen.getByRole("button", { name: /download receipt/i }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("delete failure", () => {
  it("keeps the key and delete secret visible instead of falling into the upload error state", async () => {
    // Regression: a delete failure used to fall into the upload error
    // state, taking the done panel - with retrieval code, delete secret, and
    // receipt - away, while that state's only primary button
    // "Retry with the same idempotency key" runs upload(): the key is still
    // there, the server replays the completed record, and the user gets a
    // retrieval code pointing at a deleted photo.
    vi.mocked(savePhoto).mockResolvedValue(saved);
    vi.mocked(deletePhoto).mockRejectedValue(new Error("network down"));
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and upload" }));
    await screen.findByText("A7C 2F9");

    fireEvent.click(screen.getByRole("button", { name: "Delete photo" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("network down"));

    // The retrieval code and delete secret are still there; delete can be
    // retried directly
    expect(screen.getByText("A7C 2F9")).toBeInTheDocument();
    expect(screen.getByText(/secret-value-1234567890/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry delete" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry with the same idempotency key" }),
    ).toBeNull();
  });

  it("retries the delete rather than the upload", async () => {
    vi.mocked(savePhoto).mockResolvedValue(saved);
    vi.mocked(deletePhoto)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(undefined);
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and upload" }));
    await screen.findByText("A7C 2F9");

    fireEvent.click(screen.getByRole("button", { name: "Delete photo" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry delete" }));

    await waitFor(() => expect(deletePhoto).toHaveBeenCalledTimes(2));
    expect(savePhoto).toHaveBeenCalledTimes(1);
  });
});
