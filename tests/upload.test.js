import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadObject } from "../electron/transfers/upload.js";

test("real SDK Upload aborts once and preserves original multipart transfer failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "storagelab-abort-"));
  try {
    const path = join(directory, "multipart.bin");
    await writeFile(path, Buffer.alloc(9 * 1024 * 1024));
    let aborts = 0;
    const original = Object.assign(new Error("private transfer details"), {
      name: "AccessDenied",
    });
    const client = {
      config: { requestChecksumCalculation: async () => "WHEN_REQUIRED" },
      async send(command) {
        switch (command.constructor.name) {
          case "CreateMultipartUploadCommand":
            return { UploadId: "owned-upload" };
          case "UploadPartCommand":
            throw original;
          case "AbortMultipartUploadCommand":
            aborts++;
            assert.equal(command.input.UploadId, "owned-upload");
            if (aborts > 1)
              throw Object.assign(new Error(), { name: "NoSuchUpload" });
            return {};
          default:
            throw new Error("Unexpected command");
        }
      },
    };
    await assert.rejects(
      uploadObject({
        client,
        bucket: "b",
        key: "k",
        path,
        overwrite: true,
        signal: new AbortController().signal,
        onProgress() {},
      }),
      (error) => error === original,
    );
    assert.equal(aborts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("confirmed NoSuchUpload means cleanup already complete and preserves transfer failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "storagelab-absent-"));
  try {
    const path = join(directory, "multipart.bin");
    await writeFile(path, Buffer.alloc(9 * 1024 * 1024));
    let aborts = 0;
    const original = Object.assign(new Error(), { name: "AccessDenied" });
    const client = {
      config: { requestChecksumCalculation: async () => "WHEN_REQUIRED" },
      async send(command) {
        switch (command.constructor.name) {
          case "CreateMultipartUploadCommand":
            return { UploadId: "owned-upload" };
          case "UploadPartCommand":
            throw original;
          case "AbortMultipartUploadCommand":
            aborts++;
            throw Object.assign(new Error(), { name: "NoSuchUpload" });
          default:
            throw new Error("Unexpected command");
        }
      },
    };
    await assert.rejects(
      uploadObject({
        client,
        bucket: "b",
        key: "k",
        path,
        overwrite: true,
        signal: new AbortController().signal,
        onProgress() {},
      }),
      (error) => error === original,
    );
    assert.equal(aborts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
