import test from "node:test";
import assert from "node:assert/strict";
import { registerIpc, validatePayload } from "../electron/ipc.js";
test("IPC refuses unknown methods, untrusted main frames and malformed payloads, sanitizes failures", async () => {
  let handler;
  const ipcMain = { handle: (c, h) => (handler = h), removeHandler: () => {} };
  registerIpc({
    ipcMain,
    trustedUrl: "file:///trusted/index.html",
    getWebContents: () => ({ id: 1 }),
    dispatch: async () => {
      throw Error("SQL secret");
    },
  });
  const frame = { url: "file:///trusted/index.html" };
  const event = { sender: { id: 1 }, senderFrame: frame };
  event.sender.mainFrame = frame;
  assert.equal(
    (await handler(event, "unknown", {})).error.code,
    "UNKNOWN_METHOD",
  );
  assert.equal(
    (
      await handler(
        { ...event, senderFrame: { url: "https://evil" } },
        "bootstrap",
        {},
      )
    ).error.code,
    "UNTRUSTED_SENDER",
  );
  assert.equal(
    (await handler(event, "bootstrap", [])).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await handler(event, "bootstrap", {})).error.message.includes("secret"),
    false,
  );
});
test("IPC checks sender identity and rejects excessive counts and unsafe paths", async () => {
  let handler;
  const ipcMain = { handle: (_c, h) => (handler = h), removeHandler: () => {} };
  const dispose = registerIpc({
    ipcMain,
    trustedUrl: "file:///trusted/index.html",
    getWebContents: () => ({ id: 1 }),
    dispatch: async () => true,
  });
  const frame = { url: "file:///trusted/index.html" };
  const event = { sender: { id: 1, mainFrame: frame }, senderFrame: frame };
  assert.equal(
    (
      await handler(
        { ...event, sender: { id: 2, mainFrame: frame } },
        "bootstrap",
        {},
      )
    ).error.code,
    "UNTRUSTED_SENDER",
  );
  assert.equal(
    (
      await handler(event, "downloadFiles", {
        connectionId: "a",
        bucket: "b",
        keys: Array(201).fill("x"),
      })
    ).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (
      await handler(event, "uploadFiles", {
        connectionId: "a",
        bucket: "b",
        path: "/tmp/secret",
      })
    ).error.code,
    "INVALID_INPUT",
  );
  assert.deepEqual(await handler(event, "bootstrap", {}), {
    ok: true,
    value: true,
  });
  dispose();
});

test("raw object keys retain whitespace in singular and array methods", () => {
  for (const key of [" ", "\t\n", " folder/../a\\b "]) {
    for (const method of ["headObject", "previewObject", "shareObject"]) {
      const payload = {
        connectionId: "a",
        bucket: "b",
        key,
        kind: "signed",
        expiresIn: 900,
      };
      assert.equal(validatePayload(method, payload).key, key);
    }
    for (const method of ["deleteObjects", "downloadFiles"]) {
      const payload = { connectionId: "a", bucket: "b", keys: [key] };
      assert.deepEqual(validatePayload(method, payload).keys, [key]);
    }
  }
  for (const key of ["", "a\0b", "x".repeat(1025), 1, {}]) {
    assert.throws(
      () =>
        validatePayload("headObject", { connectionId: "a", bucket: "b", key }),
      { code: "INVALID_INPUT" },
    );
    assert.throws(
      () =>
        validatePayload("deleteObjects", {
          connectionId: "a",
          bucket: "b",
          keys: [key],
        }),
      { code: "INVALID_INPUT" },
    );
  }
});
test("checkConnection validates supplied optional bucket", () => {
  assert.deepEqual(validatePayload("checkConnection", { connectionId: "a" }), {
    connectionId: "a",
  });
  assert.equal(
    validatePayload("checkConnection", {
      connectionId: "a",
      bucket: "valid-bucket",
    }).bucket,
    "valid-bucket",
  );
  for (const bucket of [1, {}, "a\0b", "x".repeat(256), ""]) {
    assert.throws(
      () => validatePayload("checkConnection", { connectionId: "a", bucket }),
      { code: "INVALID_INPUT" },
    );
  }
});
