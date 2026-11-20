import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { createOssClient } from "../electron/providers/oss.js";
const connection = {
  endpoint: "http://127.0.0.1:1",
  region: "cn-hangzhou",
  forcePathStyle: true,
};
const credentials = {
  accessKeyId: "test-id",
  secretAccessKey: "test-secret",
  sessionToken: "test-token",
};
test("OSS preserves opaque list markers and raw keys with native request mapping", async () => {
  const calls = [];
  const c = createOssClient(
    connection,
    credentials,
    { timeoutSeconds: 2 },
    {
      sdkFactory: (opts) => ({
        request: async (p) => {
          calls.push([opts, p]);
          return {
            status: 200,
            headers: {},
            data: {
              Contents: { Key: "/空 +%2F", ETag: '"opaque"', Size: "3" },
              NextContinuationToken: "opaque+/=",
            },
          };
        },
      }),
    },
  );
  const r = await c.send(
    new ListObjectsV2Command({
      Bucket: "bucket",
      ContinuationToken: "opaque+/=",
    }),
  );
  assert.equal(r.Contents[0].Key, "/空 +%2F");
  assert.equal(r.NextContinuationToken, "opaque+/=");
  assert.equal(calls[0][1].query["continuation-token"], "opaque+/=");
  assert.equal(calls[0][0].authorizationV4, true);
  assert.equal(calls[0][0].retryMax, 0);
  c.destroy();
});
test("OSS rejects conditional copy fields that cannot safely be implemented", async () => {
  const c = createOssClient(connection, credentials, { timeoutSeconds: 2 });
  await assert.rejects(
    c.send(
      new CopyObjectCommand({
        Bucket: "bucket",
        Key: "x",
        CopySource: "bucket/y",
        IfNoneMatch: "*",
      }),
    ),
    { code: "NotImplemented" },
  );
  c.destroy();
});
test("official OSS SDK sends V4, token and exact special key; abort destroys response", async () => {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push(req);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      etag: '"exact"',
    });
    res.write("abc");
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = createOssClient(
    { ...connection, endpoint: `http://127.0.0.1:${server.address().port}` },
    credentials,
    { timeoutSeconds: 2 },
  );
  try {
    const ac = new AbortController();
    const r = await c.send(
      new GetObjectCommand({ Bucket: "bucket", Key: "/空 +%2F" }),
      { abortSignal: ac.signal },
    );
    assert.equal(r.ETag, '"exact"');
    assert.match(seen[0].headers.authorization, /^OSS4-HMAC-SHA256 /);
    assert.equal(seen[0].headers["x-oss-security-token"], "test-token");
    assert.equal(seen[0].url, "/bucket//%E7%A9%BA%20%2B%252F");
    ac.abort();
    assert.equal(r.Body.destroyed, true);
  } finally {
    c.destroy();
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

test("native multipart, versions, tagging and metadata map without losing opaque values", async () => {
  const {
    CreateMultipartUploadCommand,
    UploadPartCommand,
    ListPartsCommand,
    CompleteMultipartUploadCommand,
    GetObjectTaggingCommand,
    PutObjectTaggingCommand,
    ListObjectVersionsCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
  } = await import("@aws-sdk/client-s3");
  const calls = [];
  const responses = [
    { UploadId: "upload+/=" },
    {},
    {
      IsTruncated: "true",
      NextPartNumberMarker: "0002",
      Part: { PartNumber: "2", ETag: '"opaque+/="', Size: "3" },
    },
    { ETag: '"final"', Key: "/raw%2F" },
    { TagSet: { Tag: { Key: "空", Value: "&+" } } },
    {},
    {
      IsTruncated: "true",
      NextKeyMarker: "/raw?+%",
      NextVersionIdMarker: "version+/=",
      Version: {
        Key: "/raw",
        VersionId: "version+/=",
        IsLatest: "true",
        Size: "3",
      },
    },
    {},
    {},
  ];
  const c = createOssClient(
    connection,
    credentials,
    { timeoutSeconds: 2 },
    {
      sdkFactory: (opts) => ({
        request: async (p) => {
          calls.push({ opts, p });
          return {
            status: 200,
            headers: {
              etag: '"opaque+/="',
              "x-oss-version-id": "version+/=",
              "content-length": "3",
              "x-oss-meta-raw": "keep",
              "x-oss-storage-class": "Standard",
            },
            data: responses.shift(),
          };
        },
      }),
    },
  );
  const base = { Bucket: "bucket", Key: "/raw%2F" };
  assert.equal(
    (
      await c.send(
        new CreateMultipartUploadCommand({
          ...base,
          Metadata: { raw: "keep" },
          ContentType: "text/plain",
        }),
      )
    ).UploadId,
    "upload+/=",
  );
  assert.equal(
    (
      await c.send(
        new UploadPartCommand({
          ...base,
          UploadId: "upload+/=",
          PartNumber: 2,
          Body: Buffer.from("abc"),
          ContentLength: 3,
        }),
      )
    ).ETag,
    '"opaque+/="',
  );
  const parts = await c.send(
    new ListPartsCommand({
      ...base,
      UploadId: "upload+/=",
      PartNumberMarker: "0001",
    }),
  );
  assert.equal(parts.NextPartNumberMarker, "0002");
  assert.equal(parts.Parts[0].PartNumber, 2);
  await c.send(
    new CompleteMultipartUploadCommand({
      ...base,
      UploadId: "upload+/=",
      MultipartUpload: { Parts: [{ ETag: '"opaque+/="', PartNumber: 2 }] },
    }),
  );
  assert.equal(
    (
      await c.send(
        new GetObjectTaggingCommand({ ...base, VersionId: "version+/=" }),
      )
    ).TagSet[0].Value,
    "&+",
  );
  await c.send(
    new PutObjectTaggingCommand({
      ...base,
      Tagging: { TagSet: [{ Key: "空", Value: "&+" }] },
    }),
  );
  const versions = await c.send(
    new ListObjectVersionsCommand({
      Bucket: "bucket",
      KeyMarker: "/raw?+%",
      VersionIdMarker: "version+/=",
    }),
  );
  assert.equal(versions.NextKeyMarker, "/raw?+%");
  assert.equal(versions.Versions[0].IsLatest, true);
  const head = await c.send(new HeadObjectCommand(base));
  assert.equal(head.Metadata.raw, "keep");
  assert.equal(head.ContentLength, 3);
  await c.send(new DeleteObjectCommand({ ...base, VersionId: "version+/=" }));
  assert.equal(calls[0].p.headers["x-oss-meta-raw"], "keep");
  assert.equal(calls[1].p.query.uploadId, "upload+/=");
  assert.equal(
    calls[3].p.content,
    "<CompleteMultipartUpload><Part><ETag>&quot;opaque+/=&quot;</ETag><PartNumber>2</PartNumber></Part></CompleteMultipartUpload>",
  );
  assert.equal(
    calls[5].p.content,
    "<Tagging><TagSet><Tag><Key>空</Key><Value>&amp;+</Value></Tag></TagSet></Tagging>",
  );
  assert.equal(calls[8].p.query.versionId, "version+/=");
  c.destroy();
});

test("copy maps source precondition and native metadata/tagging directives exactly", async () => {
  let request;
  const c = createOssClient(
    connection,
    credentials,
    {},
    {
      sdkFactory: () => ({
        request: async (p) => {
          request = p;
          return { status: 200, headers: {}, data: { ETag: '"copy"' } };
        },
      }),
    },
  );
  const r = await c.send(
    new CopyObjectCommand({
      Bucket: "bucket",
      Key: "/dest",
      CopySource: "bucket//raw%2B%252F?versionId=v%2B",
      CopySourceIfMatch: '"original"',
      MetadataDirective: "REPLACE",
      TaggingDirective: "COPY",
      Metadata: { a: "b" },
      CacheControl: "no-cache",
    }),
  );
  assert.equal(
    request.headers["x-oss-copy-source"],
    "/bucket//raw%2B%252F?versionId=v%2B",
  );
  assert.equal(request.headers["x-oss-copy-source-if-match"], '"original"');
  assert.equal(request.headers["x-oss-metadata-directive"], "REPLACE");
  assert.equal(request.headers["x-oss-tagging-directive"], "Copy");
  assert.equal(request.headers["cache-control"], "no-cache");
  assert.equal(r.CopyObjectResult.ETag, '"copy"');
  c.destroy();
});

test("official SDK cancellation before headers closes real socket and cleans error details", async () => {
  let arrived;
  const incoming = new Promise((r) => (arrived = r));
  let disconnected;
  const disconnect = new Promise((r) => (disconnected = r));
  const server = http.createServer((req) => {
    req.on("close", disconnected);
    arrived();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = createOssClient(
    { ...connection, endpoint: `http://127.0.0.1:${server.address().port}` },
    credentials,
    { timeoutSeconds: 2 },
  );
  try {
    const ac = new AbortController();
    const request = c.send(
      new GetObjectCommand({ Bucket: "bucket", Key: "slow" }),
      { abortSignal: ac.signal },
    );
    await incoming;
    ac.abort();
    await assert.rejects(
      request,
      (e) => e.code === "AbortError" && !("params" in e),
    );
    await disconnect;
  } finally {
    c.destroy();
    await new Promise((r) => server.close(r));
  }
});

test("real OSS wire fixture supports uploadObject small/multipart coordinator and native signed GET", async () => {
  const { uploadObject } = await import("../electron/transfers/upload.js");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "oss-native-"));
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("ETag", '"exact"');
    const u = new URL(req.url, "http://localhost");
    if (u.searchParams.has("uploads"))
      res.end(
        "<InitiateMultipartUploadResult><UploadId>upload+/=</UploadId></InitiateMultipartUploadResult>",
      );
    else if (req.method === "POST")
      res.end(
        '<CompleteMultipartUploadResult><ETag>"complete"</ETag><Key>/raw +%2F</Key></CompleteMultipartUploadResult>',
      );
    else res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = createOssClient(
    { ...connection, endpoint: `http://127.0.0.1:${server.address().port}` },
    credentials,
    { timeoutSeconds: 2 },
  );
  try {
    for (const size of [3, 8 * 1024 * 1024 + 17]) {
      const path = join(dir, `${size}.txt`);
      await writeFile(path, Buffer.alloc(size, 97));
      let committed = false;
      await uploadObject({
        client: c,
        bucket: "bucket",
        key: "/raw +%2F",
        path,
        overwrite: true,
        signal: new AbortController().signal,
        onProgress() {},
        committed() {
          committed = true;
        },
      });
      assert.equal(committed, true);
    }
    assert.equal(seen.length, 5);
    assert.equal(seen[0].body.length, 3);
    assert.equal(
      seen.filter((r) => r.method === "PUT" && r.url.includes("partNumber"))
        .length,
      2,
    );
    assert.equal(
      seen.find((r) => r.url.includes("partNumber=1")).body.length,
      8 * 1024 * 1024,
    );
    assert.match(
      seen.at(-1).body.toString(),
      /<ETag>&quot;exact&quot;<\/ETag>/,
    );
    for (const r of seen) {
      assert.match(r.headers.authorization, /^OSS4-HMAC-SHA256 /);
      assert.match(r.url, /^\/bucket\/\/raw%20%2B%252F/);
    }
    const signed = new URL(
      await c.signGet({ bucket: "bucket", key: "/raw +%2F", expiresIn: 60 }),
    );
    assert.equal(
      signed.searchParams.get("x-oss-signature-version"),
      "OSS4-HMAC-SHA256",
    );
    assert.equal(signed.searchParams.get("x-oss-security-token"), "test-token");
    assert.equal(signed.pathname, "/bucket//raw%20%2B%252F");
  } finally {
    c.destroy();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test("official SDK parses native list/version/tag XML, source conditions and sanitized failures", async () => {
  const { ListObjectVersionsCommand, GetObjectTaggingCommand } =
    await import("@aws-sdk/client-s3");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req);
    res.setHeader("Content-Type", "application/xml");
    const u = new URL(req.url, "http://localhost");
    if (u.pathname.endsWith("/denied")) {
      res.writeHead(403);
      res.end(
        "<Error><Code>AccessDenied</Code><Message>test-secret private request</Message><RequestId>private</RequestId></Error>",
      );
    } else if (u.searchParams.has("versions"))
      res.end(
        '<ListVersionsResult><IsTruncated>true</IsTruncated><NextKeyMarker>/空+%</NextKeyMarker><NextVersionIdMarker>opaque+/=</NextVersionIdMarker><Version><Key>/空+%</Key><VersionId>opaque+/=</VersionId><IsLatest>false</IsLatest><ETag>"e"</ETag><Size>1</Size></Version></ListVersionsResult>',
      );
    else if (u.searchParams.has("tagging"))
      res.end(
        "<Tagging><TagSet><Tag><Key>空</Key><Value>&amp;+</Value></Tag></TagSet></Tagging>",
      );
    else if (req.method === "PUT") {
      req.resume();
      res.end('<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>');
    } else
      res.end(
        '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>opaque+/=</NextContinuationToken><Contents><Key>/空+%</Key><Size>1</Size><ETag>"e"</ETag></Contents></ListBucketResult>',
      );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = createOssClient(
    { ...connection, endpoint: `http://127.0.0.1:${server.address().port}` },
    credentials,
    { timeoutSeconds: 2 },
  );
  try {
    const list = await c.send(
      new ListObjectsV2Command({
        Bucket: "bucket",
        ContinuationToken: "opaque+/=",
      }),
    );
    assert.equal(list.NextContinuationToken, "opaque+/=");
    assert.equal(list.Contents[0].Key, "/空+%");
    assert.equal(
      new URL(seen[0].url, "http://localhost").searchParams.get(
        "continuation-token",
      ),
      "opaque+/=",
    );
    const versions = await c.send(
      new ListObjectVersionsCommand({
        Bucket: "bucket",
        VersionIdMarker: "opaque+/=",
      }),
    );
    assert.equal(versions.NextVersionIdMarker, "opaque+/=");
    assert.equal(versions.Versions[0].IsLatest, false);
    assert.equal(
      (
        await c.send(
          new GetObjectTaggingCommand({
            Bucket: "bucket",
            Key: "/空+%",
            VersionId: "opaque+/=",
          }),
        )
      ).TagSet[0].Value,
      "&+",
    );
    await c.send(
      new CopyObjectCommand({
        Bucket: "bucket",
        Key: "dest",
        CopySource: "bucket//raw%2B%252F?versionId=v%2B",
        CopySourceIfMatch: '"e"',
        TaggingDirective: "COPY",
        MetadataDirective: "REPLACE",
        Metadata: { raw: "preserved" },
      }),
    );
    assert.equal(
      seen[3].headers["x-oss-copy-source"],
      "/bucket//raw%2B%252F?versionId=v%2B",
    );
    assert.equal(seen[3].headers["x-oss-copy-source-if-match"], '"e"');
    assert.equal(seen[3].headers["x-oss-meta-raw"], "preserved");
    await assert.rejects(
      c.send(new GetObjectCommand({ Bucket: "bucket", Key: "denied" })),
      (e) =>
        e.code === "AccessDenied" &&
        e.$metadata.httpStatusCode === 403 &&
        !JSON.stringify(e).includes("test-secret") &&
        !("params" in e),
    );
  } finally {
    c.destroy();
    await new Promise((r) => server.close(r));
  }
});

test("native endpoint validation rejects S3-only host and ambiguous URL components", () => {
  for (const endpoint of [
    "https://s3.oss-cn-hangzhou.aliyuncs.com",
    "https://oss-cn-hangzhou.aliyuncs.com/path",
    "https://user:pass@example.com",
    "https://example.com?token=private",
  ])
    assert.throws(
      () => createOssClient({ ...connection, endpoint }, credentials, {}),
      { code: "NotImplemented" },
    );
});

test("concurrent per-bucket native requests isolate cancellation and SDK bucket state", async () => {
  let arrived;
  const incoming = new Promise((r) => (arrived = r));
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/first/slow") arrived();
    else
      res.end(
        "<ListBucketResult><Contents><Key>other</Key><Size>1</Size></Contents></ListBucketResult>",
      );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = createOssClient(
    { ...connection, endpoint: `http://127.0.0.1:${server.address().port}` },
    credentials,
    { timeoutSeconds: 2 },
  );
  try {
    const ac = new AbortController();
    const slow = c.send(
      new GetObjectCommand({ Bucket: "first", Key: "slow" }),
      { abortSignal: ac.signal },
    );
    await incoming;
    const other = c.send(new ListObjectsV2Command({ Bucket: "second" }));
    ac.abort();
    await assert.rejects(slow, { code: "AbortError" });
    assert.equal((await other).Contents[0].Key, "other");
    assert.ok(seen.some((p) => p.startsWith("/second/?")));
  } finally {
    c.destroy();
    await new Promise((r) => server.close(r));
  }
});

test("official SDK preserves literal dot segments and backslashes on native wire", async () => {
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = createOssClient(
    { ...connection, endpoint: `http://127.0.0.1:${server.address().port}` },
    credentials,
    { timeoutSeconds: 2 },
  );
  try {
    for (const key of ["a/../b", "a/./b", "a\\b"])
      await c.send(new HeadObjectCommand({ Bucket: "bucket", Key: key }));
    assert.deepEqual(seen, [
      "/bucket/a/../b",
      "/bucket/a/./b",
      "/bucket/a%5Cb",
    ]);
    await assert.rejects(
      c.signGet({ bucket: "bucket", key: "a/../b", expiresIn: 60 }),
      { code: "NotImplemented" },
    );
  } finally {
    c.destroy();
    await new Promise((r) => server.close(r));
  }
});

test("streaming GET retains deadline after response headers", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.write("first");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = createOssClient(
    { ...connection, endpoint: `http://127.0.0.1:${server.address().port}` },
    credentials,
    { timeoutSeconds: 0.5 },
  );
  let timer;
  try {
    const r = await c.send(
      new GetObjectCommand({ Bucket: "bucket", Key: "slow" }),
    );
    let streamError;
    r.Body.once("error", (error) => {
      streamError = error;
    });
    r.Body.resume();
    const closed = new Promise((resolve) =>
      r.Body.once("close", () => resolve(true)),
    );
    assert.equal(
      await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]),
      true,
    );
    assert.equal(r.Body.destroyed, true);
    assert.equal(streamError?.code, "TimeoutError");
  } finally {
    clearTimeout(timer);
    c.destroy();
    await new Promise((r) => server.close(r));
  }
});

test("bulk delete XML preserves carriage returns and rejects invalid XML scalar values before wire", async () => {
  const { DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
  const { default: OSS } = await import("ali-oss");
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString());
    res.end("<DeleteResult/>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = createOssClient(
    { ...connection, endpoint: `http://127.0.0.1:${server.address().port}` },
    credentials,
    { timeoutSeconds: 2 },
  );
  try {
    const key = "line\rreturn\n<&";
    await c.send(
      new DeleteObjectsCommand({
        Bucket: "bucket",
        Delete: { Objects: [{ Key: key }] },
      }),
    );
    assert.match(bodies[0], /line&#13;return/);
    const parsed = await OSS.prototype.parseXML(bodies[0]);
    assert.equal(parsed.Object.Key, key);
    for (const invalid of [
      "control\u0001",
      "control\u000b",
      "noncharacter\ufffe",
      "surrogate\ud800",
    ])
      await assert.rejects(
        c.send(
          new DeleteObjectsCommand({
            Bucket: "bucket",
            Delete: { Objects: [{ Key: invalid }] },
          }),
        ),
        { code: "NotImplemented" },
      );
    assert.equal(bodies.length, 1);
  } finally {
    c.destroy();
    await new Promise((r) => server.close(r));
  }
});
