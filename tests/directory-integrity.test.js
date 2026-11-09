import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { downloadObject } from "../electron/transfers/download.js";
const api = await import("../electron/transfers/integrity.js").catch(
  () => ({}),
);
const sha = (data) => createHash("sha256").update(data).digest("hex");
test("full-file and remote SHA-256 use complete bytes and reject declared length mismatch", async () => {
  assert.equal(
    typeof api.hashFile,
    "function",
    "content integrity hashing is required",
  );
  const root = await mkdtemp(join(tmpdir(), "sl-hash-"));
  try {
    const path = join(root, "a");
    await writeFile(path, "hello");
    assert.equal(await api.hashFile(path, {}), sha("hello"));
    const client = {
      send: async (c) => {
        assert.equal(c.input.IfMatch, '"snapshot"');
        return {
          ContentLength: 5,
          Body: (async function* () {
            yield Buffer.from("hel");
            yield Buffer.from("lo");
          })(),
        };
      },
    };
    assert.equal(
      await api.hashRemote(client, {
        bucket: "b",
        key: "k",
        size: 5,
        etag: '"snapshot"',
      }),
      sha("hello"),
    );
    await assert.rejects(
      api.hashRemote(client, {
        bucket: "b",
        key: "k",
        size: 6,
        etag: '"snapshot"',
      }),
      { code: "INTEGRITY_MISMATCH" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("directory download keeps remote key but maps relative local path and returns full-stream digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "sl-dir-get-"));
  try {
    const client = {
      send: async (c) => {
        assert.equal(c.input.Key, "release/sub/a");
        assert.equal(c.input.IfMatch, '"a"');
        return {
          ContentLength: 2,
          Body: (async function* () {
            yield Buffer.from("ok");
          })(),
        };
      },
    };
    const result = await downloadObject({
      client,
      bucket: "b",
      key: "release/sub/a",
      localKey: "sub/a",
      ifMatch: '"a"',
      verifyIntegrity: true,
      directory: root,
      overwrite: false,
      signal: new AbortController().signal,
      onProgress() {},
    });
    assert.equal(result.sha256, sha("ok"));
    assert.equal(await readFile(join(root, "sub/a"), "utf8"), "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
