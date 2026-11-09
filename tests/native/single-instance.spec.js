import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";

test("duplicate launch restores primary without recovering its running jobs; clean restart still recovers", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "storagelab-single-instance-"),
  );
  const executablePath = await prepareElectronExecutable();
  const args = ["tests/native/single-instance-host.mjs"];
  const env = { ...process.env, STORAGELAB_INSTANCE_TEST_DIRECTORY: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  let primary, duplicate;
  try {
    primary = await electron.launch({ executablePath, args, env });
    await primary.firstWindow();
    await primary.evaluate(({ BrowserWindow }) => {
      globalThis.seedRunningJob();
      BrowserWindow.getAllWindows()[0].minimize();
    });
    duplicate = spawn(executablePath, args, { env, stdio: "ignore" });
    const exited = new Promise((resolve) =>
      duplicate.once("exit", (code) => resolve(code)),
    );
    let timer;
    const code = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("still-running"), 5000);
      }),
    ]);
    clearTimeout(timer);
    expect(code).toBe(0);
    await expect
      .poll(() =>
        primary.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows()[0];
          return w.isVisible() && !w.isMinimized();
        }),
      )
      .toBe(true);
    const state = () => primary.evaluate(() => globalThis.runningJobState());
    expect(await state()).toBe("running");
    await primary.close();
    primary = await electron.launch({ executablePath, args, env });
    await primary.firstWindow();
    expect(await state()).toBe("interrupted");
  } finally {
    if (duplicate && duplicate.exitCode === null) duplicate.kill("SIGKILL");
    await primary?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
