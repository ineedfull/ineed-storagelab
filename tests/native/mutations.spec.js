import { test, expect, _electron as electron } from "@playwright/test";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";
test("production object copy, conservative rename and metadata preserve source bytes", async ({}, info) => {
  test.skip(
    !process.env.STORAGELAB_TEST_CONFIG &&
      !process.env.STORAGELAB_TEST_ENDPOINT,
    "Requires private loopback MinIO",
  );
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/host.mjs"],
    env: { ...process.env },
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .getByRole("button", { name: "Isolated MinIO", exact: true })
      .click();
    await page
      .getByRole("button", { name: "preview.txt", exact: true })
      .click();
    await page.getByRole("button", { name: "复制对象", exact: true }).click();
    let d = page.getByRole("dialog", { name: "复制对象", exact: true });
    await d
      .getByLabel("目标完整 Key", { exact: true })
      .fill("copy-中文+%?.txt");
    await d.getByRole("button", { name: "确认复制", exact: true }).click();
    await expect(d.getByRole("alert")).toContainText("NO_OVERWRITE_UNVERIFIED");
    await d.getByLabel("明确允许覆盖目标同名对象", { exact: true }).check();
    await d.getByRole("button", { name: "确认复制", exact: true }).click();
    await expect(d.getByRole("status")).toContainText("复制已完成");
    expect(
      (await app.evaluate(() => globalThis.readObject("copy-中文+%?.txt")))
        .content,
    ).toBe("StorageLab native roundtrip\n");
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "preview.txt", exact: true })
      .click();
    await page.getByRole("button", { name: "重命名对象", exact: true }).click();
    d = page.getByRole("dialog", { name: "重命名对象", exact: true });
    await d.getByLabel("目标完整 Key", { exact: true }).fill("renamed.txt");
    await d.getByLabel("明确允许覆盖目标同名对象", { exact: true }).check();
    await d.getByRole("button", { name: "确认重命名", exact: true }).click();
    await expect(d.getByRole("status")).toContainText("源对象保留");
    expect(
      (await app.evaluate(() => globalThis.readObject("preview.txt"))).content,
    ).toBe("StorageLab native roundtrip\n");
    expect(
      (await app.evaluate(() => globalThis.readObject("renamed.txt"))).content,
    ).toBe("StorageLab native roundtrip\n");
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "preview.txt", exact: true })
      .click();
    await page.getByRole("button", { name: "编辑元数据", exact: true }).click();
    d = page.getByRole("dialog", { name: "编辑元数据", exact: true });
    await d
      .getByLabel("Content-Type", { exact: true })
      .fill("application/json");
    await d.getByLabel("Cache-Control", { exact: true }).fill("no-cache");
    await d.getByRole("button", { name: "添加元数据", exact: true }).click();
    await d.getByLabel("元数据键 1", { exact: true }).fill("environment");
    await d.getByLabel("元数据值 1", { exact: true }).fill("native");
    await d.getByRole("button", { name: "保存元数据", exact: true }).click();
    await expect(d.getByRole("status")).toContainText("元数据已更新");
    expect(
      await app.evaluate(() => globalThis.readObject("preview.txt")),
    ).toEqual({
      content: "StorageLab native roundtrip\n",
      metadata: { environment: "native" },
      contentType: "application/json",
      cacheControl: "no-cache",
    });
    await page.screenshot({ path: info.outputPath("native-metadata.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
