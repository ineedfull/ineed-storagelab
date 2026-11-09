import test from "node:test";
import assert from "node:assert/strict";
import { createS3Operations } from "../electron/s3/operations.js";
const connection = {
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true,
  publicBaseUrl: "https://cdn.example/base",
};
function fixture(handler) {
  return createS3Operations({ client: { send: handler }, connection });
}
test("listing preserves raw keys and bounded page/cursor", async () => {
  const s = fixture(async (c) => {
    assert.equal(c.input.MaxKeys, 200);
    assert.equal(c.input.ContinuationToken, "raw/+");
    return {
      Contents: [{ Key: "../中文\\ a", Size: 2 }],
      CommonPrefixes: [{ Prefix: "a/" }],
      NextContinuationToken: "next",
    };
  });
  assert.deepEqual(
    await s.listObjects({ bucket: "test", prefix: "../", cursor: "raw/+" }),
    {
      objects: [
        {
          key: "../中文\\ a",
          size: 2,
          lastModified: undefined,
          etag: undefined,
          storageClass: undefined,
        },
      ],
      prefixes: ["a/"],
      nextCursor: "next",
    },
  );
});
test("preview enforces actual stream length after dishonest HEAD", async () => {
  const s = fixture(async (c) =>
    c.constructor.name === "HeadObjectCommand"
      ? { ContentLength: 1, ContentType: "text/plain" }
      : {
          Body: (async function* () {
            yield Buffer.alloc(2 * 1024 * 1024 + 1);
          })(),
        },
  );
  await assert.rejects(s.previewObject({ bucket: "test", key: "x" }), {
    code: "PREVIEW_TOO_LARGE",
  });
});
test("public share preserves encoding and refuses dot segments", async () => {
  const s = fixture(async () => ({}));
  assert.equal(
    (await s.shareObject({ bucket: "test", key: "中文 a/+?#", kind: "public" }))
      .url,
    "https://cdn.example/base/%E4%B8%AD%E6%96%87%20a/%2B%3F%23",
  );
  await assert.rejects(
    s.shareObject({ bucket: "test", key: "a/../b", kind: "public" }),
    { code: "UNSAFE_PUBLIC_KEY" },
  );
});
test("SDK error strings are redacted into distinct permission/network/unsupported/not-found failures", async () => {
  for (const [name, code] of [
    ["AccessDenied", "ACCESS_DENIED"],
    ["NotImplemented", "UNSUPPORTED"],
    ["NoSuchKey", "NOT_FOUND"],
    ["TimeoutError", "NETWORK_ERROR"],
    ["WeirdVendorError", "STORAGE_ERROR"],
  ]) {
    const s = fixture(async () => {
      throw Object.assign(new Error("secret signed query private key"), {
        name,
      });
    });
    await assert.rejects(
      s.listBuckets(),
      (e) => e.code === code && !e.message.includes("secret"),
    );
  }
});
