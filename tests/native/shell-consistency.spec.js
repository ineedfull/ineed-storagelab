import { test, expect, _electron as electron } from "@playwright/test";
import { rm } from "node:fs/promises";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";

test("production shell persists display settings and keeps native About and controls usable", async ({}, info) => {
  let isolated;
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native"],
  });
  try {
    isolated = await app.evaluate(() => globalThis.isolatedAppData);
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const width of [1440, 1120, 920]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(
          width,
          width === 1440 ? 900 : width === 1120 ? 720 : 620,
        );
        window.show();
      }, width);
      for (const theme of ["light", "dark"]) {
        await page.getByRole("button", { name: "设置", exact: true }).click();
        await page.getByLabel("主题", { exact: true }).selectOption(theme);
        await page
          .getByLabel("大字模式", { exact: true })
          .setChecked(theme === "dark");
        await page
          .getByRole("button", { name: "保存设置", exact: true })
          .click();
        await page.getByRole("button", { name: /^(折叠|展开)侧栏$/ }).click();
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("html")).toHaveAttribute(
          "data-large",
          String(theme === "dark"),
        );
        await page.getByRole("button", { name: "关于", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("com.ineedfull.storagelab");
        await expect(dialog).toContainText("Electron");
        expect(
          await dialog
            .locator(".about-identity img")
            .evaluate((el) => el.complete && el.naturalWidth > 0),
        ).toBe(true);
        await expect(dialog.locator("header")).toBeInViewport();
        await expect(dialog.locator("footer")).toBeInViewport();
        await page.screenshot({
          path: info.outputPath(`about-${width}-${theme}.png`),
        });
        await page.keyboard.press("Escape");
        await expect(
          page.getByRole("button", { name: "关于", exact: true }),
        ).toBeFocused();
        await page
          .getByRole("button", { name: "新建连接", exact: true })
          .click();
        await expect(dialog).toHaveAttribute("aria-label", "新建连接");
        await expect(dialog.locator("header")).toBeInViewport();
        await expect(dialog.locator("footer")).toBeInViewport();
        await expect(
          page.getByLabel("Secret Key", { exact: true }),
        ).toHaveValue("");
        await page
          .getByLabel("公开 Base URL", { exact: true })
          .fill("https://files.example.invalid");
        await expect(
          page.getByLabel("公开 Base URL", { exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await expect(dialog.locator("header")).toBeInViewport();
        await expect(dialog.locator("footer")).toBeInViewport();
        await page.screenshot({
          path: info.outputPath(`connection-${width}-${theme}.png`),
        });
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "新建连接", exact: true }),
        ).toBeFocused();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
});
