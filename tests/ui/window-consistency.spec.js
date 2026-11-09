import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

async function setup(page) {
  await installFixture(page);
  await page.goto("/");
  await page.evaluate(() => {
    const invoke = window.storageLab.invoke;
    window.storageLab.invoke = async (method, payload) => {
      if (method === "prepareObjectMutation")
        return {
          ok: true,
          value: {
            size: 4,
            contentType: "text/plain",
            metadata: Object.fromEntries(
              Array.from({ length: 8 }, (_, i) => [`field${i}`, `value${i}`]),
            ),
            capabilities: { conditionalCopy: true },
          },
        };
      if (method === "removeConnection" && window.__holdRemove) {
        await new Promise((resolve) => (window.__releaseRemove = resolve));
        return { ok: false, error: { message: "模拟移除失败" } };
      }
      if (method === "shareObject" && window.__holdShare)
        return new Promise((resolve) => (window.__releaseShare = resolve));
      return invoke(method, payload);
    };
  });
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
}

test("connection commands belong to the context header, and failed removal retains its dialog", async ({
  page,
}) => {
  await setup(page);
  for (const name of ["编辑连接", "检查连接", "移除连接"]) {
    await expect(
      page.locator(".topbar").getByRole("button", { name, exact: true }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "移除连接", exact: true }).click();
  await page.evaluate(() => (window.__holdRemove = true));
  await page.getByRole("button", { name: "确认移除连接", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "关闭弹窗", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => window.__releaseRemove());
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "模拟移除失败",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "移除连接", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "本地测试", exact: true }),
  ).toBeVisible();
});

test("share actions stay fixed after generation and closing discards a delayed error", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 920, height: 620 });
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await page.evaluate(() => (window.__holdShare = true));
  await page.getByRole("button", { name: "生成链接", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "正在生成…", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await page.evaluate(() => {
    window.__releaseShare({
      ok: false,
      error: { message: "obsolete share failure" },
    });
    window.__holdShare = false;
  });
  await page.getByRole("button", { name: "生成链接", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("分享链接", { exact: true })).toHaveValue(
    /signed=test/,
  );
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.locator(":scope > .dialog-footer")).toBeInViewport({
    ratio: 1,
  });
  await expect(
    dialog.getByRole("button", { name: "复制链接", exact: true }),
  ).toBeInViewport({ ratio: 1 });
});

for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 920])
        test(`all windows ${theme}/${large}/${collapsed}/${width}`, async ({
          page,
        }, info) => {
          await setup(page);
          await page.setViewportSize({
            width,
            height: width === 920 ? 620 : 900,
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
          await page
            .getByRole("button", { name: "fast.txt", exact: true })
            .click();
          for (const name of [
            "新建连接",
            "编辑连接",
            "设置",
            "关于",
            "移除连接",
            "分享",
            "复制对象",
            "重命名对象",
            "编辑元数据",
            "版本与恢复",
          ]) {
            await page.getByRole("button", { name, exact: true }).click();
            const dialog = page.getByRole("dialog");
            await expect(dialog.locator(":scope > header")).toBeInViewport({
              ratio: 1,
            });
            const footer = dialog.locator(":scope > .dialog-footer");
            await expect(footer).toBeInViewport({ ratio: 1 });
            expect(
              await dialog.evaluate(
                (el) => el.scrollWidth <= el.clientWidth + 1,
              ),
            ).toBe(true);
            const before = await footer.boundingBox();
            const body = dialog.locator(":scope > .dialog-body");
            await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
            expect(await footer.boundingBox()).toEqual(before);
            await expect(dialog.locator(":scope > header")).toBeInViewport({
              ratio: 1,
            });
            if (["分享", "编辑元数据", "版本与恢复"].includes(name))
              await page.screenshot({ path: info.outputPath(`${name}.png`) });
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);
            await expect(
              page.getByRole("button", { name, exact: true }),
            ).toBeFocused();
          }
          await page.getByRole("button", { name: /^任务中心/ }).click();
          await expect(
            page.getByRole("button", { name: "刷新任务", exact: true }),
          ).toBeInViewport();
          await page.screenshot({ path: info.outputPath("main-tasks.png") });
        });
