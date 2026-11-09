import "./production-host.mjs";
import { dialog } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
globalThis.setupDirectoryFixture = async () => {
  const root = globalThis.isolatedAppData;
  const source = join(root, "source"),
    target = join(root, "target");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await mkdir(join(source, "资料"), { recursive: true });
  await writeFile(join(source, "资料", "empty.txt"), "");
  await writeFile(
    join(source, "message.txt"),
    "StorageLab directory real SDK / IPC / disk\n",
  );
  globalThis.directoryPickerPath = source;
  dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [globalThis.directoryPickerPath],
  });
  dialog.showSaveDialog = async () => ({
    canceled: false,
    filePath: join(root, "delivery.json"),
  });
  return { root, source, target };
};
