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
    // 同一会话复用：重试不能再建会话，否则幂等命名空间被换掉，服务端无从重放
    expect(createSaveSession).toHaveBeenCalledTimes(1);
  });

  it("recovers from an expired session with a new session and a fresh idempotency key", async () => {
    // 回归：会话过期（SESSION_REQUIRED）时沿用旧幂等键重发，命中的是已随旧会话
    // 消失的命名空间，服务端只会当作一次全新保存、多出一张无法删除的照片
    vi.mocked(savePhoto)
      .mockRejectedValueOnce(new ApiError("SESSION_REQUIRED", "需要先建立保存会话", 403))
      .mockResolvedValueOnce(saved);
    await openConfirm();

    fireEvent.click(screen.getByRole("button", { name: "确认并上传" }));
    await screen.findByText("A7C 2F9");

    expect(createSaveSession).toHaveBeenCalledTimes(2);
    expect(savePhoto).toHaveBeenCalledTimes(2);
    const firstKey = vi.mocked(savePhoto).mock.calls[0][3];
    const secondKey = vi.mocked(savePhoto).mock.calls[1][3];
    expect(secondKey).not.toBe(firstKey);
  });

  it("reports the staged receipt upward after a successful upload", async () => {
    // 回执的所有权在 CreatePage：面板必须把取回码、删除密钥与幂等键回传
    const onStaged = vi.fn();
    vi.mocked(savePhoto).mockResolvedValue(saved);
    await openConfirm(artifact(), { onStaged });

    fireEvent.click(screen.getByRole("button", { name: "确认并上传" }));
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

    fireEvent.click(screen.getByRole("button", { name: "确认并上传" }));
    await screen.findByText("A7C 2F9");
    fireEvent.click(screen.getByRole("button", { name: "删除照片" }));

    await waitFor(() => expect(onStaged).toHaveBeenCalledTimes(2));
    expect(onStaged.mock.calls[1][0]).toBeNull();
  });

  it("restores the done panel from a staged receipt and warns when stale", async () => {
    // 受控化：从 props 恢复 done 态，不再发第二次上传
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
    expect(screen.getByRole("button", { name: /下载回执/ })).toBeInTheDocument();
    // 回执对应的照片已改动：必须警告，且不再提供第二次暂存
    expect(screen.getByRole("alert")).toHaveTextContent(/尚未暂存/);
    expect(screen.queryByRole("button", { name: "暂存并生成取回码" })).toBeNull();
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

describe("删除失败", () => {
  it("keeps the key and delete secret visible instead of falling into the upload error state", async () => {
    // 回归：删除失败被并入上传用的 error 状态，done 面板连同取回码、删除密钥与
    // 回执一起消失，而 error 状态唯一的主按钮「用同一幂等键重试」执行的是
    // upload()——幂等键还在，服务端重放已完成的记录，用户拿到一个指向已删除
    // 照片的取回码。
    vi.mocked(savePhoto).mockResolvedValue(saved);
    vi.mocked(deletePhoto).mockRejectedValue(new Error("网络中断"));
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "确认并上传" }));
    await screen.findByText("A7C 2F9");

    fireEvent.click(screen.getByRole("button", { name: "删除照片" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("网络中断"));

    // 取回码与删除密钥仍在，删除可以直接重试
    expect(screen.getByText("A7C 2F9")).toBeInTheDocument();
    expect(screen.getByText(/secret-value-1234567890/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试删除" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "用同一幂等键重试" })).toBeNull();
  });

  it("retries the delete rather than the upload", async () => {
    vi.mocked(savePhoto).mockResolvedValue(saved);
    vi.mocked(deletePhoto)
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValueOnce(undefined);
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "确认并上传" }));
    await screen.findByText("A7C 2F9");

    fireEvent.click(screen.getByRole("button", { name: "删除照片" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "重试删除" }));

    await waitFor(() => expect(deletePhoto).toHaveBeenCalledTimes(2));
    expect(savePhoto).toHaveBeenCalledTimes(1);
  });
});
