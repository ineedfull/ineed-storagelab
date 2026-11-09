import test from "node:test";
import assert from "node:assert/strict";
import { createTosClient } from "../electron/providers/tos.js";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
test("native TOS preserves opaque listing inputs and normalizes scalars", async () => {
  let call;
  const c = createTosClient(
    { endpoint: "https://tos-cn-beijing.volces.com", region: "cn-beijing" },
    { accessKeyId: "a", secretAccessKey: "b" },
    {},
    {
      sdkFactory: () => ({
        fetch: async (...args) => {
          call = args;
          return {
            statusCode: 200,
            headers: {},
            data: {
              Contents: [{ Key: "a/../b", Size: "3" }],
              IsTruncated: "false",
              NextContinuationToken: "0+/=",
            },
          };
        },
      }),
    },
  );
  const r = await c.send(
    new ListObjectsV2Command({ Bucket: "bucket", ContinuationToken: "0+/=" }),
  );
  assert.equal(call[2]["continuation-token"], "0+/=");
  assert.equal(r.IsTruncated, false);
  assert.equal(r.Contents[0].Size, 3);
  c.destroy();
});
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as S3 from "@aws-sdk/client-s3";
import { uploadObject } from "../electron/transfers/upload.js";
async function fixture(t, handler, seconds = 1) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    requests.push({
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
      method: req.method,
    });
    handler(req, res, requests.at(-1));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const client = createTosClient(
    { endpoint, region: "cn-beijing", forcePathStyle: true },
    { accessKeyId: "ak", secretAccessKey: "secret", sessionToken: "token" },
    { timeoutSeconds: seconds },
  );
  t.after(() => {
    client.destroy();
    server.closeAllConnections();
    server.close();
  });
  return { client, requests };
}
test("official SDK native TOS4/token preserves special and dot keys, JSON delete exact targets", async (t) => {
  const { client, requests } = await fixture(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  for (const key of ["a/../b", "a/./b", ".", "../x", "雪 +%?#"])
    await client.send(
      new S3.PutObjectCommand({ Bucket: "bucket", Key: key, Body: "ok" }),
    );
  assert.deepEqual(
    requests.map((r) => decodeURIComponent(r.url.slice("/bucket/".length))),
    ["a/../b", "a/./b", ".", "../x", "雪 +%?#"],
  );
  for (const r of requests) {
    assert.match(r.headers.authorization, /^TOS4-HMAC-SHA256 /);
    assert.match(r.headers.authorization, /cn-beijing\/tos\/request/);
    assert.equal(r.headers["x-tos-security-token"], "token");
  }
  const objects = [{ Key: "a\rb\u0000雪</Key><Key>victim", VersionId: "v&?" }];
  await client.send(
    new S3.DeleteObjectsCommand({
      Bucket: "bucket",
      Delete: { Objects: objects, Quiet: false },
    }),
  );
  assert.deepEqual(JSON.parse(requests.at(-1).body), {
    Quiet: false,
    Objects: objects,
  });
  const signed = await client.signGet({
    bucket: "bucket",
    key: "雪 +%?#",
    expiresIn: 60,
  });
  assert.match(signed, /X-Tos-Algorithm=TOS4-HMAC-SHA256/i);
  assert.match(decodeURIComponent(signed), /cn-beijing\/tos\/request/);
  await assert.rejects(
    client.signGet({ bucket: "bucket", key: "a/../b", expiresIn: 60 }),
    { name: "NotImplemented" },
  );
});
test("unknown and nested conditional fields are refused before requests", async (t) => {
  const { client, requests } = await fixture(t, (_, res) => res.end("{}"));
  await assert.rejects(
    client.send(
      new S3.DeleteObjectCommand({
        Bucket: "bucket",
        Key: "x",
        IfMatch: "etag",
      }),
    ),
    { name: "NotImplemented" },
  );
  await assert.rejects(
    client.send(
      new S3.DeleteObjectsCommand({
        Bucket: "bucket",
        Delete: { Objects: [{ Key: "x", ETag: "etag" }] },
      }),
    ),
    { name: "NotImplemented" },
  );
  assert.equal(requests.length, 0);
});
test("request abort and deadline close real sockets before headers", async (t) => {
  const { client } = await fixture(t, () => {}, 0.04);
  await assert.rejects(
    client.send(new S3.HeadObjectCommand({ Bucket: "bucket", Key: "x" })),
    { name: "TimeoutError" },
  );
  const abort = new AbortController();
  const pending = client.send(
    new S3.HeadObjectCommand({ Bucket: "bucket", Key: "x" }),
    { abortSignal: abort.signal },
  );
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
test("stream abort and deadline remain active after response headers", async (t) => {
  const { client } = await fixture(
    t,
    (_, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write("one");
    },
    0.07,
  );
  const r = await client.send(
    new S3.GetObjectCommand({ Bucket: "bucket", Key: "x" }),
  );
  const error = once(r.Body, "error");
  r.Body.resume();
  assert.equal((await error)[0].name, "TimeoutError");
  const abort = new AbortController();
  const r2 = await client.send(
    new S3.GetObjectCommand({ Bucket: "bucket", Key: "x" }),
    { abortSignal: abort.signal },
  );
  const e2 = once(r2.Body, "error");
  abort.abort();
  assert.equal((await e2)[0].name, "AbortError");
});
test("uploadObject small and multipart use actual native SDK without dropping repeated metadata", async (t) => {
  const { client, requests } = await fixture(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("etag", '"etag"');
    res.end(
      req.url.includes("uploads")
        ? JSON.stringify({ UploadId: "opaque+/=" })
        : "{}",
    );
  });
  const dir = await mkdtemp(join(tmpdir(), "tos-native-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const size of [13, 8 * 1024 * 1024 + 3]) {
    const path = join(dir, `${size}.txt`);
    await writeFile(path, Buffer.alloc(size, 97));
    const r = await uploadObject({
      client,
      bucket: "bucket",
      key: "a/../b",
      path,
      overwrite: true,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    assert.equal(r.bytesTransferred, size);
  }
  assert.equal(requests.filter((r) => r.url.includes("partNumber=")).length, 2);
  assert.ok(
    requests.some((r) => r.method === "POST" && r.body.includes("Parts")),
  );
});
test("native JSON command bridge maps paging, versions, tags, conditions and multipart exactly", async () => {
  const calls = [];
  let data = {};
  const client = createTosClient(
    { endpoint: "https://tos-cn-beijing.volces.com", region: "cn-beijing" },
    {},
    {},
    {
      sdkFactory: () => ({
        fetch: async (...args) => {
          calls.push(args);
          return {
            statusCode: 200,
            headers: { etag: '"opaque"', "x-tos-version-id": "v?+" },
            data,
          };
        },
      }),
    },
  );
  const send = async (kind, input) =>
    client.send(
      new S3[kind + "Command"]({
        Bucket: "bucket",
        Key: "a/../雪?versionId=v",
        ...input,
      }),
    );
  data = { Buckets: [{ Name: "bucket" }] };
  assert.equal((await send("ListBuckets", {})).Buckets[0].Name, "bucket");
  data = { Status: "Enabled" };
  assert.equal((await send("GetBucketVersioning", {})).Status, "Enabled");
  data = {
    Versions: [
      { Key: "a/../雪", VersionId: "v+/=", IsLatest: "false", Size: "0" },
    ],
    DeleteMarkers: [{ Key: "a/../雪", IsLatest: "true" }],
    NextKeyMarker: "k+/=",
    NextVersionIdMarker: "v+/=",
    IsTruncated: "true",
  };
  const v = await send("ListObjectVersions", {
    KeyMarker: "k+/=",
    VersionIdMarker: "v+/=",
  });
  assert.equal(v.Versions[0].IsLatest, false);
  assert.equal(v.DeleteMarkers[0].IsLatest, true);
  assert.equal(v.Versions[0].Size, 0);
  assert.equal(calls.at(-1)[2]["version-id-marker"], "v+/=");
  data = { TagSet: { Tags: [{ Key: "雪", Value: "a&b" }] } };
  assert.deepEqual(
    (await send("GetObjectTagging", { VersionId: "v+/=" })).TagSet,
    data.TagSet.Tags,
  );
  await send("PutObjectTagging", {
    VersionId: "v+/=",
    Tagging: { TagSet: data.TagSet.Tags },
  });
  assert.deepEqual(calls.at(-1)[4], data);
  assert.equal(calls.at(-1)[2].versionId, "v+/=");
  await send("DeleteObjectTagging", { VersionId: "v+/=" });
  assert.equal(calls.at(-1)[0], "DELETE");
  data = { ETag: '"copy"' };
  const copy = await send("CopyObject", {
    CopySource: "bucket/a%3FversionId%3Dx?versionId=v%3F%2B",
    CopySourceIfMatch: '"source"',
    TaggingDirective: "COPY",
    MetadataDirective: "REPLACE",
    Metadata: { arbitrary: "raw+/=" },
  });
  assert.equal(copy.CopyObjectResult.ETag, '"copy"');
  assert.equal(
    calls.at(-1)[3]["x-tos-copy-source"],
    "/bucket/a%3FversionId%3Dx?versionId=v%3F%2B",
  );
  assert.equal(calls.at(-1)[3]["x-tos-copy-source-if-match"], '"source"');
  assert.equal(calls.at(-1)[3]["x-tos-meta-arbitrary"], "raw+/=");
  assert.equal(calls.at(-1)[3]["x-tos-tagging-directive"], "COPY");
  await assert.rejects(
    send("CopyObject", { CopySource: "bucket/key?versionId=a?versionId=b" }),
    { name: "NotImplemented" },
  );
  data = { UploadId: "u+/=" };
  assert.equal(
    (
      await send("CreateMultipartUpload", {
        ContentType: "text/plain",
        Metadata: { a: "b" },
      })
    ).UploadId,
    "u+/=",
  );
  data = {
    Parts: [{ PartNumber: "2", Size: "9", ETag: '"p"' }],
    IsTruncated: "false",
    NextPartNumberMarker: "2",
  };
  const parts = await send("ListParts", {
    UploadId: "u+/=",
    PartNumberMarker: 1,
    MaxParts: 2,
  });
  assert.equal(parts.Parts[0].PartNumber, 2);
  assert.equal(parts.Parts[0].Size, 9);
  assert.equal(parts.IsTruncated, false);
  await send("UploadPart", {
    UploadId: "u+/=",
    PartNumber: 2,
    Body: Buffer.from("part"),
    ContentLength: 4,
    ContentType: "text/plain",
  });
  assert.equal(calls.at(-1)[2].partNumber, 2);
  await send("CompleteMultipartUpload", {
    UploadId: "u+/=",
    MultipartUpload: { Parts: [{ PartNumber: 2, ETag: '"p"' }] },
    ContentType: "text/plain",
    Metadata: { a: "b" },
  });
  assert.deepEqual(calls.at(-1)[4], {
    Parts: [{ PartNumber: 2, ETag: '"p"' }],
  });
  await send("AbortMultipartUpload", { UploadId: "u+/=" });
  assert.equal(calls.at(-1)[0], "DELETE");
  await send("DeleteObject", { VersionId: "v+/=" });
  assert.equal(calls.at(-1)[2].versionId, "v+/=");
  await assert.rejects(
    send("CompleteMultipartUpload", {
      MultipartUpload: { Parts: [{ PartNumber: 2, ChecksumCRC32: "x" }] },
    }),
    { name: "NotImplemented" },
  );
  client.destroy();
});
test("configured native endpoint and security options have no discovery; lib-storage config is compatible", async () => {
  let options;
  const calls = [];
  const client = createTosClient(
    {
      endpoint: "https://custom.example:9443",
      region: "cn-beijing",
      forcePathStyle: false,
    },
    { accessKeyId: "ak", secretAccessKey: "sk", sessionToken: "token" },
    { timeoutSeconds: 2 },
    {
      sdkFactory: (opts) => {
        options = opts;
        return {
          fetch: async (...args) => {
            calls.push(args);
            return {
              statusCode: 200,
              data: {},
              headers: {
                "content-length": "0",
                "x-tos-meta-a": "raw",
                "x-tos-version-id": "v",
                "last-modified": "Wed, 28 Oct 2026 01:02:03 GMT",
              },
            };
          },
        };
      },
    },
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.config.endpoint(), {
    hostname: "custom.example",
    protocol: "https:",
    port: 9443,
    path: "/",
  });
  assert.equal(
    await client.config.requestChecksumCalculation(),
    "WHEN_REQUIRED",
  );
  const r = await client.send(
    new S3.HeadObjectCommand({
      Bucket: "bucket",
      Key: "key",
      IfMatch: '"etag"',
      VersionId: "v",
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][5].subdomainBucket, "bucket");
  assert.equal(options.endpoint, "custom.example:9443");
  assert.equal(options.maxRetryCount, 0);
  assert.equal(options.enableVerifySSL, true);
  assert.equal(options.stsToken, "token");
  assert.equal(options.forcePathStyle, false);
  assert.equal(r.ContentLength, 0);
  assert.deepEqual(r.Metadata, { a: "raw" });
  assert.ok(r.LastModified instanceof Date);
  assert.equal(calls[0][3]["if-match"], '"etag"');
  await assert.rejects(
    client.send(
      new S3.PutObjectCommand({
        Bucket: "bucket",
        Key: "x",
        Tagging: { bad: true },
      }),
    ),
    { name: "NotImplemented" },
  );
  client.destroy();
  assert.throws(
    () =>
      createTosClient(
        {
          endpoint: "https://tos-s3-cn-beijing.volces.com",
          region: "cn-beijing",
        },
        {},
        {},
      ),
    { name: "NotImplemented" },
  );
});
test("malformed successful JSON cannot report copy or multipart commitment", async (t) => {
  const { client } = await fixture(t, (_, res) =>
    res.end("<html>gateway response</html>"),
  );
  for (const command of [
    new S3.CopyObjectCommand({
      Bucket: "bucket",
      Key: "k",
      CopySource: "bucket/src",
    }),
    new S3.CompleteMultipartUploadCommand({
      Bucket: "bucket",
      Key: "k",
      UploadId: "u",
      MultipartUpload: { Parts: [] },
    }),
    new S3.ListObjectsV2Command({ Bucket: "bucket" }),
  ])
    await assert.rejects(client.send(command));
});
test("repeated coordinator metadata must match successful initialization", async () => {
  const client = createTosClient(
    { endpoint: "https://tos-cn-beijing.volces.com", region: "cn-beijing" },
    {},
    {},
    {
      sdkFactory: () => ({
        fetch: async () => ({
          statusCode: 200,
          headers: {},
          data: { UploadId: "u" },
        }),
      }),
    },
  );
  await client.send(
    new S3.CreateMultipartUploadCommand({
      Bucket: "bucket",
      Key: "k",
      ContentType: "text/plain",
      Metadata: { a: "b" },
    }),
  );
  await assert.rejects(
    client.send(
      new S3.UploadPartCommand({
        Bucket: "bucket",
        Key: "k",
        UploadId: "u",
        PartNumber: 1,
        Body: Buffer.from("x"),
        Metadata: { a: "different" },
      }),
    ),
    { name: "NotImplemented" },
  );
  client.destroy();
});
import { Readable } from "node:stream";
import { TosClient } from "@volcengine/tos-sdk";
test("JSON arrays and missing mutation identifiers refuse success; large responses are bounded", async (t) => {
  let body = "[]";
  const { client } = await fixture(t, (_, res) => res.end(body));
  const commands = [
    new S3.CopyObjectCommand({
      Bucket: "bucket",
      Key: "k",
      CopySource: "bucket/src",
    }),
    new S3.CompleteMultipartUploadCommand({
      Bucket: "bucket",
      Key: "k",
      UploadId: "u",
      MultipartUpload: { Parts: [] },
    }),
    new S3.CreateMultipartUploadCommand({ Bucket: "bucket", Key: "k" }),
  ];
  for (const content of ["[]", '"string"', "{}", '{"ETag":{},"UploadId":{}}']) {
    body = content;
    for (const command of commands) await assert.rejects(client.send(command));
  }
  body = JSON.stringify({ value: "a".repeat(16 * 1024 * 1024) });
  await assert.rejects(
    client.send(new S3.ListObjectsV2Command({ Bucket: "bucket" })),
  );
});
test("successful streaming PUT removes the source error listener", async (t) => {
  const { client } = await fixture(t, (_, res) => res.end("{}"));
  const body = Readable.from(["payload"]);
  const before = body.listenerCount("error");
  await client.send(
    new S3.PutObjectCommand({ Bucket: "bucket", Key: "k", Body: body }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(body.listenerCount("error"), before);
});
test("numeric leading custom DNS stays virtual-hosted in SDK requests and signatures", async () => {
  let wire;
  const client = createTosClient(
    { endpoint: "https://123-storage.example", region: "cn-beijing" },
    { accessKeyId: "ak", secretAccessKey: "sk" },
    {},
    {
      sdkFactory: (options) => {
        const sdk = new TosClient(options);
        sdk.fetch = async function (...args) {
          wire = { baseURL: "https://" + this.opts.endpoint, url: args[1] };
          return { statusCode: 200, headers: {}, data: { Contents: [] } };
        };
        return sdk;
      },
    },
  );
  await client.send(new S3.ListObjectsV2Command({ Bucket: "bucket" }));
  assert.equal(wire.baseURL, "https://bucket.123-storage.example");
  assert.equal(wire.url, "/");
  const signed = await client.signGet({
    bucket: "bucket",
    key: "a/b",
    expiresIn: 60,
  });
  assert.equal(new URL(signed).hostname, "bucket.123-storage.example");
  assert.equal(new URL(signed).pathname, "/a%2Fb");
  client.destroy();
});
test("abort and client destroy close the actual native in-flight socket", async (t) => {
  let arrived;
  let remoteSocket;
  const { client } = await fixture(t, (req) => {
    remoteSocket = req.socket;
    arrived?.();
  });
  for (const reason of ["abort", "destroy"]) {
    const started = new Promise((resolve) => {
      arrived = resolve;
    });
    const signal = new AbortController();
    const work = client.send(
      new S3.HeadObjectCommand({ Bucket: "bucket", Key: "k" }),
      { abortSignal: signal.signal },
    );
    await started;
    const closed = once(remoteSocket, "close");
    if (reason === "abort") signal.abort();
    else client.destroy();
    await assert.rejects(work, { name: "AbortError" });
    await closed;
    assert.equal(remoteSocket.destroyed, true);
  }
});
