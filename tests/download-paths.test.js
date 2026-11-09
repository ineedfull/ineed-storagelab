import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  symlink,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateDownloadKeys,
  downloadObject,
} from "../electron/transfers/download.js";
test("portable path mapping rejects traversal, special components and collisions", () => {
  for (const keys of [
    ["../x"],
    ["a\\b"],
    ["CON.txt"],
    ["a."],
    ["a//b"],
    ["A", "a"],
    ["a", "a/b"],
  ])
    assert.throws(() => validateDownloadKeys(keys));
  assert.deepEqual(validateDownloadKeys(["中文/a.txt"]), ["中文/a.txt"]);
});
test("download verifies truncation and cleans temporary files; no overwrite is exclusive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sl-path-"));
  try {
    const client = {
      send: async () => ({
        ContentLength: 5,
        Body: (async function* () {
          yield Buffer.from("xx");
        })(),
      }),
    };
    await assert.rejects(
      downloadObject({
        client,
        bucket: "b",
        key: "a",
        directory: dir,
        overwrite: false,
        signal: new AbortController().signal,
        onProgress() {},
      }),
    );
    assert.deepEqual(await readdir(dir), []);
    client.send = async () => ({
      ContentLength: 2,
      Body: (async function* () {
        yield Buffer.from("ok");
      })(),
    });
    await downloadObject({
      client,
      bucket: "b",
      key: "a",
      directory: dir,
      overwrite: false,
      signal: new AbortController().signal,
      onProgress() {},
    });
    await assert.rejects(
      downloadObject({
        client,
        bucket: "b",
        key: "a",
        directory: dir,
        overwrite: false,
        signal: new AbortController().signal,
        onProgress() {},
      }),
    );
    assert.equal(await readFile(join(dir, "a"), "utf8"), "ok");
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(dir, "link"));
    await assert.rejects(
      downloadObject({
        client,
        bucket: "b",
        key: "link/a",
        directory: dir,
        overwrite: false,
        signal: new AbortController().signal,
        onProgress() {},
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("download refuses an existing case alias without changing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sl-case-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "A.txt"), "original");
    const client = {
      send: async () => ({
        ContentLength: 2,
        Body: (async function* () {
          yield Buffer.from("ok");
        })(),
      }),
    };
    await assert.rejects(
      downloadObject({
        client,
        bucket: "b",
        key: "a.txt",
        directory: dir,
        overwrite: true,
        signal: new AbortController().signal,
        onProgress() {},
      }),
      { code: "DOWNLOAD_COLLISION" },
    );
    assert.equal(await readFile(join(dir, "A.txt"), "utf8"), "original");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("exclusive completion survives a concurrent writer; disconnect and cancel remove partial files", async () => {
  const { writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "sl-race-"));
  try {
    const target = join(dir, "race");
    let client = {
      send: async () => ({
        ContentLength: 2,
        Body: (async function* () {
          yield Buffer.from("ok");
          await writeFile(target, "concurrent");
        })(),
      }),
    };
    await assert.rejects(
      downloadObject({
        client,
        bucket: "b",
        key: "race",
        directory: dir,
        overwrite: false,
        signal: new AbortController().signal,
        onProgress() {},
      }),
    );
    assert.equal(await readFile(target, "utf8"), "concurrent");
    client = {
      send: async () => ({
        ContentLength: 9,
        Body: (async function* () {
          yield Buffer.from("part");
          throw Object.assign(new Error("private endpoint"), {
            code: "ECONNRESET",
          });
        })(),
      }),
    };
    await assert.rejects(
      downloadObject({
        client,
        bucket: "b",
        key: "disconnect",
        directory: dir,
        overwrite: false,
        signal: new AbortController().signal,
        onProgress() {},
      }),
    );
    const controller = new AbortController();
    client = {
      send: async () => ({
        ContentLength: 9,
        Body: (async function* () {
          yield Buffer.from("part");
          yield Buffer.from("rest!");
        })(),
      }),
    };
    await assert.rejects(
      downloadObject({
        client,
        bucket: "b",
        key: "cancel",
        directory: dir,
        overwrite: false,
        signal: controller.signal,
        onProgress() {
          controller.abort();
        },
      }),
    );
    assert.deepEqual(await readdir(dir), ["race"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
