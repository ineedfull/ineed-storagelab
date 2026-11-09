import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
});

test("help remains readable on hover and can be pinned or dismissed with clicks", async ({
  page,
}) => {
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
  const button = page.getByRole("button", {
    name: "对象标签填写规则",
    exact: true,
  });
  const tip = page.getByRole("tooltip", {
    name: "对象标签填写规则",
    exact: true,
  });
  await expect(tip).toBeHidden();
  await button.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("UTF-16");
  await tip.hover();
  await page.waitForTimeout(220);
  await expect(tip).toBeVisible();
  await page.mouse.move(10, 10);
  await expect(tip).toBeHidden();
  await button.click();
  await page.mouse.move(10, 10);
  await expect(tip).toBeVisible();
  await button.click();
  await expect(tip).toBeHidden();
  await button.click();
  await page.getByRole("heading", { name: "属性与预览", exact: true }).click();
  await expect(tip).toBeHidden();
});

test("keyboard help closes before the connection dialog and does not submit its draft", async ({
  page,
}) => {
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建连接", exact: true });
  await page.getByLabel("名称", { exact: true }).fill("帮助测试草稿");
  const button = page.getByRole("button", {
    name: "Endpoint 填写说明",
    exact: true,
  });
  await button.focus();
  const tip = page.getByRole("tooltip", {
    name: "Endpoint 填写说明",
    exact: true,
  });
  await expect(tip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue(
    "帮助测试草稿",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("help fits all display combinations and never truncates capacity cells", async ({
  page,
}) => {
  await page.evaluate(() => {
    const invoke = window.storageLab.invoke;
    window.storageLab.invoke = async (method, payload) => {
      const result = await invoke(method, payload);
      if (method === "listObjects")
        result.value.objects.forEach((object) => (object.size = 1073731338));
      return result;
    };
  });
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
  for (const theme of ["light", "dark"])
    for (const large of [false, true])
      for (const collapsed of [false, true])
        for (const width of [1440, 920]) {
          await page.setViewportSize({
            width,
            height: width === 1440 ? 900 : 620,
          });
          await page.evaluate(
            ({ theme, large, collapsed }) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.dataset.large = String(large);
              document
                .querySelector(".workbench")
                .classList.toggle("collapsed", collapsed);
            },
            { theme, large, collapsed },
          );
          const button = page.getByRole("button", {
            name: "对象标签填写规则",
            exact: true,
          });
          await button.click();
          const tip = page.getByRole("tooltip", {
            name: "对象标签填写规则",
            exact: true,
          });
          await expect(tip).toBeVisible();
          const box = await tip.boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          expect(box.y + box.height).toBeLessThanOrEqual(
            width === 1440 ? 900 : 620,
          );
          expect(
            await tip.evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          const size = page.locator(".browser td.file-size-cell").first();
          await expect(size).toHaveText("1,023.99 MB");
          expect(
            await size.evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          await page.keyboard.press("Escape");
        }
});
