import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
});

test("sidebar keeps utilities visible and exposes both collapse states", async ({
  page,
}) => {
  const toggle = page.getByRole("button", { name: "折叠侧栏", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(
    await page
      .locator(".brand-icon")
      .evaluate((el) => el.complete && el.naturalWidth > 0),
  ).toBe(true);
  await expect(page.locator(".brand").getByRole("button")).toHaveCount(1);
  for (const name of ["设置", "关于"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button.locator("svg")).toHaveCount(1);
    await expect(button).toHaveAttribute("title", name);
  }
  await toggle.click();
  await expect(
    page.getByRole("button", { name: "展开侧栏", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".sidebar")).toHaveCSS("width", "58px");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeFocused();
});

test("settings and about follow series sections and preserve object drafts", async ({
  page,
}) => {
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
  await page.getByLabel("筛选当前页").fill("fast");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "显示设置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "传输设置" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "关于", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".about-identity img")).toBeVisible();
  await expect
    .poll(() =>
      dialog
        .locator(".about-identity img")
        .evaluate((el) => el.complete && el.naturalWidth > 0),
    )
    .toBe(true);
  expect((await dialog.boundingBox()).width).toBeLessThanOrEqual(480);
  await expect(dialog).toContainText("独立数据目录");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "关于", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("筛选当前页")).toHaveValue("fast");
});

for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 920])
        test(`shell dialogs ${theme} ${large} ${collapsed} ${width}`, async ({
          page,
        }, info) => {
          await page.setViewportSize({
            width,
            height: width === 1440 ? 900 : 620,
          });
          await page.getByRole("button", { name: "设置", exact: true }).click();
          await page.getByLabel("主题", { exact: true }).selectOption(theme);
          await page.getByLabel("大字模式", { exact: true }).setChecked(large);
          await page
            .getByRole("button", { name: "保存设置", exact: true })
            .click();
          if (collapsed)
            await page
              .getByRole("button", { name: "折叠侧栏", exact: true })
              .click();
          for (const name of ["设置", "关于"]) {
            await page.getByRole("button", { name, exact: true }).click();
            const dialog = page.getByRole("dialog");
            expect((await dialog.boundingBox()).width).toBeLessThanOrEqual(
              name === "设置" ? 700 : 480,
            );
            await expect(dialog.locator("header")).toBeInViewport();
            await expect(dialog.locator("footer")).toBeInViewport();
            const body = dialog.locator(".dialog-body");
            await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
            await expect(dialog.locator("header")).toBeInViewport();
            await expect(dialog.locator("footer")).toBeInViewport();
            await page.screenshot({ path: info.outputPath(`${name}.png`) });
            await page.keyboard.press("Escape");
            await expect(
              page.getByRole("button", { name, exact: true }),
            ).toBeFocused();
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        });
