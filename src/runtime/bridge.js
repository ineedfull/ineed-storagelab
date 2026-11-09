import { AppError } from "../domain/errors.js";
import { DEFAULT_SETTINGS } from "../domain/settings.js";
export function createBridge(native = globalThis.window?.storageLab) {
  return {
    async invoke(method, payload = {}) {
      let envelope;
      if (native)
        envelope = await native.invoke(
          method,
          JSON.parse(JSON.stringify(payload)),
        );
      else if (method === "bootstrap")
        envelope = {
          ok: true,
          value: {
            connections: [],
            settings: { ...DEFAULT_SETTINGS },
            jobs: [],
            app: {
              name: "StorageLab",
              version: __APP_VERSION__,
              runtime: "Browser preview",
              dataDirectory: "不可用（浏览器预览）",
              native: false,
              vaultAvailable: false,
            },
          },
        };
      else
        envelope = {
          ok: false,
          error: {
            code: "NATIVE_REQUIRED",
            message: "浏览器仅供外观预览，请使用 StorageLab 桌面应用。",
          },
        };
      if (!envelope.ok)
        throw new AppError(envelope.error.code, envelope.error.message);
      return envelope.value;
    },
    onChange(callback) {
      return native?.onChange(callback) ?? (() => {});
    },
  };
}
export const bridge = createBridge();
