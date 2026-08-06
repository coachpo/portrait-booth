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

import { createSaveSession, savePhoto } from "../api/save";
import { fetchServicePolicy } from "../api/service-policy";
import type { FinalArtifact } from "./final-artifact";
import type { TemplateEntry } from "../lib/templates/types";
import { StagingPanel } from "./staging-panel";

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

async function openConfirm(entry = artifact()) {
  render(<StagingPanel artifact={entry} template={template} />);
  fireEvent.click(screen.getByRole("button", { name: "暂存并生成取回码" }));
  // 政策文案来自服务端，等它落地再继续
  await screen.findByText(/30 天/);
}

describe("StagingPanel", () => {
  it("states purpose and retention from the server policy before uploading", async () => {
    await openConfirm();
    expect(screen.getByText(/仅用于凭取回码取回这张照片/)).toBeInTheDocument();
    expect(screen.getByText(/仅凭取回码取回/)).toBeInTheDocument();
  });

  it("reuses the same idempotency key when a failed upload is retried", async () => {
    // 回归：每次点击都新建幂等键，SPEC §11 的「同一幂等键重试」在 UI 上不可能发生
    vi.mocked(savePhoto).mockRejectedValueOnce(new Error("网络中断"));
    vi.mocked(savePhoto).mockResolvedValueOnce(saved);
    await openConfirm();

    fireEvent.click(screen.getByRole("button", { name: "确认并上传" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网络中断");

    fireEvent.click(screen.getByRole("button", { name: "用同一幂等键重试" }));
    await screen.findByText("A7C 2F9");

    expect(savePhoto).toHaveBeenCalledTimes(2);
    const firstKey = vi.mocked(savePhoto).mock.calls[0][3];
    const secondKey = vi.mocked(savePhoto).mock.calls[1][3];
    expect(secondKey).toBe(firstKey);
  });

  it("is not a dead end after a failed upload", async () => {
    vi.mocked(savePhoto).mockRejectedValue(new Error("网络中断"));
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "确认并上传" }));
    await screen.findByRole("alert");

    expect(screen.getByRole("button", { name: "用同一幂等键重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  });

  it("shows the key, delete secret and authoritative expiry after saving", async () => {
    vi.mocked(savePhoto).mockResolvedValue(saved);
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "确认并上传" }));

    expect(await screen.findByText("A7C 2F9")).toBeInTheDocument();
    expect(screen.getByText(/secret-value-1234567890/)).toBeInTheDocument();
    expect(screen.getByText(/权威时间/)).toBeInTheDocument();
  });

  it("offers a downloadable receipt so the delete secret survives a refresh", async () => {
    // 回归：删除密钥只在页面上显示，刷新即永久失去删除权
    vi.mocked(savePhoto).mockResolvedValue(saved);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:receipt"),
      revokeObjectURL: vi.fn(),
    });
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "确认并上传" }));
    await screen.findByText("A7C 2F9");

    fireEvent.click(screen.getByRole("button", { name: /下载回执/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});
