import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/save", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/save")>();
  return {
    ...actual,
    resolvePhoto: vi.fn(),
    downloadPhoto: vi.fn(),
    deletePhoto: vi.fn(),
  };
});

import { ApiError, deletePhoto, downloadPhoto, resolvePhoto } from "../api/save";
import { RetrievePage } from "./retrieve-page";

function resolved() {
  return {
    photo: {
      width: 600,
      height: 600,
      mime: "image/jpeg",
      byteLength: 51200,
      expiresAt: "2026-09-05T10:00:00Z",
    },
    template: { id: "us-visa-digital", version: 1 },
    downloadToken: "tok",
    tokenExpiresAt: "2026-08-06T10:01:00Z",
  };
}

let createdUrls: string[] = [];
let revokedUrls: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(downloadPhoto).mockResolvedValue(new Blob([new Uint8Array(10)]));
  createdUrls = [];
  revokedUrls = [];
  let counter = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => {
      counter += 1;
      const url = `blob:photo-${counter}`;
      createdUrls.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revokedUrls.push(url);
    }),
  });
});

function typeKey(value: string) {
  fireEvent.change(screen.getByLabelText("Retrieval code"), { target: { value } });
}

describe("RetrievePage", () => {
  it("normalizes the key while typing and shows it grouped", () => {
    render(<RetrievePage />);
    typeKey("a7c-2f9");
    expect(screen.getByLabelText("Retrieval code")).toHaveValue("A7C 2F9");
  });

  it("keeps the retrieve button disabled until the key is complete", () => {
    render(<RetrievePage />);
    expect(screen.getByRole("button", { name: "Retrieve" })).toBeDisabled();
    typeKey("A7C2F9");
    expect(screen.getByRole("button", { name: "Retrieve" })).toBeEnabled();
  });

  it("sends the normalized key, not the displayed one", async () => {
    vi.mocked(resolvePhoto).mockResolvedValue(resolved());
    render(<RetrievePage />);
    typeKey("a7c 2f9");
    fireEvent.click(screen.getByRole("button", { name: "Retrieve" }));
    await waitFor(() => expect(resolvePhoto).toHaveBeenCalledWith("A7C2F9"));
  });

  it("shows the photo summary returned by resolve", async () => {
    // Regression: resolve's width/height used to be always null, so the
    // retrieve page got no summary at all
    vi.mocked(resolvePhoto).mockResolvedValue(resolved());
    render(<RetrievePage />);
    typeKey("A7C2F9");
    fireEvent.click(screen.getByRole("button", { name: "Retrieve" }));

    expect(await screen.findByText("600×600")).toBeInTheDocument();
    expect(screen.getByText("50.0 KB")).toBeInTheDocument();
    expect(screen.getByText("us-visa-digital@1")).toBeInTheDocument();
  });

  it("associates the error message with the input", async () => {
    vi.mocked(resolvePhoto).mockRejectedValue(new ApiError("PHOTO_UNAVAILABLE", "gone", 404));
    render(<RetrievePage />);
    typeKey("A7C2F9");
    fireEvent.click(screen.getByRole("button", { name: "Retrieve" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("photo unavailable");
    const input = screen.getByLabelText("Retrieval code");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("revokes the previous preview when a second photo is resolved", async () => {
    // Regression: blob URLs were never revoked, so each retrieval in one
    // session added more photo bytes resident in memory
    vi.mocked(resolvePhoto).mockResolvedValue(resolved());
    render(<RetrievePage />);

    typeKey("A7C2F9");
    fireEvent.click(screen.getByRole("button", { name: "Retrieve" }));
    await screen.findByText("600×600");

    typeKey("B8D3G1");
    fireEvent.click(screen.getByRole("button", { name: "Retrieve" }));
    await waitFor(() => expect(revokedUrls).toContain("blob:photo-1"));
    // The currently shown one must not be revoked, or the preview breaks
    expect(revokedUrls).not.toContain("blob:photo-2");
  });

  it("revokes the preview after a successful delete", async () => {
    vi.mocked(resolvePhoto).mockResolvedValue(resolved());
    vi.mocked(deletePhoto).mockResolvedValue(undefined);
    render(<RetrievePage />);

    typeKey("A7C2F9");
    fireEvent.click(screen.getByRole("button", { name: "Retrieve" }));
    await screen.findByText("600×600");

    fireEvent.change(screen.getByLabelText("Delete secret"), {
      target: { value: "secret-value-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete this photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByRole("status");

    await waitFor(() => expect(revokedUrls).toContain("blob:photo-1"));
  });

  it("revokes the preview when the page unmounts", async () => {
    vi.mocked(resolvePhoto).mockResolvedValue(resolved());
    const { unmount } = render(<RetrievePage />);

    typeKey("A7C2F9");
    fireEvent.click(screen.getByRole("button", { name: "Retrieve" }));
    await screen.findByText("600×600");

    unmount();
    // Every created URL is revoked; nothing lingers
    await waitFor(() => expect(revokedUrls).toEqual(createdUrls));
  });

  it("offers a delete entry point outside the staging page", async () => {
    // Regression: the delete secret used to be permanently useless once
    // leaving the staging page; the retrieve page had no delete entry
    vi.mocked(deletePhoto).mockResolvedValue(undefined);
    render(<RetrievePage />);
    typeKey("A7C2F9");
    fireEvent.change(screen.getByLabelText("Delete secret"), {
      target: { value: "secret-value-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete this photo" }));
    // Deletion is irreversible; confirm before executing
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(deletePhoto).toHaveBeenCalledWith("A7C2F9", "secret-value-123456"));
    expect(await screen.findByRole("status")).toHaveTextContent("Delete submitted");
  });

  it("requires both the key and the delete secret before deleting", () => {
    render(<RetrievePage />);
    expect(screen.getByRole("button", { name: "Delete this photo" })).toBeDisabled();
    typeKey("A7C2F9");
    expect(screen.getByRole("button", { name: "Delete this photo" })).toBeDisabled();
  });
});

describe("a second delete within the same session", () => {
  it("resets the delete form when another key is resolved", async () => {
    // Regression: deleteStage had no reset path after done and resolve() did
    // not reset it either - retrieving a second photo in the same session
    // left the delete form stuck at "delete submitted" with no inputs or
    // buttons rendered, so the second photo could not be deleted without a
    // full refresh.
    vi.mocked(deletePhoto).mockResolvedValue(undefined);
    vi.mocked(resolvePhoto).mockResolvedValue(resolved());
    render(<RetrievePage />);

    typeKey("A7C2F9");
    fireEvent.change(screen.getByLabelText("Delete secret"), {
      target: { value: "secret-value-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete this photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByRole("status");

    // Retrieve another photo
    typeKey("B8D3G1");
    fireEvent.click(screen.getByRole("button", { name: "Retrieve" }));
    await screen.findByText("600×600");

    expect(screen.getByLabelText("Delete secret")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete this photo" })).toBeInTheDocument();
  });
});
