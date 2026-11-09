import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";
test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
});
test("denied list, raw prefix, next page and current page filter", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "fast.txt", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("已知桶")).toHaveValue("known");
  await page.getByRole("button", { name: "raw/../", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "raw/../raw\\../对象.txt", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "next.txt", exact: true }),
  ).toBeVisible();
  await page.getByLabel("筛选当前页").fill("missing");
  await expect(
    page.getByRole("button", { name: "next.txt", exact: true }),
  ).toHaveCount(0);
});
test("stale properties discarded, preview and ephemeral sharing", async ({
  page,
}) => {
  await page.getByRole("button", { name: "slow.txt", exact: true }).click();
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
  await expect(
    page.locator(".details dd").filter({ hasText: "fast.txt" }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  await expect(
    page.locator(".details dd").filter({ hasText: "slow.txt" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "安全预览", exact: true }).click();
  await expect(page.locator(".preview")).toHaveText("fast.txt");
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await page.getByRole("button", { name: "生成链接" }).click();
  await expect(page.getByLabel("分享链接", { exact: true })).toHaveValue(
    /signed=test/,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await expect(page.getByLabel("分享链接", { exact: true })).toHaveCount(0);
});
test("transfers survive settings, cancel/retry and partial delete errors stay visible", async ({
  page,
}) => {
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  await page.getByRole("button", { name: /任务中心 \(/ }).click();
  await expect(page.getByText("传输中", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "取消任务" }).click();
  await expect(page.getByRole("button", { name: "重试任务" })).toBeVisible();
  await page.getByRole("button", { name: "重试任务" }).click();
  await expect(page.getByRole("button", { name: "取消任务" })).toBeVisible();
  await page.getByRole("button", { name: "对象浏览", exact: true }).click();
  await page.getByLabel("选择 fast.txt", { exact: true }).check();
  await page.getByRole("button", { name: "删除选中" }).click();
  await expect(page.getByRole("alert")).toContainText("denied.txt");
  await expect(page.getByRole("status")).toContainText("失败 1");
});
test("settings failure rolls preview back and form validation remains visible", async ({
  page,
}) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await page.evaluate(() => (window.__failSettings = true));
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "保存失败",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("新连接");
  await page.getByLabel("签名区域", { exact: true }).fill("us-east-1");
  await page.getByRole("button", { name: "保存连接" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Access Key",
  );
  await page.getByLabel("Access Key", { exact: true }).fill("test-only");
  await page.getByLabel("Secret Key", { exact: true }).fill("test-only");
  await page.getByRole("button", { name: "保存连接" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "新连接", exact: true }),
  ).toBeVisible();
});
for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 920])
        test(`geometry ${theme} ${large} ${collapsed} ${width}`, async ({
          page,
        }, info) => {
          await page.setViewportSize({
            width,
            height: width === 1440 ? 900 : 620,
          });
          if (width === 920)
            await page.getByRole("button", { name: "收起详情" }).click();
          await page.getByRole("button", { name: "设置", exact: true }).click();
          await page
            .getByRole("combobox", { name: "主题", exact: true })
            .selectOption(theme);
          await page.getByLabel("大字模式", { exact: true }).setChecked(large);
          await page.getByRole("button", { name: "保存设置" }).click();
          if (collapsed)
            await page.getByRole("button", { name: "折叠侧栏" }).click();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBeTruthy();
          await expect(
            page.getByRole("button", { name: "打开桶" }),
          ).toBeInViewport();
          await expect(
            page.getByRole("button", { name: "fast.txt", exact: true }),
          ).toBeInViewport();
          await expect(
            page.getByRole("button", { name: "slow.txt", exact: true }),
          ).toBeInViewport();
          await page.screenshot({ path: info.outputPath("workbench.png") });
        });

test("system theme, settings focus trap and long connection form scroll", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("system");
  await page.getByRole("button", { name: "保存设置" }).click();
  expect(
    await page
      .locator("html")
      .evaluate((el) => getComputedStyle(el).colorScheme),
  ).toBe("dark");
  await page.setViewportSize({ width: 920, height: 620 });
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
  await page
    .getByLabel("公开 Base URL", { exact: true })
    .fill("https://example.invalid");
  await expect(
    page.getByLabel("公开 Base URL", { exact: true }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "保存连接" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "关闭弹窗" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "新建连接", exact: true }),
  ).toBeFocused();
});

test("editing bucket draft preserves displayed context until Open", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__calls = [];
    const invoke = window.storageLab.invoke;
    window.storageLab.invoke = (method, p) => {
      window.__calls.push({ method, p });
      return invoke(method, p);
    };
  });
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
  await page.getByLabel("选择 fast.txt", { exact: true }).check();
  await page.getByLabel("已知桶").fill("different-bucket");
  await page.getByRole("button", { name: "下载选中", exact: true }).click();
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await page.getByRole("button", { name: "生成链接", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "删除选中", exact: true }).click();
  const buckets = await page.evaluate(() =>
    window.__calls
      .filter((c) =>
        ["downloadFiles", "shareObject", "deleteObjects"].includes(c.method),
      )
      .map((c) => c.p.bucket),
  );
  expect(buckets).toEqual(["known", "known", "known"]);
  await page.getByRole("button", { name: "打开桶", exact: true }).click();
  await expect(page.locator(".crumb")).toContainText("different-bucket");
  await expect(
    page.getByRole("button", { name: "下载选中", exact: true }),
  ).toBeDisabled();
});
