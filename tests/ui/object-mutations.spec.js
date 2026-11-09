import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";
async function setup(page) {
  await installFixture(page);
  await page.goto("/");
  await page.evaluate(() => {
    const base = window.storageLab.invoke;
    window.__mutationCalls = [];
    window.storageLab.invoke = async (method, p = {}) => {
      if (!["prepareObjectMutation", "executeObjectMutation"].includes(method))
        return base(method, p);
      window.__mutationCalls.push({ method, p });
      if (window.__denyMutation)
        return {
          ok: false,
          error: { code: "ACCESS_DENIED", message: "属性读取权限不足" },
        };
      if (method === "prepareObjectMutation")
        return {
          ok: true,
          value: {
            key: p.key,
            size: 4,
            etag: '"e"',
            contentType: "text/plain",
            cacheControl: "no-cache",
            metadata: { env: "old" },
            capabilities: { conditionalCopy: true, conditionalDelete: true },
          },
        };
      return {
        ok: true,
        value: window.__cancelMutation
          ? { cancelled: true }
          : p.kind === "rename"
            ? {
                copied: true,
                sourceRetained: true,
                warning: "复制成功，源对象保留，请核实",
              }
            : p.kind === "metadata"
              ? { updated: true }
              : { copied: true },
      };
    };
  });
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
  if (await page.getByRole("button", { name: "展开详情", exact: true }).count())
    await page.getByRole("button", { name: "展开详情", exact: true }).click();
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
}
test("copy raw target and partial rename retain accurate result and prevent repeat writes", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "重命名对象", exact: true }).click();
  const d = page.getByRole("dialog", { name: "重命名对象", exact: true });
  await expect(d.getByLabel("目标完整 Key", { exact: true })).toHaveValue(
    "fast.txt",
  );
  await d.getByLabel("目标完整 Key", { exact: true }).fill(" 新对象/+%?#.txt ");
  await d.getByRole("button", { name: "确认重命名", exact: true }).click();
  await expect(d.getByRole("status")).toContainText("源对象保留");
  await expect(
    d.getByRole("button", { name: "确认重命名", exact: true }),
  ).toBeDisabled();
  const call = await page.evaluate(
    () =>
      window.__mutationCalls.find((c) => c.method === "executeObjectMutation")
        .p,
  );
  expect(call).toMatchObject({
    key: "fast.txt",
    targetKey: " 新对象/+%?#.txt ",
    overwrite: false,
    kind: "rename",
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "刷新", exact: true }),
  ).toBeFocused();
});
test("metadata load error blocks save; cancel retains edited metadata", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => (window.__denyMutation = true));
  await page.getByRole("button", { name: "编辑元数据", exact: true }).click();
  const d = page.getByRole("dialog", { name: "编辑元数据", exact: true });
  await expect(d.getByRole("alert")).toContainText("ACCESS_DENIED");
  await expect(
    d.getByRole("button", { name: "保存元数据", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.__denyMutation = false;
    window.__cancelMutation = true;
  });
  await d.getByRole("button", { name: "重新读取属性", exact: true }).click();
  await d.getByLabel("Content-Type", { exact: true }).fill("application/json");
  await d.getByLabel("元数据值 1", { exact: true }).fill(" new ");
  await d.getByRole("button", { name: "保存元数据", exact: true }).click();
  await expect(d.getByRole("status")).toContainText("取消");
  await expect(d.getByLabel("元数据值 1", { exact: true })).toHaveValue(
    " new ",
  );
});
for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 920]) {
        test(`management display ${theme}/${large}/${collapsed}/${width}`, async ({
          page,
        }, info) => {
          await page.setViewportSize({
            width,
            height: width === 920 ? 620 : 900,
          });
          await setup(page);
          await page.getByRole("button", { name: "设置", exact: true }).click();
          await page
            .getByRole("combobox", { name: "主题", exact: true })
            .selectOption(theme);
          await page.getByLabel("大字模式", { exact: true }).setChecked(large);
          await page
            .getByRole("button", { name: "保存设置", exact: true })
            .click();
          if (collapsed)
            await page
              .getByRole("button", { name: "折叠侧栏", exact: true })
              .click();
          await page
            .getByRole("button", { name: "编辑元数据", exact: true })
            .click();
          const d = page.getByRole("dialog", {
            name: "编辑元数据",
            exact: true,
          });
          await expect(d.getByLabel("元数据键 1", { exact: true })).toHaveValue(
            "env",
          );
          for (let i = 0; i < 5; i++)
            await d
              .getByRole("button", { name: "添加元数据", exact: true })
              .click();
          expect(
            await d.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
          ).toBe(true);
          await d
            .getByRole("button", { name: "保存元数据", exact: true })
            .scrollIntoViewIfNeeded();
          await expect(
            d.getByRole("button", { name: "保存元数据", exact: true }),
          ).toBeInViewport();
          await page.screenshot({ path: info.outputPath("management.png") });
          await page.keyboard.press("Escape");
          await expect(
            page.getByRole("button", { name: "编辑元数据", exact: true }),
          ).toBeFocused();
        });
      }
