import test from "node:test";
import assert from "node:assert/strict";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createObsClient } from "../electron/providers/obs.js";
const connection = { endpoint: "https://obs.cn-test.myhuaweicloud.com" };
test("OBS rejects path style to prevent v2 downgrade", () =>
  assert.throws(
    () => createObsClient({ ...connection, forcePathStyle: true }, {}, {}),
    /path/i,
  ));
test("OBS checks HTTP errors even when SDK err is null", async () => {
  const client = createObsClient(
    connection,
    {},
    {},
    {
      sdkFactory: () => ({
        listObjects(p, cb) {
          cb(null, {
            CommonMsg: { Status: 403, Code: "AccessDenied", Message: "secret" },
          });
        },
        close() {},
      }),
    },
  );
  await assert.rejects(
    client.send(new ListObjectsV2Command({ Bucket: "b" })),
    (e) =>
      e.code === "AccessDenied" &&
      e.$metadata.httpStatusCode === 403 &&
      !e.message.includes("secret"),
  );
  client.destroy();
});
test("OBS preserves opaque markers and raw keys and rejects unsupported conditions", async () => {
  const calls = [];
  const client = createObsClient(
    connection,
    {},
    {},
    {
      sdkFactory: (config) => ({
        listObjects(p, cb) {
          calls.push({ config, p });
          cb(null, {
            CommonMsg: { Status: 200 },
            InterfaceResult: {
              Contents: [{ Key: " a/%雪", Size: 3 }],
              NextMarker: " /%雪",
              IsTruncated: true,
            },
          });
        },
        close() {},
      }),
    },
  );
  const r = await client.send(
    new ListObjectsV2Command({ Bucket: "b", ContinuationToken: " /%雪" }),
  );
  assert.equal(calls[0].p.Marker, " /%雪");
  assert.equal(r.NextContinuationToken, " /%雪");
  assert.equal(r.Contents[0].Key, " a/%雪");
  assert.equal(calls[0].config.signature, "obs");
  assert.equal(calls[0].config.is_signature_negotiation, false);
  await assert.rejects(
    client.send(
      new DeleteObjectCommand({ Bucket: "b", Key: "x", IfMatch: "etag" }),
    ),
    /Unsupported/,
  );
  client.destroy();
});
import http from "node:http";
import ObsClient from "esdk-obs-nodejs";
test("official SDK uses native OBS signature, token, special keys, streaming and cancellation on loopback", async () => {
  const seen = [];
  let slowClosed;
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader("content-type", "application/xml");
    if (req.url.includes("delayed")) {
      req.once("close", () => (slowClosed = true));
      return;
    }
    if (req.url.includes("slow")) {
      req.once("close", () => (slowClosed = true));
      res.writeHead(200);
      res.write("start");
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/?"))
      res.end(
        '<ListBucketResult><IsTruncated>true</IsTruncated><NextMarker> %雪</NextMarker><Contents><Key> a/%雪</Key><Size>4</Size><ETag>"etag"</ETag></Contents></ListBucketResult>',
      );
    else {
      res.setHeader("content-length", "4");
      res.setHeader("etag", '"etag"');
      res.end("data");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agent = new http.Agent({
    lookup: (hostname, options, callback) =>
      callback(
        null,
        options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1",
        4,
      ),
  });
  const client = createObsClient(
    {
      endpoint: `http://obs.cn-test.myhuaweicloud.com:${server.address().port}`,
    },
    {
      accessKeyId: "fixture-ak",
      secretAccessKey: "fixture-sk",
      sessionToken: "fixture-token",
    },
    { requestTimeoutMs: 2000 },
    {
      sdkFactory: (config) =>
        new ObsClient({
          ...config,
          http_agent: agent,
          third_http_lib: {
            request: (options) => http.request({ ...options, agent }),
          },
        }),
    },
  );
  try {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: "fixture-bucket",
        ContinuationToken: " %雪",
      }),
    );
    assert.equal(list.NextContinuationToken, " %雪");
    assert.equal(list.Contents[0].Key, " a/%雪");
    const get = await client.send(
      new GetObjectCommand({
        Bucket: "fixture-bucket",
        Key: " a/%雪?#",
        VersionId: "opaque+/=",
      }),
    );
    let text = "";
    for await (const chunk of get.Body) text += chunk;
    assert.equal(text, "data");
    assert.match(seen[0].headers.authorization, /^OBS fixture-ak:/);
    assert.equal(seen[0].headers["x-obs-security-token"], "fixture-token");
    assert.match(seen[0].headers.host, /^fixture-bucket\.obs\./);
    assert.equal(
      new URL(seen[0].url, "http://fixture").searchParams.get("marker"),
      " %雪",
    );
    assert.equal(decodeURIComponent(seen[1].url.split("?")[0]), "/ a/%雪?#");
    const delayedController = new AbortController();
    const delayed = client.send(
      new GetObjectCommand({ Bucket: "fixture-bucket", Key: "delayed" }),
      { abortSignal: delayedController.signal },
    );
    setTimeout(() => delayedController.abort(), 15);
    await assert.rejects(delayed, { name: "AbortError" });
    const signed = client.signGet({
      bucket: "fixture-bucket",
      key: " a/%雪?#",
      expiresIn: 60,
    });
    assert.match(signed, /AccessKeyId=fixture-ak/);
    assert.doesNotMatch(signed, /AWSAccessKeyId|X-Amz-/);
    const controller = new AbortController();
    const slow = await client.send(
      new GetObjectCommand({ Bucket: "fixture-bucket", Key: "slow" }),
      { abortSignal: controller.signal },
    );
    const failed = new Promise((resolve) => slow.Body.once("error", resolve));
    controller.abort();
    assert.equal((await failed).name, "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(slowClosed, true);
  } finally {
    client.destroy();
    agent.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadObject } from "../electron/transfers/upload.js";
test("uploadObject coordinator small and multipart uploads use actual OBS SDK", async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let size = 0;
    for await (const c of req) size += c.length;
    requests.push({
      method: req.method,
      url: req.url,
      size,
      authorization: req.headers.authorization,
    });
    res.setHeader("content-type", "application/xml");
    res.setHeader("etag", '"fixture-etag"');
    if (req.url.includes("?uploads"))
      res.end(
        "<InitiateMultipartUploadResult><Bucket>fixture-bucket</Bucket><Key>large</Key><UploadId>opaque+id</UploadId></InitiateMultipartUploadResult>",
      );
    else if (req.method === "POST")
      res.end(
        '<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>',
      );
    else res.end("");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agent = new http.Agent({
    lookup: (h, o, cb) =>
      cb(null, o.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4),
  });
  const client = createObsClient(
    {
      endpoint: `http://obs.cn-test.myhuaweicloud.com:${server.address().port}`,
    },
    { accessKeyId: "fixture-ak", secretAccessKey: "fixture-sk" },
    { timeoutSeconds: 5 },
    {
      sdkFactory: (config) =>
        new ObsClient({
          ...config,
          http_agent: agent,
          third_http_lib: {
            request: (options) => http.request({ ...options, agent }),
          },
        }),
    },
  );
  const directory = await mkdtemp(join(tmpdir(), "obs-native-"));
  try {
    for (const [key, size] of [
      ["small", 12],
      ["large", 8 * 1024 * 1024 + 10],
    ]) {
      const path = join(directory, key);
      await writeFile(path, Buffer.alloc(size, 7));
      await uploadObject({
        client,
        bucket: "fixture-bucket",
        key,
        path,
        overwrite: true,
        signal: new AbortController().signal,
        onProgress() {},
      });
    }
    assert.equal(requests.find((r) => r.url === "/small").size, 12);
    const parts = requests.filter((r) => r.url.includes("partNumber="));
    assert.equal(parts.length, 2);
    assert.equal(
      parts.reduce((sum, r) => sum + r.size, 0),
      8 * 1024 * 1024 + 10,
    );
    assert.ok(
      requests.every((r) => r.authorization.startsWith("OBS fixture-ak:")),
    );
    assert.ok(
      requests.some(
        (r) => r.method === "POST" && r.url.includes("uploadId=opaque%2Bid"),
      ),
    );
  } finally {
    client.destroy();
    agent.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("IP endpoints cannot silently downgrade OBS signatures", () =>
  assert.throws(
    () => createObsClient({ endpoint: "http://127.0.0.1:9000" }, {}, {}),
    { name: "NotSupported" },
  ));
import * as commands from "@aws-sdk/client-s3";
test("OBS maps multipart, version, tag, copy and metadata contracts with bucket isolation", async () => {
  const calls = [];
  let instances = 0;
  const client = createObsClient(
    connection,
    {},
    {},
    {
      sdkFactory: () => {
        const id = ++instances;
        return new Proxy(
          { close() {} },
          {
            get(target, method) {
              return (
                target[method] ||
                ((p, cb) => {
                  calls.push({ id, method, p });
                  let data = {};
                  if (method === "getObjectMetadata")
                    data = {
                      MetadataObs: { raw: "value" },
                      VersionIdObs: "v+/=",
                      ETag: '"etag"',
                      ContentLength: "5",
                    };
                  if (method === "getObjectTagging")
                    data = { Tags: [{ Key: "雪", Value: "%" }] };
                  if (method === "deleteObjects")
                    data = { Deleteds: [{ Key: "a/%" }] };
                  if (method === "listVersions")
                    data = {
                      Versions: [{ Key: "a/%", VersionId: "v+/=" }],
                      NextKeyMarker: "a/%",
                      NextVersionIdMarker: "v+/=",
                    };
                  if (method === "initiateMultipartUpload")
                    data = { UploadId: "upload+/=" };
                  if (method === "copyObject")
                    data = { ETag: '"copy"', LastModified: "date" };
                  cb(null, {
                    CommonMsg: { Status: 200 },
                    InterfaceResult: data,
                  });
                })
              );
            },
          },
        );
      },
    },
  );
  const send = (name, input = {}) =>
    client.send(new commands[name + "Command"]({ Bucket: "b", ...input }));
  try {
    assert.equal((await send("HeadObject", { Key: "a/%" })).VersionId, "v+/=");
    assert.deepEqual((await send("GetObjectTagging", { Key: "a/%" })).TagSet, [
      { Key: "雪", Value: "%" },
    ]);
    await send("PutObjectTagging", {
      Key: "a/%",
      VersionId: "v+/=",
      Tagging: { TagSet: [{ Key: "k", Value: "v" }] },
    });
    assert.deepEqual(calls.at(-1).p.Tags, [{ Key: "k", Value: "v" }]);
    await send("DeleteObjectTagging", { Key: "a/%" });
    await send("GetBucketVersioning");
    assert.equal(
      (
        await send("DeleteObjects", {
          Delete: {
            Objects: [{ Key: "a/%", VersionId: "v+/=" }],
            Quiet: false,
          },
        })
      ).Deleted[0].Key,
      "a/%",
    );
    assert.equal(
      (
        await send("ListObjectVersions", {
          KeyMarker: "a/%",
          VersionIdMarker: "v+/=",
        })
      ).NextVersionIdMarker,
      "v+/=",
    );
    assert.equal(
      (
        await send("CopyObject", {
          Key: "target",
          CopySource: "b/a%2F%25%E9%9B%AA?versionId=v%2B%2F%3D",
          CopySourceIfMatch: '"etag"',
          MetadataDirective: "REPLACE",
          Metadata: { x: "y" },
        })
      ).CopyObjectResult.ETag,
      '"copy"',
    );
    assert.equal(calls.at(-1).p.CopySource, "b/a/%雪?versionId=v%2B%2F%3D");
    assert.equal(calls.at(-1).p.CopySourceIfMatch, '"etag"');
    await send("CreateMultipartUpload", {
      Key: "a/%",
      ContentType: "text/plain",
    });
    await send("UploadPart", {
      Key: "a/%",
      UploadId: "upload+/=",
      PartNumber: 1,
      Body: Buffer.from("data"),
      ContentLength: 4,
    });
    assert.equal(calls.at(-1).p.PartSize, 4);
    await send("ListParts", {
      Key: "a/%",
      UploadId: "upload+/=",
      PartNumberMarker: 2,
    });
    await send("CompleteMultipartUpload", {
      Key: "a/%",
      UploadId: "upload+/=",
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"part"' }] },
    });
    assert.deepEqual(calls.at(-1).p.Parts, [{ PartNumber: 1, ETag: '"part"' }]);
    await send("AbortMultipartUpload", { Key: "a/%", UploadId: "upload+/=" });
    await send("DeleteObject", { Key: "a/%", VersionId: "v+/=" });
    await send("HeadObject", { Bucket: "other", Key: "a/%" });
    assert.equal(instances, 2);
    assert.notEqual(calls[0].id, calls.at(-1).id);
    await assert.rejects(
      send("PutObject", { Key: "x", Body: "x", IfNoneMatch: "*" }),
      { name: "NotSupported" },
    );
  } finally {
    client.destroy();
  }
});
test("OBS signed shares reject browser-normalized dot keys", () => {
  const client = createObsClient(
    connection,
    { accessKeyId: "fixture", secretAccessKey: "fixture" },
    {},
  );
  try {
    for (const key of ["a/../b", "a/./b", ".", ".."])
      assert.throws(
        () => client.signGet({ bucket: "fixture-bucket", key, expiresIn: 60 }),
        { name: "NotSupported" },
      );
  } finally {
    client.destroy();
  }
});
test("OBS copy rejects unversioned source whose literal key mimics a version query", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers["x-obs-copy-source"]);
    res.setHeader("content-type", "application/xml");
    res.end('<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const agent = new http.Agent({
    lookup: (h, o, cb) =>
      cb(null, o.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4),
  });
  const client = createObsClient(
    {
      endpoint: `http://obs.cn-test.myhuaweicloud.com:${server.address().port}`,
    },
    { accessKeyId: "fixture", secretAccessKey: "fixture" },
    { timeoutSeconds: 2 },
    {
      sdkFactory: (config) =>
        new ObsClient({
          ...config,
          http_agent: agent,
          third_http_lib: {
            request: (opts) => http.request({ ...opts, agent }),
          },
        }),
    },
  );
  try {
    await assert.rejects(
      client.send(
        new commands.CopyObjectCommand({
          Bucket: "fixture-bucket",
          Key: "dest",
          CopySource: "fixture-bucket/key%3FversionId%3Dliteral",
        }),
      ),
      { name: "NotSupported" },
    );
    assert.equal(seen.length, 0);
    await client.send(
      new commands.CopyObjectCommand({
        Bucket: "fixture-bucket",
        Key: "dest",
        CopySource:
          "fixture-bucket/key%3FversionId%3Dliteral?versionId=real%2B%2F%3D",
      }),
    );
    assert.ok(seen[0].endsWith("?versionId=real%2B%2F%3D"));
    assert.match(seen[0], /key%3FversionId%3Dliteral/);
  } finally {
    client.destroy();
    agent.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
import { createS3Operations } from "../electron/s3/operations.js";
import { verifyRemoteParts } from "../electron/transfers/resumable-upload.js";
test("real OBS XML normalizes list/version/part scalar values for coordinators", async () => {
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, "http://fixture").searchParams;
    res.setHeader("content-type", "application/xml");
    if (q.has("versioning"))
      return res.end(
        "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
      );
    if (q.has("versions")) {
      const next = !q.has("key-marker");
      return res.end(
        `<ListVersionsResult><IsTruncated>${next}</IsTruncated>${next ? "<NextKeyMarker>raw+/=</NextKeyMarker><NextVersionIdMarker>v+/=</NextVersionIdMarker>" : ""}<Version><Key>raw</Key><VersionId>v+/=</VersionId><IsLatest>${next}</IsLatest><Size>8</Size><ETag>"e"</ETag></Version><DeleteMarker><Key>raw</Key><VersionId>deleted+/=</VersionId><IsLatest>false</IsLatest></DeleteMarker></ListVersionsResult>`,
      );
    }
    if (q.has("uploadId")) {
      const next = !q.has("part-number-marker");
      return res.end(
        `<ListPartsResult><IsTruncated>${next}</IsTruncated>${next ? "<NextPartNumberMarker>1</NextPartNumberMarker>" : ""}<Part><PartNumber>${next ? 1 : 2}</PartNumber><Size>${next ? 8 : 9}</Size><ETag>"${next ? "one" : "two"}"</ETag></Part></ListPartsResult>`,
      );
    }
    const next = !q.has("marker");
    res.end(
      `<ListBucketResult><IsTruncated>${next}</IsTruncated>${next ? "<NextMarker>raw+/=</NextMarker>" : ""}<Contents><Key>raw</Key><Size>8</Size></Contents></ListBucketResult>`,
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const agent = new http.Agent({
    lookup: (h, o, cb) =>
      cb(null, o.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4),
  });
  const conn = {
    provider: "obs",
    endpoint: `http://obs.cn-test.myhuaweicloud.com:${server.address().port}`,
  };
  const client = createObsClient(
    conn,
    { accessKeyId: "fixture", secretAccessKey: "fixture" },
    { timeoutSeconds: 2 },
    {
      sdkFactory: (config) =>
        new ObsClient({
          ...config,
          http_agent: agent,
          third_http_lib: {
            request: (opts) => http.request({ ...opts, agent }),
          },
        }),
    },
  );
  try {
    const api = createS3Operations({ client, connection: conn });
    const first = await api.listObjectVersions({
      bucket: "fixture-bucket",
      key: "raw",
    });
    assert.equal(first.entries.find((e) => !e.deleteMarker).latest, true);
    assert.equal(first.entries[0].size, 8);
    assert.deepEqual(first.nextPage, {
      keyMarker: "raw+/=",
      versionIdMarker: "v+/=",
    });
    const last = await api.listObjectVersions({
      bucket: "fixture-bucket",
      key: "raw",
      ...first.nextPage,
    });
    assert.equal(last.nextPage, undefined);
    assert.equal(last.entries.find((e) => !e.deleteMarker).latest, false);
    await verifyRemoteParts(
      client,
      {
        bucket: "fixture-bucket",
        key: "raw",
        uploadId: "upload+/=",
        parts: [
          { number: 1, size: 8, etag: '"one"' },
          { number: 2, size: 9, etag: '"two"' },
        ],
      },
      new AbortController().signal,
    );
    const list = await client.send(
      new commands.ListObjectsV2Command({ Bucket: "fixture-bucket" }),
    );
    assert.equal(list.IsTruncated, true);
    assert.equal(list.Contents[0].Size, 8);
    assert.equal(list.NextContinuationToken, "raw+/=");
    const final = await client.send(
      new commands.ListObjectsV2Command({
        Bucket: "fixture-bucket",
        ContinuationToken: list.NextContinuationToken,
      }),
    );
    assert.equal(final.IsTruncated, false);
  } finally {
    client.destroy();
    agent.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("OBS XML commands reject markup injection before wire and preserve ampersand/quotes exactly", async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    bodies.push(text);
    res.setHeader("content-type", "application/xml");
    res.end("<DeleteResult/>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const agent = new http.Agent({
    lookup: (h, o, cb) =>
      cb(null, o.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4),
  });
  const client = createObsClient(
    {
      endpoint: `http://obs.cn-test.myhuaweicloud.com:${server.address().port}`,
    },
    { accessKeyId: "fixture", secretAccessKey: "fixture" },
    { timeoutSeconds: 2 },
    {
      sdkFactory: (config) =>
        new ObsClient({
          ...config,
          http_agent: agent,
          third_http_lib: {
            request: (opts) => http.request({ ...opts, agent }),
          },
        }),
    },
  );
  try {
    const injected = "selected</Key></Object><Object><Key>other-object";
    for (const Objects of [
      [{ Key: injected }],
      [{ Key: "selected", VersionId: "v<injected" }],
      [{ Key: "selected\u0000" }],
      [{ Key: "selected\rkey" }],
      [{ Key: "selected\ud800" }],
      [{ Key: "selected\ufdd0" }],
      [{ Key: "selected\u{1fffe}" }],
    ])
      await assert.rejects(
        client.send(
          new commands.DeleteObjectsCommand({
            Bucket: "fixture-bucket",
            Delete: { Objects },
          }),
        ),
        { name: "NotSupported" },
      );
    await assert.rejects(
      client.send(
        new commands.PutObjectTaggingCommand({
          Bucket: "fixture-bucket",
          Key: "selected",
          Tagging: { TagSet: [{ Key: "k", Value: "<injected" }] },
        }),
      ),
      { name: "NotSupported" },
    );
    await assert.rejects(
      client.send(
        new commands.CompleteMultipartUploadCommand({
          Bucket: "fixture-bucket",
          Key: "selected",
          UploadId: "u",
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: "<injected" }] },
        }),
      ),
      { name: "NotSupported" },
    );
    assert.equal(bodies.length, 0);
    const key = "selected&\"'raw\n\t雪😀";
    await client.send(
      new commands.DeleteObjectsCommand({
        Bucket: "fixture-bucket",
        Delete: { Objects: [{ Key: key, VersionId: "v&\"'" }] },
      }),
    );
    const { XMLParser } = await import("fast-xml-parser");
    const parsed = new XMLParser({ trimValues: false }).parse(bodies[0]);
    assert.equal(Array.isArray(parsed.Delete.Object), false);
    assert.equal(parsed.Delete.Object.Key, key);
    assert.equal(parsed.Delete.Object.VersionId, "v&\"'");
    assert.equal(bodies.length, 1);
  } finally {
    client.destroy();
    agent.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
