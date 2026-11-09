import { fail } from "../src/domain/errors.js";
export function createVault({ safeStorage }) {
  const available = () =>
    Boolean(
      safeStorage?.isEncryptionAvailable() &&
      safeStorage?.getSelectedStorageBackend?.() !== "basic_text",
    );
  return {
    get available() {
      return available();
    },
    encrypt(credentials) {
      if (!available())
        fail(
          "VAULT_UNAVAILABLE",
          "系统安全凭证存储不可用，请明确选择会话模式。",
        );
      try {
        return safeStorage.encryptString(JSON.stringify(credentials));
      } catch {
        fail("VAULT_ERROR", "凭证加密失败。");
      }
    },
    decrypt(blob) {
      if (!available()) fail("VAULT_UNAVAILABLE", "系统安全凭证存储不可用。");
      try {
        return JSON.parse(safeStorage.decryptString(Buffer.from(blob)));
      } catch {
        fail("VAULT_ERROR", "凭证解密失败，请重新填写。");
      }
    },
  };
}
