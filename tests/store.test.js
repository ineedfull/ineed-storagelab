import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../electron/store.js";
import { createVault } from "../electron/vault.js";
const vault = createVault({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s).map((b) => b ^ 42),
    decryptString: (b) =>
      Buffer.from(b)
        .map((b) => b ^ 42)
        .toString(),
  },
});
const credentials = {
  accessKeyId: "ACCESS_SECRET_TEST",
  secretAccessKey: "LONG_SECRET_TEST",
};
const connection = {
  name: "local",
  provider: "minio",
  endpoint: "http://localhost:9000",
};
test("encrypted reopen, retained edits, active locks, interrupted recovery and credential-free snapshots", () => {
  const directory = mkdtempSync(join(tmpdir(), "storagelab-"));
  try {
    let s = createStore({ directory, vault });
    const c = s.saveConnection({
      connection,
      credentials,
      credentialStorage: "encrypted",
    });
    assert.equal(c.hasCredentials, true);
    assert.equal(JSON.stringify(s.snapshot()).includes("SECRET_TEST"), false);
    s.saveConnection({
      connection: { ...c, name: "edit" },
      credentialStorage: "encrypted",
    });
    assert.deepEqual(s.getCredentials(c.id), credentials);
    s.saveJob({ id: "j", connectionId: c.id, state: "queued" });
    assert.throws(() => s.removeConnection(c.id));
    s.close();
    assert.equal(
      readFileSync(join(directory, "storagelab.sqlite")).includes(
        Buffer.from("LONG_SECRET_TEST"),
      ),
      false,
    );
    s = createStore({ directory, vault });
    assert.equal(s.snapshot().jobs[0].state, "interrupted");
    assert.deepEqual(s.getCredentials(c.id), credentials);
    s.removeConnection(c.id);
    assert.equal(s.snapshot().connections.length, 0);
    s.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("session credentials never survive restart; failed edits roll back", () => {
  const directory = mkdtempSync(join(tmpdir(), "storagelab-"));
  try {
    let s = createStore({ directory, vault });
    const c = s.saveConnection({
      connection,
      credentials,
      credentialStorage: "session",
    });
    assert.throws(() =>
      s.saveConnection({
        connection: { ...c, name: "broken" },
        credentials: { accessKeyId: "only" },
        credentialStorage: "encrypted",
      }),
    );
    assert.equal(s.snapshot().connections[0].name, "local");
    s.close();
    s = createStore({ directory, vault });
    assert.equal(s.snapshot().connections[0].hasCredentials, false);
    assert.equal(s.getCredentials(c.id), undefined);
    s.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("SQLite failure rolls deletion back including encrypted credential row", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = mkdtempSync(join(tmpdir(), "storagelab-"));
  try {
    const s = createStore({ directory, vault });
    const c = s.saveConnection({
      connection,
      credentials,
      credentialStorage: "encrypted",
    });
    const db = new DatabaseSync(join(directory, "storagelab.sqlite"));
    db.exec(
      "CREATE TRIGGER reject_delete BEFORE DELETE ON connections BEGIN SELECT RAISE(ABORT, 'secret SQL details'); END",
    );
    assert.throws(
      () => s.removeConnection(c.id),
      (error) =>
        error.code === "PERSISTENCE_ERROR" && !error.message.includes("SQL"),
    );
    assert.deepEqual(s.getCredentials(c.id), credentials);
    assert.equal(s.getConnection(c.id).name, "local");
    db.exec("DROP TRIGGER reject_delete");
    db.close();
    s.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("history is bounded, active profiles remain locked and public jobs reject raw error values", () => {
  const directory = mkdtempSync(join(tmpdir(), "storagelab-"));
  try {
    const s = createStore({ directory, vault });
    assert.throws(() =>
      s.saveJob({ id: "unsafe", state: "failed", error: new Error("secret") }),
    );
    for (let i = 0; i < 205; i++) s.saveJob({ id: `j${i}`, state: "success" });
    assert.equal(s.listJobs().length, 200);
    const c = s.saveConnection({
      connection,
      credentials,
      credentialStorage: "session",
    });
    const release = s.lockConnection(c.id);
    assert.throws(() => s.removeConnection(c.id));
    release();
    release();
    assert.equal(s.removeConnection(c.id), true);
    s.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("credential mode transitions commit atomically and preserve old session on SQL failure", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = mkdtempSync(join(tmpdir(), "storagelab-"));
  try {
    const s = createStore({ directory, vault });
    let c = s.saveConnection({
      connection,
      credentials,
      credentialStorage: "session",
    });
    const db = new DatabaseSync(join(directory, "storagelab.sqlite"));
    db.exec(
      "CREATE TRIGGER reject_update BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'failed'); END",
    );
    assert.throws(() =>
      s.saveConnection({
        connection: { ...c, name: "new" },
        credentialStorage: "encrypted",
      }),
    );
    assert.deepEqual(s.getCredentials(c.id), credentials);
    assert.equal(s.getConnection(c.id).credentialStorage, "session");
    db.exec("DROP TRIGGER reject_update");
    c = s.saveConnection({ connection: c, credentialStorage: "encrypted" });
    assert.deepEqual(s.getCredentials(c.id), credentials);
    c = s.saveConnection({ connection: c, credentialStorage: "session" });
    assert.deepEqual(s.getCredentials(c.id), credentials);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM credentials").get().n,
      0,
    );
    db.close();
    s.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
