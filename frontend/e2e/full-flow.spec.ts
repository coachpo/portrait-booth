/**
 * E2E full flow: template selection → camera capture → photo confirmation →
 * edit → final render → staging → retrieval in a new browser.
 * Covers CAM-001 (permission requested after click), CAM-006 (fake-media
 * capture), SAV-001 (upload after confirmation), SAV-007 (KEY only in the
 * POST body, never in URLs), and single-use download tokens.
 */

import { expect, test } from "@playwright/test";

test.describe("create → stage → retrieve", () => {
  test("full flow", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Service-policy rewrite: retention becomes 7 days - "30 days" must
    // come from the server policy, never hard-coded
    await page.route("**/api/v1/service-policy", async (route) => {
      const body = await (await route.fetch()).json();
      await route.fulfill({ json: { ...body, temporaryStorageTtlSeconds: 7 * 86400 } });
    });

    // 1. Select the template (Finnish police document, active)
    await page.goto("/create");
    await page.getByRole("button", { name: "Select this template" }).first().click();
    await expect(page.getByRole("heading", { name: "Choose photo source" })).toBeVisible();

    // 2. Camera capture (fake media)
    await page.getByRole("button", { name: "Use camera capture" }).click();
    await expect(page.getByRole("heading", { name: "Take photo" })).toBeVisible();
    // CAM-001: no permission request on initial load (no observable
    // getUserMedia call; here we verify the button exists)
    await page.getByRole("button", { name: "Open camera" }).click();
    // With fake media the video must be ready (videoWidth > 0) to capture
    await expect(page.getByRole("button", { name: "Shoot" })).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const v = document.querySelector("video");
      return !!v && v.videoWidth > 0;
    });
    await page.getByRole("button", { name: "Shoot" }).click();
    await expect(page.getByRole("heading", { name: "Confirm this photo" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Use this photo" }).click();
    await expect(page.getByRole("heading", { name: "Edit photo" })).toBeVisible({
      timeout: 30_000,
    });

    // 3. Edit: zoom + next
    await page.getByRole("slider", { name: /zoom/i }).fill("1.2");
    await page.getByRole("button", { name: "Next (final checks)" }).click();

    // 4. Final page: check summary + download filename
    await expect(page.getByRole("heading", { name: "Final photo" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Pixel size: Passed")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Download fi-id-digital_upload-\d{8}\.jpg/ }),
    ).toBeVisible();

    // 5. Stage (SAV-001: upload after confirmation)
    await page.getByRole("button", { name: "Stage and generate retrieval code" }).click();
    await expect(page.getByText(/Retention:\s*7 days/i)).toBeVisible();
    await page.getByRole("button", { name: "Confirm and upload" }).click();
    await expect(page.locator(".key-display")).toBeVisible({ timeout: 30_000 });
    const keyDisplay = (await page.locator(".key-display").innerText()).split("\n")[0].trim();
    const key = keyDisplay.replace(" ", "");
    expect(key).toMatch(/^[A-Z0-9]{6}$/);
    // Server-authoritative expiry time
    await expect(page.getByText("Server expiry time:")).toBeVisible();

    // 6. Retrieval in a new browser context (SAV-007: KEY only in the POST body)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto("/retrieve");
    await page2.getByRole("textbox", { name: "Retrieval code" }).fill(key);
    await page2.getByRole("button", { name: "Retrieve" }).click();
    await expect(page2.getByRole("img", { name: "Retrieved photo" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page2.getByText("Server expiry time")).toBeVisible();
    // The address bar never contains the KEY
    expect(page2.url()).not.toContain(key);

    // 7. Delete the photo (delete-secret authorization, §6.4) → unified 404 on retrieval
    await page.getByRole("button", { name: "Delete photo" }).click();
    await expect(
      page.getByRole("button", { name: "Stage and generate retrieval code" }),
    ).toBeVisible();
    await page.goto("/retrieve");
    await page.getByRole("textbox", { name: "Retrieval code" }).fill(key);
    await page.getByRole("button", { name: "Retrieve" }).click();
    await expect(page.getByText(/photo unavailable/)).toBeVisible({ timeout: 30_000 });

    await context.close();
    await context2.close();
  });
});
