import { test, expect, _electron as electron } from "@playwright/test";
import { rm } from "node:fs/promises";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";

test("production task IPC performs native file handoff and confirmed trash in isolated appData", async ({}, info) => {
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/task-actions-host.mjs"],
  });
  let isolated;
  try {
    isolated = await app.evaluate(() => globalThis.isolatedAppData);
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "新建连接", exact: true }),
    ).toBeEnabled();
    await app.evaluate(() => globalThis.setupTaskFiles());
    await page.reload();
    await page.getByRole("button", { name: /任务中心 \(/ }).click();
    const card = page.locator(".job");
    await card
      .getByRole("button", { name: "打开本地文件", exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: "打开本地文件", exact: true }),
    ).toBeEnabled();
    await card
      .getByRole("button", { name: "打开所在目录", exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: "打开所在目录", exact: true }),
    ).toBeEnabled();
    await card
      .getByRole("button", { name: "删除任务记录", exact: true })
      .click();
    await expect(card).toHaveCount(1);
    await app.evaluate(() => {
      globalThis.taskTestConfirmation = { response: 0, checkboxChecked: true };
    });
    await card
      .getByRole("button", { name: "删除任务记录", exact: true })
      .click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
      "本地文件已移到回收站",
    );
    const result = await app.evaluate(() => globalThis.inspectTaskFiles());
    expect(result.exists).toBe(false);
    expect(result.calls.filter((c) => c.method !== "confirm")).toEqual([
      { method: "openPath", boundPath: true },
      { method: "showItemInFolder", boundPath: true },
      { method: "trashItem", boundPath: true },
    ]);
    expect(
      result.calls
        .filter((c) => c.method === "confirm")
        .every((c) => c.defaultUnchecked && c.hasCheckbox),
    ).toBe(true);
    await expect(page.getByRole("alert")).toHaveCount(0);
    const forged = await page.evaluate(() =>
      window.storageLab.invoke("openJobFile", {
        id: "native-task-file",
        path: "/tmp/forged",
      }),
    );
    expect(forged.ok).toBe(false);
    await page.screenshot({ path: info.outputPath("native-task-files.png") });
  } finally {
    // Close only the generated test document, if the user's default app is TextEdit.
    await app.evaluate(() => globalThis.cleanupTaskFiles()).catch(() => {});
    await app.close();
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
});

test("native task refresh checks the saved download location after the file is removed", async () => {
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/task-actions-host.mjs"],
  });
  let isolated;
  try {
    isolated = await app.evaluate(() => globalThis.isolatedAppData);
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "新建连接", exact: true }),
    ).toBeEnabled();
    await app.evaluate(() => globalThis.setupTaskFiles());
    await page.reload();
    await page.getByRole("button", { name: /任务中心 \(/ }).click();
    const card = page.locator(".job");
    await expect(
      card.getByRole("button", { name: "打开本地文件", exact: true }),
    ).toBeEnabled();
    await app.evaluate(() => globalThis.removeTaskTestFile());
    await page.getByRole("button", { name: "刷新任务", exact: true }).click();
    await expect(card).toContainText("本地文件已不存在");
    await expect(
      card.getByRole("button", { name: "打开本地文件", exact: true }),
    ).toBeDisabled();
    await expect(
      card.getByRole("button", { name: "打开所在目录", exact: true }),
    ).toBeDisabled();
    await app.evaluate(() => {
      globalThis.taskTestConfirmation = { response: 0, checkboxChecked: true };
    });
    await card
      .getByRole("button", { name: "删除任务记录", exact: true })
      .click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("本地文件已不存在");
    const state = await app.evaluate(() => globalThis.inspectTaskFiles());
    expect(state.calls).toEqual([
      { method: "confirm", defaultUnchecked: false, hasCheckbox: false },
    ]);
  } finally {
    await app.evaluate(() => globalThis.cleanupTaskFiles()).catch(() => {});
    await app.close();
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
});
