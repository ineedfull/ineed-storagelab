// Test-only setup around the real production main, service and IPC.
import "./production-host.mjs";
import { app, dialog, shell } from "electron";
import { join, basename } from "node:path";
import { realpath, lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { createService } from "../../electron/service.js";
import { createStore } from "../../electron/store.js";

globalThis.setupTaskFiles = async () => {
  const path = join(
    await realpath(globalThis.isolatedAppData),
    `StorageLab-task-test-${randomUUID()}.txt`,
  );
  globalThis.taskTestPath = path;
  globalThis.taskTestCalls = [];
  globalThis.taskTestConfirmation = { response: 1, checkboxChecked: false };
  const store = createStore({
    directory: app.getPath("userData"),
    vault: {},
  });
  const profile = store.saveConnection({
    connection: {
      name: "隔离任务测试",
      provider: "minio",
      endpoint: "http://127.0.0.1:1",
    },
    credentialStorage: "session",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  });
  // S3 data is a fixture; the native picker result, download stream, final
  // installation and SQLite path capture all go through the production service.
  const content = "StorageLab isolated task file action test\n";
  const downloadService = createService({
    store,
    app,
    shell,
    dialog: {
      showOpenDialog: async () => ({
        filePaths: [await realpath(globalThis.isolatedAppData)],
      }),
    },
    clientFactory: () => ({
      destroy() {},
      send: async () => ({
        Body: Readable.from([content]),
        ContentLength: Buffer.byteLength(content),
      }),
    }),
  });
  try {
    const {
      jobs: [job],
    } = await downloadService.invoke("downloadFiles", {
      connectionId: profile.id,
      bucket: "test",
      keys: [basename(path)],
    });
    globalThis.taskTestId = job.id;
    for (let i = 0; i < 100; i++) {
      const row = (await downloadService.invoke("listJobs")).find(
        (j) => j.id === job.id,
      );
      if (row?.state === "success") break;
      if (row?.state === "failed")
        throw new Error("isolated native download failed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const row = (await downloadService.invoke("listJobs")).find(
      (j) => j.id === job.id,
    );
    if (
      row?.state !== "success" ||
      !row.hasLocalFile ||
      store.getJobFile(job.id)?.path !== path
    )
      throw new Error("download did not persist its actual local path");
  } finally {
    await downloadService.dispose();
    store.close();
  }
  // Only native confirmation choices are automated. Production IPC, service,
  // path validation and OS file APIs remain real.
  dialog.showMessageBox = async (options) => {
    globalThis.taskTestCalls.push({
      method: "confirm",
      defaultUnchecked: options.checkboxChecked === false,
      hasCheckbox: Boolean(options.checkboxLabel),
    });
    return globalThis.taskTestConfirmation;
  };
  for (const method of ["openPath", "showItemInFolder", "trashItem"]) {
    const original = shell[method].bind(shell);
    shell[method] = (...args) => {
      globalThis.taskTestCalls.push({
        method,
        boundPath: args[0] === path,
      });
      return original(...args);
    };
  }
};
globalThis.inspectTaskFiles = async () => ({
  calls: globalThis.taskTestCalls,
  exists: await lstat(globalThis.taskTestPath).then(
    () => true,
    () => false,
  ),
});
globalThis.cleanupTaskFiles = async () => {
  if (!globalThis.taskTestPath || process.platform !== "darwin") return;
  const name = basename(globalThis.taskTestPath);
  await new Promise((resolve) =>
    execFile(
      "/usr/bin/osascript",
      [
        "-e",
        `if application "TextEdit" is running then\ntell application "TextEdit"\nif exists document "${name}" then close document "${name}" saving no\nend tell\nend if`,
      ],
      { timeout: 5000 },
      () => resolve(),
    ),
  );
  // Exact generated file name only; leave every other Trash item alone.
  await unlink(join(app.getPath("home"), ".Trash", name)).catch(() => {});
};

globalThis.removeTaskTestFile = () => unlink(globalThis.taskTestPath);
