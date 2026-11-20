import { test, expect, _electron as electron } from "@playwright/test";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";
test("real production main starts branded app with isolated SQLite and truthful About", async () => {
  let isolated;
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native"],
  });
  try {
    isolated = await app.evaluate(() => globalThis.isolatedAppData);
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "新建连接", exact: true }),
    ).toBeEnabled();
    expect(await app.evaluate(({ app }) => app.getName())).toBe("StorageLab");
    expect(await page.title()).toBe("StorageLab");
    await page.getByRole("button", { name: "关于", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "com.ineedfull.storagelab",
    );
    await expect(page.getByRole("dialog")).toContainText("Electron");
    await expect(page.getByRole("dialog")).toContainText(version);
    const vault = await app.evaluate(() => globalThis.verifyNativeVault());
    if (vault.available)
      expect(vault).toEqual({
        available: true,
        correct: true,
        publicSafe: true,
        encrypted: true,
      });
    else
      console.log(
        "Native safeStorage unavailable; session-only boundary retained",
      );
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "关于", exact: true }),
    ).toBeFocused();
  } finally {
    await app.close();
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
});
