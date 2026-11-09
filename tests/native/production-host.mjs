// Test-only appData isolation. Imports the real unchanged production composition.
import { app } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const isolated = mkdtempSync(join(tmpdir(), "storagelab-production-smoke-"));
app.setPath("appData", isolated);
globalThis.isolatedAppData = isolated;
import("../../electron/main.js");
// Generated sentinel only: no user keychain enumeration or production credentials.
globalThis.verifyNativeVault = async () => {
  const { safeStorage } = await import("electron");
  const { randomBytes } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const { createStore } = await import("../../electron/store.js");
  const { createVault } = await import("../../electron/vault.js");
  const vault = createVault({ safeStorage });
  if (!vault.available) return { available: false };
  const directory = join(isolated, "vault-roundtrip");
  const credentials = {
    accessKeyId: randomBytes(20).toString("hex"),
    secretAccessKey: randomBytes(32).toString("hex"),
  };
  let store = createStore({ directory, vault });
  try {
    const profile = store.saveConnection({
      connection: {
        name: "Generated vault test",
        provider: "minio",
        endpoint: "http://127.0.0.1:1",
      },
      credentials,
      credentialStorage: "encrypted",
    });
    store.close();
    store = createStore({ directory, vault });
    const restored = store.getCredentials(profile.id);
    const correct = restored.secretAccessKey === credentials.secretAccessKey;
    const publicSafe = !JSON.stringify(store.snapshot()).includes(
      credentials.secretAccessKey,
    );
    const bytes = await readFile(join(directory, "storagelab.sqlite"));
    const encrypted = !bytes.includes(Buffer.from(credentials.secretAccessKey));
    store.removeConnection(profile.id);
    return { available: true, correct, publicSafe, encrypted };
  } finally {
    store.close();
  }
};
