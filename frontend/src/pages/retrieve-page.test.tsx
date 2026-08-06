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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(downloadPhoto).mockResolvedValue(new Blob([new Uint8Array(10)]));
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:photo"),
    revokeObjectURL: vi.fn(),
  });
});

function typeKey(value: string) {
  fireEvent.change(screen.getByLabelText("取回码"), { target: { value } });
}

describe("RetrievePage", () => {
  it("normalizes the key while typing and shows it grouped", () => {
    render(<RetrievePage />);
    typeKey("a7c-2f9");
    expect(screen.getByLabelText("取回码")).toHaveValue("A7C 2F9");
  });

  it("keeps the retrieve button disabled until the key is complete", () => {
    render(<RetrievePage />);
    expect(screen.getByRole("button", { name: "取回" })).toBeDisabled();
    typeKey("A7C2F9");
    expect(screen.getByRole("button", { name: "取回" })).toBeEnabled();
  });

  it("sends the normalized key, not the displayed one", async () => {
    vi.mocked(resolvePhoto).mockResolvedValue(resolved());
    render(<RetrievePage />);
    typeKey("a7c 2f9");
    fireEvent.click(screen.getByRole("button", { name: "取回" }));
    await waitFor(() => expect(resolvePhoto).toHaveBeenCalledWith("A7C2F9"));
  });

  it("shows the photo summary returned by resolve", async () => {
    // 回归：resolve 的 width/height 恒为 null，取回页拿不到任何摘要
    vi.mocked(resolvePhoto).mockResolvedValue(resolved());
    render(<RetrievePage />);
    typeKey("A7C2F9");
    fireEvent.click(screen.getByRole("button", { name: "取回" }));

    expect(await screen.findByText("600×600")).toBeInTheDocument();
    expect(screen.getByText("50.0 KB")).toBeInTheDocument();
    expect(screen.getByText("us-visa-digital@1")).toBeInTheDocument();
  });

  it("associates the error message with the input", async () => {
    vi.mocked(resolvePhoto).mockRejectedValue(new ApiError("PHOTO_UNAVAILABLE", "gone", 404));
    render(<RetrievePage />);
    typeKey("A7C2F9");
    fireEvent.click(screen.getByRole("button", { name: "取回" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("照片不可用");
    const input = screen.getByLabelText("取回码");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("offers a delete entry point outside the staging page", async () => {
    // 回归：删除密钥一旦离开暂存页就永久失效，取回页没有任何删除入口
    vi.mocked(deletePhoto).mockResolvedValue(undefined);
    render(<RetrievePage />);
    typeKey("A7C2F9");
    fireEvent.change(screen.getByLabelText("删除密钥"), {
      target: { value: "secret-value-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "删除这张照片" }));
    // 删除不可逆，先确认再执行
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(deletePhoto).toHaveBeenCalledWith("A7C2F9", "secret-value-123456"));
    expect(await screen.findByRole("status")).toHaveTextContent("已提交删除");
  });

  it("requires both the key and the delete secret before deleting", () => {
    render(<RetrievePage />);
    expect(screen.getByRole("button", { name: "删除这张照片" })).toBeDisabled();
    typeKey("A7C2F9");
    expect(screen.getByRole("button", { name: "删除这张照片" })).toBeDisabled();
  });
});
