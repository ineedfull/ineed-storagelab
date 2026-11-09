import { test, expect, _electron as electron } from "@playwright/test";
import { rm } from "node:fs/promises";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";

test("all dialogs use the same native window layout with isolated IPC display fixtures", async ({}, info) => {
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native"],
  });
  let isolated;
  try {
    isolated = await app.evaluate(() => globalThis.isolatedAppData);
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "新建连接", exact: true }),
    ).toBeEnabled();
    // This test verifies Electron rendering/preload and keyboard behavior. Storage
    // responses are fixtures; production IPC/service checks live in startup.spec.
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const connection = {
        id: "native-ui",
        name: "隔离界面测试",
        provider: "minio",
        endpoint: "http://127.0.0.1:1",
        region: "us-east-1",
        defaultBucket: "known",
        credentialStorage: "session",
      };
      let settings = {
        theme: "light",
        largeText: false,
        sidebarCollapsed: false,
        concurrency: 2,
        timeoutSeconds: 30,
      };
      ipcMain.removeHandler("storagelab:invoke");
      ipcMain.handle("storagelab:invoke", (_event, method, payload) => {
        let value = true;
        if (method === "bootstrap")
          value = {
            connections: [connection],
            settings,
            jobs: [],
            app: {
              native: true,
              vaultAvailable: false,
              runtime: "Electron · isolated display fixture",
              version: "1.0.0",
              dataDirectory: "isolated",
            },
          };
        if (method === "saveSettings") value = settings = payload;
        if (method === "listBuckets") value = { buckets: [{ name: "known" }] };
        if (method === "listObjects")
          value = { objects: [{ key: "fixture.txt", size: 4 }], prefixes: [] };
        if (method === "headObject" || method === "prepareObjectMutation")
          value = {
            key: "fixture.txt",
            size: 4,
            metadata: Object.fromEntries(
              Array.from({ length: 8 }, (_, i) => [`key${i}`, `value${i}`]),
            ),
            capabilities: { conditionalCopy: true },
          };
        if (method === "getObjectTags") value = { tags: [] };
        return { ok: true, value };
      });
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(920, 620);
      window.show();
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.reload();
    await page
      .getByRole("button", { name: "隔离界面测试", exact: true })
      .click();
    await page
      .getByRole("button", { name: "fixture.txt", exact: true })
      .click();
    for (const theme of ["light", "dark"]) {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByLabel("主题", { exact: true }).selectOption(theme);
      await page
        .getByLabel("大字模式", { exact: true })
        .setChecked(theme === "dark");
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
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
        if (name === "新建连接") {
          await dialog
            .getByRole("button", { name: "Endpoint 填写说明", exact: true })
            .click();
          await expect(
            dialog.getByRole("tooltip", {
              name: "Endpoint 填写说明",
              exact: true,
            }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(dialog).toBeVisible();
          await expect(
            dialog.getByRole("tooltip", {
              name: "Endpoint 填写说明",
              exact: true,
            }),
          ).toBeHidden();
        }
        await expect(dialog.locator(":scope > header")).toBeInViewport({
          ratio: 1,
        });
        await dialog
          .locator(":scope > .dialog-body")
          .evaluate((el) => (el.scrollTop = el.scrollHeight));
        await expect(dialog.locator(":scope > .dialog-footer")).toBeInViewport({
          ratio: 1,
        });
        if (["分享", "编辑元数据", "版本与恢复"].includes(name))
          await page.screenshot({
            path: info.outputPath(`${theme}-${name}.png`),
          });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(
          page.getByRole("button", { name, exact: true }),
        ).toBeFocused();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
});
