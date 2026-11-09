import { test, expect, _electron as electron } from "@playwright/test";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";

test("legacy saved identities and current S3 providers retain real Electron form, persistence and local S3 compatibility", async () => {
  test.skip(
    !process.env.STORAGELAB_TEST_CONFIG,
    "Requires explicit isolated loopback storage config",
  );
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/host.mjs"],
    env: { ...process.env },
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: "Isolated MinIO", exact: true })
      .click();
    for (const provider of [
      "aws",
      "aliyun",
      "cos",
      "tos",
      "qiniu",
      "r2",
      "b2",
      "spaces",
      "wasabi",
    ]) {
      // Seed pre-existing legacy profiles directly: removed aliases are never
      // created or selected through the new connection form. This host is the
      // S3 compatibility fixture; native SDK smoke lives in native-providers.
      if (["aliyun", "cos", "tos"].includes(provider)) {
        await app.evaluate((_, provider) => {
          const store = globalThis.fixture.store;
          const current = store.snapshot().connections[0];
          store.saveConnection({
            connection: { ...current, provider },
            credentialStorage: current.credentialStorage,
          });
        }, provider);
        await page.reload();
        await page
          .getByRole("button", { name: "Isolated MinIO", exact: true })
          .click();
      }
      await page.getByRole("button", { name: "编辑连接", exact: true }).click();
      const originalEndpoint = await page
        .getByLabel("Endpoint", { exact: true })
        .inputValue();
      const providerSelect = page.getByLabel("提供商", { exact: true });
      if (["aliyun", "cos", "tos"].includes(provider)) {
        await expect(providerSelect).toHaveValue(provider);
        await expect(providerSelect.locator("option:checked")).toContainText(
          "当前旧版连接",
        );
      } else {
        await providerSelect.selectOption(provider);
      }
      await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(
        originalEndpoint,
      );
      await page.getByRole("button", { name: "保存连接", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(
        await app.evaluate(
          () => globalThis.fixture.store.snapshot().connections[0].provider,
        ),
      ).toBe(provider);
      await page
        .getByRole("button", { name: "preview.txt", exact: true })
        .click();
      await page.getByRole("button", { name: "安全预览", exact: true }).click();
      await expect(page.locator(".preview")).toHaveText(
        "StorageLab native roundtrip\n",
      );
      const tags = page.getByRole("region", { name: "对象标签" });
      if (["aliyun", "r2", "b2"].includes(provider)) {
        await expect(tags).toContainText("不支持对象标签");
      } else {
        await tags
          .getByRole("button", { name: "读取标签", exact: true })
          .click();
        await expect(tags).toContainText("当前无标签");
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
