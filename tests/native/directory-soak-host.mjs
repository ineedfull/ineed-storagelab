// Test-only native picker and data isolation; real production composition/IPC.
import { app, dialog } from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = process.env.STORAGELAB_DIRECTORY_SOAK_ROOT;
if (!root || !root.startsWith(join(tmpdir(), "storagelab-directory-soak-")))
  throw new Error("Explicit generated temporary test root required");
app.setPath("appData", root);
globalThis.directoryPickerPath = join(root, "source");
globalThis.directoryManifestPath = join(root, "manifest.json");
dialog.showOpenDialog = async () => ({
  canceled: false,
  filePaths: [globalThis.directoryPickerPath],
});
dialog.showSaveDialog = async () => ({
  canceled: false,
  filePath: globalThis.directoryManifestPath,
});
globalThis.directorySoakIdentity = () => ({
  root,
  userData: app.getPath("userData"),
  pid: process.pid,
});
import("../../electron/main.js");
