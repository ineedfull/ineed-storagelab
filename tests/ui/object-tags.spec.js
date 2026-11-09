import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

async function openObject(page) {
  await installFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
  if (await page.getByRole("button", { name: "展开详情", exact: true }).count())
    await page.getByRole("button", { name: "展开详情", exact: true }).click();
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
}
test("object tag edit/save/revert/clear and permission failure stay distinct from empty tags", async ({
  page,
}) => {
  await openObject(page);
  const editor = page.getByRole("region", { name: "对象标签" });
  await editor.getByRole("button", { name: "读取标签", exact: true }).click();
  await expect(editor).toContainText("当前无标签");
  await editor.getByRole("button", { name: "添加标签", exact: true }).click();
  await editor.getByLabel("标签1 Key", { exact: true }).fill("环境");
  await editor.getByLabel("标签1 Value", { exact: true }).fill(" 开发 ");
  await editor.getByRole("button", { name: "保存标签", exact: true }).click();
  await expect(editor.getByRole("status")).toHaveText("标签已保存");
  expect(
    await page.evaluate(() => window.__tagCalls.at(-1).payload),
  ).toMatchObject({
    key: "fast.txt",
    tags: [{ key: "环境", value: " 开发 " }],
    originalTags: [],
    versionId: "fixture-version",
  });
  await editor.getByLabel("标签1 Value", { exact: true }).fill("改动");
  await editor.getByRole("button", { name: "撤销编辑", exact: true }).click();
  await expect(editor.getByLabel("标签1 Value", { exact: true })).toHaveValue(
    " 开发 ",
  );
  await page.getByRole("button", { name: "slow.txt", exact: true }).click();
  await expect(editor.getByLabel("标签1 Key", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
  await editor.getByRole("button", { name: "读取标签", exact: true }).click();
  await expect(editor.getByLabel("标签1 Value", { exact: true })).toHaveValue(
    " 开发 ",
  );
  await editor.getByRole("button", { name: "移除标签1", exact: true }).click();
  await editor.getByRole("button", { name: "保存标签", exact: true }).click();
  await expect(editor.getByRole("status")).toHaveText("标签已保存");
  await expect(editor).toContainText("当前无标签");
  await page.evaluate(() => {
    window.__denyTags = true;
  });
  await editor
    .getByRole("button", { name: "重新读取标签", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText("ACCESS_DENIED");
  await expect(editor.getByText("当前无标签", { exact: true })).toHaveCount(0);
});
