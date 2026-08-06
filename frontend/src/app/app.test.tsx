import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearServicePolicyCache } from "../api/service-policy";
import { App } from "./App";
import { ErrorBoundary } from "./error-boundary";

vi.mock("../create/create-page", () => ({ CreatePage: () => <p>创建流程占位</p> }));
vi.mock("../pages/retrieve-page", () => ({ RetrievePage: () => <p>取回流程占位</p> }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearServicePolicyCache();
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
    expect(screen.getByRole("link", { name: "开始创建" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "输入取回码" })).toBeInTheDocument();
  });

  it("shows global navigation on every page", () => {
    // 回归：内页曾没有任何回首页的出口
    for (const path of ["/", "/create", "/retrieve", "/privacy"]) {
      const { unmount } = renderAt(path);
      expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Portrait Booth" })).toBeInTheDocument();
      unmount();
    }
  });

  it("falls back to a 404 page instead of a blank screen", () => {
    renderAt("/no-such-page");
    expect(screen.getByRole("heading", { name: "页面不存在" })).toBeInTheDocument();
    expect(screen.getByText("/no-such-page", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回到首页" })).toBeInTheDocument();
  });

  it("renders the privacy page from server policy, not hard-coded numbers", async () => {
    renderAt("/privacy");
    expect(await screen.findByText("30 天（到期自动删除，不提供续期）")).toBeInTheDocument();
    expect(screen.getByText(/仅凭取回码取回/)).toBeInTheDocument();
    expect(screen.getByText("15 MB")).toBeInTheDocument();
  });

  it("offers a retry when the service policy cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    renderAt("/privacy");
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取服务政策");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("ErrorBoundary", () => {
  function Boom(): never {
    throw new Error("渲染炸了");
  }

  it("shows a recoverable message instead of a white screen", () => {
    // React 会把渲染错误打到 console.error，这里不需要它污染输出
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("页面出错了");
    expect(screen.getByText(/渲染炸了/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>一切正常</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("一切正常")).toBeInTheDocument();
  });
});
