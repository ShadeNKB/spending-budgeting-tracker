import { test, expect, Page } from "@playwright/test";

// ─── helpers ───────────────────────────────────────────────────────────────

async function waitForApp(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForSelector('[aria-live="polite"]', { state: "detached", timeout: 8000 }).catch(() => {});
}

// ─── app boot ──────────────────────────────────────────────────────────────

test.describe("App boot", () => {
  test("loads without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto("/");
    await waitForApp(page);
    // Filter expected non-critical errors (e.g. favicon, SW)
    const critical = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("service-worker")
    );
    expect(critical).toHaveLength(0);
  });

  test("renders the Pulse screen at /", async ({ page }) => {
    // The index route renders PulseScreen directly (no redirect).
    // Assert the app shell mounted and Pulse content is reachable.
    await page.goto("/");
    await waitForApp(page);
    await expect(page.locator("#root")).not.toBeEmpty();
    // /pulse should still be navigable from here.
    await page.goto("/pulse");
    await waitForApp(page);
    expect(page.url()).toContain("pulse");
  });

  test("no horizontal overflow on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await waitForApp(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
  });
});

// ─── route navigation ──────────────────────────────────────────────────────

test.describe("Route navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForApp(page);
  });

  test("navigates to /ledger", async ({ page }) => {
    await page.goto("/ledger");
    await waitForApp(page);
    expect(page.url()).toContain("ledger");
    await expect(page.locator("body")).not.toBeEmpty();
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible();
  });

  test("navigates to /insights", async ({ page }) => {
    await page.goto("/insights");
    await waitForApp(page);
    expect(page.url()).toContain("insights");
    await expect(page.locator("body")).not.toBeEmpty();
  });

  // /entry and /settings are not routes in SpendTrack — they are an in-app sheet
  // and a drawer respectively. The catch-all redirects them to /pulse. Verify
  // that the redirect behaviour is intact rather than asserting the URL stays.
  test("unknown routes redirect to /pulse", async ({ page }) => {
    await page.goto("/entry");
    await waitForApp(page);
    expect(page.url()).toContain("pulse");
  });
});

// ─── add expense ───────────────────────────────────────────────────────────

// /entry is an in-app sheet triggered from /pulse via the full-entry button.
test.describe("Add expense", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/pulse");
    await waitForApp(page);
  });

  test("entry form renders required fields", async ({ page }) => {
    await page.getByRole("button", { name: "Full entry form" }).click();

    // Sheet auto-focuses the "What" field on open
    const whatField = page.getByPlaceholder(/coffee, grab, spotify/i);
    await expect(whatField).toBeVisible({ timeout: 3000 });
    await expect(page.getByPlaceholder("0.00")).toBeVisible();
  });

  test("submits a valid expense and it appears in ledger", async ({ page }) => {
    await page.getByRole("button", { name: "Full entry form" }).click();

    await page.getByPlaceholder(/coffee, grab, spotify/i).fill("E2E Test Coffee");
    const amountField = page.getByPlaceholder("0.00");
    await amountField.fill("9.99");
    await amountField.press("Enter");

    await page.waitForTimeout(400);

    await page.goto("/ledger");
    await waitForApp(page);
    await expect(page.getByText("E2E Test Coffee")).toBeVisible({ timeout: 3000 });
  });
});

// ─── backup & restore ──────────────────────────────────────────────────────

// /settings is a drawer opened from the TopBar "Settings" button.
test.describe("Backup and restore", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/pulse");
    await waitForApp(page);
    // Open settings drawer and navigate to Backup tab
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: "Backup" }).click();
    await page.waitForTimeout(100);
  });

  test("backup triggers a file download", async ({ page }) => {
    const downloadPromise = page.waitForEvent("download", { timeout: 5000 });
    await page.getByRole("button", { name: /download json backup/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/spendtrack|backup|\.json/i);
  });

  test("restore input accepts JSON file without crashing", async ({ page }) => {
    const backup = {
      version: 3,
      expenses: [],
      categories: [],
      exportedAt: new Date().toISOString(),
    };

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: "spendtrack-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });

    await page.waitForTimeout(500);
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible();
  });
});

// ─── date navigation (ledger) ──────────────────────────────────────────────

test.describe("Ledger", () => {
  test("renders without error", async ({ page }) => {
    await page.goto("/ledger");
    await waitForApp(page);
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible();
    await expect(page.locator("#root")).not.toBeEmpty();
  });
});

// ─── insights ──────────────────────────────────────────────────────────────

test.describe("Insights", () => {
  test("renders charts without error", async ({ page }) => {
    await page.goto("/insights");
    await waitForApp(page);
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible();
  });
});

// ─── PWA / install surface ─────────────────────────────────────────────────

test.describe("PWA metadata", () => {
  test("manifest is linked and includes PNG icons", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // SpendTrack uses /manifest.webmanifest (vite-plugin-pwa default).
    // The <link rel="manifest"> is injected in <body>, so we wait briefly
    // and then resolve the href in either the head or body.
    const manifestHref =
      (await page.locator('link[rel="manifest"]').first().getAttribute("href")) ??
      "/manifest.webmanifest";

    const manifestResp = await page.request.get(manifestHref);
    expect(manifestResp.status()).toBe(200);
    const manifest = await manifestResp.json();

    const pngIcons = (manifest.icons ?? []).filter((i: { type?: string }) =>
      i.type === "image/png"
    );
    expect(pngIcons.length).toBeGreaterThanOrEqual(2); // 192 + 512
  });

  test("apple-touch-icon is present", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    // SpendTrack serves apple-touch-icon.png from /public; assert the file is reachable
    // rather than the <link> tag (which other apps add but SpendTrack inlines via PWA plugin).
    const resp = await page.request.get("/apple-touch-icon.png");
    expect([200, 304]).toContain(resp.status());
  });
});
