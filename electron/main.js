import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  clipboard,
  shell,
  dialog,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createVault } from "./vault.js";
import { createStore } from "./store.js";
import { registerIpc, createChangeNotifier, CHANGE_CHANNEL } from "./ipc.js";
import { createService } from "./service.js";
const root = dirname(fileURLToPath(import.meta.url));
app.setName("StorageLab");
app.setAppUserModelId("com.ineedfull.storagelab");
app.setPath(
  "userData",
  join(app.getPath("appData"), "com.ineedfull.storagelab"),
);
let window, store, disposeIpc, notifier;
// Take ownership before opening SQLite: startup recovery mutates active jobs.
const primaryInstance = app.requestSingleInstanceLock();
let revealRequested = false;
function revealWindow() {
  if (!window || window.isDestroyed()) {
    revealRequested = true;
    return;
  }
  revealRequested = false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
if (!primaryInstance) app.quit();
else app.on("second-instance", revealWindow);
const exitHooks = new Set();
let exiting = false;
/** Native services register bounded abort/cleanup here; hooks must return promises. */
export function registerExitHook(hook) {
  exitHooks.add(hook);
  return () => exitHooks.delete(hook);
}
if (primaryInstance)
  app
    .whenReady()
    .then(async () => {
      const vault = createVault({ safeStorage });
      store = createStore({ directory: app.getPath("userData"), vault });
      const devUrl = process.env.STORAGELAB_DEV_URL;
      if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(devUrl))
        throw new Error("Invalid local development URL");
      const trustedUrl =
        devUrl ?? pathToFileURL(join(root, "../dist/index.html")).href;
      window = new BrowserWindow({
        title: "StorageLab",
        width: 1440,
        height: 900,
        minWidth: 920,
        minHeight: 620,
        webPreferences: {
          preload: join(root, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-redirect", (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      notifier = createChangeNotifier(() => {
        if (!window.isDestroyed()) window.webContents.send(CHANGE_CHANNEL);
      });
      const service = createService({
        store,
        dialog,
        clipboard,
        shell,
        app,
        vaultAvailable: () => vault.available,
      });
      service.onChange(() => notifier.notify());
      registerExitHook(() => service.dispose());
      disposeIpc = registerIpc({
        ipcMain,
        trustedUrl,
        getWebContents: () => window?.webContents,
        dispatch: service.invoke,
      });
      await window.loadURL(trustedUrl);
      if (revealRequested) revealWindow();
      app.on("window-all-closed", () => app.quit());
      app.on("before-quit", (event) => {
        if (exiting) return;
        event.preventDefault();
        exiting = true;
        Promise.race([
          Promise.allSettled(
            [...exitHooks].map((hook) => Promise.resolve().then(hook)),
          ),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]).finally(() => {
          notifier?.dispose();
          disposeIpc?.();
          store?.close();
          app.quit();
        });
      });
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
