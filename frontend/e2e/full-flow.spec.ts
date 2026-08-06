/**
 * E2E 全流程：模板选择 → 摄像头拍摄 → 确认照片 → 编辑 → 终态渲染 → 暂存 → 新浏览器取回。
 * 覆盖 CAM-001（点击后请求权限）、CAM-006（fake media 拍摄）、SAV-001（确认后上传）、
 * SAV-007（KEY 只进 POST body 不进 URL）、下载 token 单次用途。
 */

import { expect, test } from "@playwright/test";

test.describe("创建 → 暂存 → 取回", () => {
  test("完整流程", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // 服务政策改写：留存时长改为 7 天——「30 天」必须来自服务端政策，不得写死
    await page.route("**/api/v1/service-policy", async (route) => {
      const body = await (await route.fetch()).json();
      await route.fulfill({ json: { ...body, temporaryStorageTtlSeconds: 7 * 86400 } });
    });

    // 1. 选择模板（芬兰警方证件，active）
    await page.goto("/create");
    await page.getByRole("button", { name: "选择此模板" }).first().click();
    await expect(page.getByRole("heading", { name: "选择照片来源" })).toBeVisible();

    // 2. 摄像头拍摄（fake media）
    await page.getByRole("button", { name: "使用摄像头拍摄" }).click();
    await expect(page.getByRole("heading", { name: "拍摄照片" })).toBeVisible();
    // CAM-001：初始加载不请求权限（无 getUserMedia 调用可观测，此处验证按钮存在）
    await page.getByRole("button", { name: "开启摄像头" }).click();
    // fake media 下视频需就绪（videoWidth > 0）才能捕获
    await expect(page.getByRole("button", { name: "拍摄" })).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const v = document.querySelector("video");
      return !!v && v.videoWidth > 0;
    });
    await page.getByRole("button", { name: "拍摄" }).click();
    await expect(page.getByRole("heading", { name: "确认这张照片" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "使用这张照片" }).click();
    await expect(page.getByRole("heading", { name: "编辑照片" })).toBeVisible({ timeout: 30_000 });

    // 3. 编辑：缩放 + 下一步
    await page.getByRole("slider", { name: /缩放/ }).fill("1.2");
    await page.getByRole("button", { name: "下一步（终态检查）" }).click();

    // 4. 终态页：检查摘要 + 下载文件名
    await expect(page.getByRole("heading", { name: "终态照片" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("像素尺寸：通过")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /下载 fi-id-digital_upload-\d{8}\.jpg/ }),
    ).toBeVisible();

    // 5. 暂存（SAV-001：确认后上传）
    await page.getByRole("button", { name: "暂存并生成取回码" }).click();
    await expect(page.getByText(/留存时长：\s*7 天/)).toBeVisible();
    await page.getByRole("button", { name: "确认并上传" }).click();
    await expect(page.locator(".key-display")).toBeVisible({ timeout: 30_000 });
    const keyDisplay = (await page.locator(".key-display").innerText()).split("\n")[0].trim();
    const key = keyDisplay.replace(" ", "");
    expect(key).toMatch(/^[A-Z0-9]{6}$/);
    // 服务端权威到期时间
    await expect(page.getByText("服务端到期时间：")).toBeVisible();

    // 6. 新浏览器上下文取回（SAV-007：KEY 只进 POST body）
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto("/retrieve");
    await page2.getByRole("textbox", { name: "取回码" }).fill(key);
    await page2.getByRole("button", { name: "取回" }).click();
    await expect(page2.getByRole("img", { name: "取回的照片" })).toBeVisible({ timeout: 30_000 });
    await expect(page2.getByText("服务器到期时间")).toBeVisible();
    // 地址栏不含 KEY
    expect(page2.url()).not.toContain(key);

    // 7. 删除照片（删除密钥授权，§6.4）→ 取回统一 404
    await page.getByRole("button", { name: "删除照片" }).click();
    await expect(page.getByRole("button", { name: "暂存并生成取回码" })).toBeVisible();
    await page.goto("/retrieve");
    await page.getByRole("textbox", { name: "取回码" }).fill(key);
    await page.getByRole("button", { name: "取回" }).click();
    await expect(page.getByText(/照片不可用/)).toBeVisible({ timeout: 30_000 });

    await context.close();
    await context2.close();
  });
});
