const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "storageLab",
  Object.freeze({
    invoke: (method, payload = {}) =>
      ipcRenderer.invoke("storagelab:invoke", method, payload),
    onChange(callback) {
      if (typeof callback !== "function")
        throw new TypeError("callback required");
      const listener = () => callback();
      ipcRenderer.on("storagelab:change", listener);
      return () => ipcRenderer.removeListener("storagelab:change", listener);
    },
  }),
);
