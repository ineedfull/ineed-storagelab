import test from "node:test";
import assert from "node:assert/strict";
import { createVault } from "../electron/vault.js";
test("vault refuses unavailable and basic_text backends without silent fallback", () => {
  for (const safeStorage of [
    { isEncryptionAvailable: () => false },
    {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
    },
  ]) {
    const v = createVault({ safeStorage });
    assert.equal(v.available, false);
    assert.throws(() => v.encrypt({ secretAccessKey: "secret" }));
  }
});
test("vault encrypts and decrypts only using safeStorage", () => {
  const v = createVault({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from("cipher:" + s),
      decryptString: (b) => b.toString().slice(7),
    },
  });
  assert.deepEqual(
    v.decrypt(v.encrypt({ accessKeyId: "a", secretAccessKey: "s" })),
    { accessKeyId: "a", secretAccessKey: "s" },
  );
});
