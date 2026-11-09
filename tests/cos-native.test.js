import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createCosClient } from "../electron/providers/cos.js";
test("COS official signer preserves raw paths and native security token", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.end("hello");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = createCosClient(
    {
      endpoint: `http://cos.ap-guangzhou.myqcloud.com:${server.address().port}`,
      region: "ap-guangzhou",
      forcePathStyle: false,
    },
    { accessKeyId: "id", secretAccessKey: "secret", sessionToken: "temporary" },
    { timeoutSeconds: 1 },
    {
      lookup: (_host, _opts, cb) =>
        cb(null, [{ address: "127.0.0.1", family: 4 }]),
    },
  );
  try {
    const r = await client.send(
      new GetObjectCommand({ Bucket: "bucket-123456", Key: "a/../中 ?#%" }),
    );
    let s = "";
    for await (const c of r.Body) s += c;
    assert.equal(s, "hello");
    assert.equal(seen[0].url, "/a/../%E4%B8%AD%20%3F%23%25");
    assert.match(seen[0].headers.authorization, /q-sign-algorithm=sha1/);
    assert.equal(seen[0].headers["x-cos-security-token"], "temporary");
  } finally {
    client.destroy();
    await new Promise((r) => server.close(r));
  }
});

import * as commands from "@aws-sdk/client-s3";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import COS from "cos-nodejs-sdk-v5";
import { uploadObject } from "../electron/transfers/upload.js";
const credentials = {
  accessKeyId: "test-id",
  secretAccessKey: "test-secret",
  sessionToken: "temporary",
};
async function fixture(fn, settings = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const entry = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    seen.push(entry);
    await fn(entry, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const connection = {
    endpoint: `http://cos.ap-guangzhou.myqcloud.com:${server.address().port}`,
    region: "ap-guangzhou",
    forcePathStyle: false,
  };
  const client = createCosClient(
    connection,
    credentials,
    { timeoutSeconds: 2, ...settings },
    {
      lookup: (_host, _opts, cb) =>
        cb(null, [{ address: "127.0.0.1", family: 4 }]),
    },
  );
  return {
    client,
    seen,
    connection,
    async close() {
      client.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
const input = { Bucket: "bucket-123456", Key: "raw /中?#%" };
const send = (client, name, extra = {}) =>
  client.send(new commands[`${name}Command`]({ ...input, ...extra }));

test("COS maps native list marker and XML scalars without changing opaque identity", async () => {
  const f = await fixture((e, res) =>
    res.end(
      '<ListBucketResult><IsTruncated>false</IsTruncated><NextMarker>opaque/ ?&amp;</NextMarker><Contents><Key>raw /中?#%</Key><Size>7</Size><ETag>"raw"</ETag></Contents><CommonPrefixes><Prefix>中/</Prefix></CommonPrefixes></ListBucketResult>',
    ),
  );
  try {
    const r = await send(f.client, "ListObjectsV2", {
      ContinuationToken: "opaque/ ?&",
      Prefix: "中/",
      Delimiter: "/",
      MaxKeys: 200,
    });
    assert.equal(r.IsTruncated, false);
    assert.equal(r.Contents[0].Size, 7);
    assert.equal(r.Contents[0].Key, input.Key);
    assert.equal(r.NextContinuationToken, "opaque/ ?&");
    const url = new URL(f.seen[0].url, "http://local");
    assert.equal(url.searchParams.get("marker"), "opaque/ ?&");
    assert.equal(url.searchParams.has("list-type"), false);
  } finally {
    await f.close();
  }
});
test("COS versions, tags, parts, versioning use native subresources and normalize scalar types", async () => {
  const f = await fixture((e, res) => {
    if (e.url.includes("versions="))
      res.end(
        "<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>raw /中?#%</Key><VersionId>opaque/+=</VersionId><IsLatest>false</IsLatest><Size>8</Size></Version><DeleteMarker><Key>gone</Key><IsLatest>true</IsLatest></DeleteMarker><NextKeyMarker>opaque?</NextKeyMarker></ListVersionsResult>",
      );
    else if (e.url.includes("tagging="))
      res.end(
        "<Tagging><TagSet><Tag><Key>中</Key><Value>value</Value></Tag></TagSet></Tagging>",
      );
    else if (e.url.includes("versioning="))
      res.end(
        "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
      );
    else
      res.end(
        '<ListPartsResult><IsTruncated>false</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker><Part><PartNumber>1</PartNumber><Size>7</Size><ETag>"raw"</ETag></Part></ListPartsResult>',
      );
  });
  try {
    const v = await send(f.client, "ListObjectVersions", {
      KeyMarker: "opaque?",
      VersionIdMarker: "opaque/+=",
    });
    assert.equal(v.Versions[0].IsLatest, false);
    assert.equal(v.DeleteMarkers[0].IsLatest, true);
    assert.equal(v.Versions[0].VersionId, "opaque/+=");
    assert.equal(v.Versions[0].Size, 8);
    const t = await send(f.client, "GetObjectTagging", {
      VersionId: "opaque/+=",
    });
    assert.deepEqual(t.TagSet, [{ Key: "中", Value: "value" }]);
    assert.equal(
      (await send(f.client, "GetBucketVersioning")).Status,
      "Enabled",
    );
    const p = await send(f.client, "ListParts", {
      UploadId: "opaque/+=",
      PartNumberMarker: 1,
    });
    assert.equal(p.Parts[0].PartNumber, 1);
    assert.equal(p.Parts[0].Size, 7);
    assert.equal(p.NextPartNumberMarker, 2);
  } finally {
    await f.close();
  }
});
test("COS XML targets escape CR, metacharacters and reject control injection before request", async () => {
  const f = await fixture((e, res) =>
    res.end("<DeleteResult><Deleted><Key>ok</Key></Deleted></DeleteResult>"),
  );
  try {
    const key = 'a\r<&"\n中';
    const r = await send(f.client, "DeleteObjects", {
      Delete: { Objects: [{ Key: key, VersionId: "v<&" }], Quiet: false },
    });
    assert.equal(r.Deleted[0].Key, "ok");
    assert.match(f.seen[0].body.toString(), /a&#13;&lt;&amp;&quot;\n中/);
    assert.match(
      f.seen[0].body.toString(),
      /<VersionId>v&lt;&amp;<\/VersionId>/,
    );
    for (const value of ["\0", "\u000b", "\ud800"])
      await assert.rejects(
        send(f.client, "DeleteObjects", {
          Delete: { Objects: [{ Key: value }] },
        }),
        { name: "NotImplemented" },
      );
    assert.equal(f.seen.length, 1);
    assert.ok(f.seen[0].headers["content-md5"]);
  } finally {
    await f.close();
  }
});
test("COS rejects unsupported fields and nested fields without sending requests", async () => {
  const f = await fixture((e, res) => res.end());
  try {
    for (const [name, extra] of [
      ["GetObject", { Unknown: "x" }],
      ["DeleteObject", { IfMatch: '"x"' }],
      ["PutObject", { Body: "x", IfNoneMatch: "*" }],
      ["DeleteObjects", { Delete: { Objects: [{ Key: "x", ETag: "x" }] } }],
      [
        "CompleteMultipartUpload",
        {
          UploadId: "id",
          MultipartUpload: {
            Parts: [{ PartNumber: 1, ETag: "e", ChecksumCRC32: "x" }],
          },
        },
      ],
      [
        "PutObjectTagging",
        { Tagging: { TagSet: [{ Key: "k", Value: "v", Extra: true }] } },
      ],
    ])
      await assert.rejects(send(f.client, name, extra), {
        name: "NotImplemented",
      });
    assert.equal(f.seen.length, 0);
  } finally {
    await f.close();
  }
});
test("COS copy preserves encoded literal version delimiters and explicit versions", async () => {
  const f = await fixture((e, res) =>
    res.end(
      '<CopyObjectResult><ETag>"copy"</ETag><LastModified>2026-10-28T00:00:00Z</LastModified></CopyObjectResult>',
    ),
  );
  try {
    const literal = "bucket-123456/a%3FversionId%3Dliteral";
    await send(f.client, "CopyObject", {
      CopySource: literal,
      CopySourceIfMatch: '"source"',
      MetadataDirective: "REPLACE",
      Metadata: { case: "value" },
      ContentType: "text/plain",
      TaggingDirective: "COPY",
    });
    assert.equal(
      f.seen[0].headers["x-cos-copy-source"],
      "bucket-123456.cos.ap-guangzhou.myqcloud.com/a%3FversionId%3Dliteral",
    );
    assert.equal(f.seen[0].headers["x-cos-copy-source-if-match"], '"source"');
    assert.equal(f.seen[0].headers["x-cos-meta-case"], "value");
    await send(f.client, "CopyObject", {
      CopySource: literal + "?versionId=opaque%2F%2B%3D",
    });
    assert.ok(
      f.seen[1].headers["x-cos-copy-source"].endsWith(
        "?versionId=opaque%2F%2B%3D",
      ),
    );
  } finally {
    await f.close();
  }
});
test("COS official native signed URLs honor endpoint/token and reject browser dot segments", async () => {
  const f = await fixture((e, res) => res.end());
  try {
    const signed = await f.client.signGet({
      bucket: input.Bucket,
      key: input.Key,
      expiresIn: 60,
    });
    const u = new URL(signed);
    assert.equal(
      u.origin,
      f.connection.endpoint.replace("://", "://bucket-123456."),
    );
    assert.equal(u.pathname, "/raw%20/%E4%B8%AD%3F%23%25");
    assert.equal(u.searchParams.get("q-sign-algorithm"), "sha1");
    assert.equal(u.searchParams.get("x-cos-security-token"), "temporary");
    await assert.rejects(
      f.client.signGet({ bucket: input.Bucket, key: "a/../b", expiresIn: 60 }),
      { name: "NotImplemented" },
    );
  } finally {
    await f.close();
  }
});
test("COS has exactly one wire attempt for service failures", async () => {
  const f = await fixture((e, res) => {
    res.writeHead(503);
    res.end("<Error><Code>SlowDown</Code></Error>");
  });
  try {
    await assert.rejects(send(f.client, "ListObjectsV2"), { name: "SlowDown" });
    assert.equal(f.seen.length, 1);
  } finally {
    await f.close();
  }
});
test("COS abort before request, stalled headers and deadline tear down actual requests", async () => {
  const f = await fixture(() => {}, { timeoutMs: 50 });
  try {
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(
      f.client.send(new GetObjectCommand(input), { abortSignal: pre.signal }),
      { name: "AbortError" },
    );
    assert.equal(f.seen.length, 0);
    const c = new AbortController();
    const pending = f.client.send(new GetObjectCommand(input), {
      abortSignal: c.signal,
    });
    setTimeout(() => c.abort(), 10);
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(send(f.client, "GetObject"), { name: "TimeoutError" });
  } finally {
    await f.close();
  }
});
test("COS abort and timeout remain active after streaming headers", async () => {
  for (const mode of ["abort", "timeout"]) {
    const f = await fixture(
      (e, res) => {
        res.writeHead(200, { "content-length": "999" });
        res.write("part");
      },
      { timeoutMs: 80 },
    );
    try {
      const c = new AbortController();
      const out = await f.client.send(new GetObjectCommand(input), {
        abortSignal: c.signal,
      });
      const consumed = (async () => {
        for await (const chunk of out.Body) {
        }
      })();
      if (mode === "abort") c.abort();
      await assert.rejects(consumed, {
        name: mode === "abort" ? "AbortError" : "TimeoutError",
      });
    } finally {
      await f.close();
    }
  }
});
test("COS SDK factory sees native secure configuration and host-bound signing fields", async () => {
  let options, signing;
  const f = await fixture((e, res) => res.end());
  const client = createCosClient(
    f.connection,
    credentials,
    {},
    {
      lookup: (_host, _opts, cb) =>
        cb(null, [{ address: "127.0.0.1", family: 4 }]),
      sdkFactory: (o) => {
        options = o;
        const real = new COS(o);
        return {
          getAuth(p) {
            signing = p;
            return real.getAuth(p);
          },
        };
      },
    },
  );
  try {
    await send(client, "HeadObject", {
      IfMatch: '"opaque"',
      VersionId: "v /+=",
    });
    assert.equal(options.StrictSsl, true);
    assert.equal(options.KeepAlive, false);
    assert.equal(options.ChunkRetryTimes, 0);
    assert.equal(options.AutoSwitchHost, false);
    assert.equal(options.CorrectClockSkew, false);
    assert.equal(options.ServiceDomain, new URL(f.connection.endpoint).host);
    assert.equal(signing.Headers["if-match"], '"opaque"');
    assert.equal(signing.Query.versionId, "v /+=");
  } finally {
    client.destroy();
    await f.close();
  }
});
test("COS actual uploadObject coordinator handles small and >8MiB multipart uploads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "storagelab-cos-"));
  const f = await fixture((e, res) => {
    if (e.method === "POST" && e.url.includes("uploads="))
      res.end(
        "<InitiateMultipartUploadResult><UploadId>opaque/+=</UploadId></InitiateMultipartUploadResult>",
      );
    else if (e.method === "POST" && e.url.includes("uploadId="))
      res.end(
        '<CompleteMultipartUploadResult><ETag>"complete"</ETag><Key>target</Key><Bucket>bucket-123456</Bucket></CompleteMultipartUploadResult>',
      );
    else {
      res.setHeader("ETag", '"part"');
      res.end();
    }
  });
  try {
    for (const size of [7, 9 * 1024 * 1024]) {
      const path = join(directory, `${size}.txt`);
      await writeFile(path, Buffer.alloc(size, 65));
      const r = await uploadObject({
        client: f.client,
        bucket: input.Bucket,
        key: "target",
        path,
        overwrite: true,
        signal: new AbortController().signal,
        onProgress() {},
      });
      assert.equal(r.bytesTransferred, size);
    }
    const parts = f.seen.filter((e) => e.url.includes("partNumber="));
    assert.equal(parts.length, 2);
    assert.equal(
      parts.reduce((n, e) => n + e.body.length, 0),
      9 * 1024 * 1024,
    );
    assert.match(
      f.seen
        .find((e) => e.method === "POST" && e.url.includes("uploadId="))
        .body.toString(),
      /<ETag>&quot;part&quot;<\/ETag>/,
    );
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("COS uncertain POST failure and dropped connection never retry", async () => {
  for (const drop of [false, true]) {
    const f = await fixture((e, res) => {
      if (drop) res.destroy();
      else {
        res.writeHead(500);
        res.end("<Error><Code>InternalError</Code></Error>");
      }
    });
    try {
      await assert.rejects(
        send(f.client, "CreateMultipartUpload", { Metadata: { k: "v" } }),
      );
      assert.equal(f.seen.length, 1);
    } finally {
      await f.close();
    }
  }
});
test("COS tag writes/deletion keep version and XML raw values", async () => {
  const f = await fixture((e, res) => res.end());
  try {
    await send(f.client, "PutObjectTagging", {
      VersionId: "opaque/+=",
      Tagging: { TagSet: [{ Key: "<&\r中", Value: '"value' }] },
    });
    await send(f.client, "DeleteObjectTagging", { VersionId: "opaque/+=" });
    assert.equal(f.seen[0].method, "PUT");
    assert.equal(f.seen[1].method, "DELETE");
    assert.equal(
      new URL(f.seen[0].url, "http://local").searchParams.get("versionId"),
      "opaque/+=",
    );
    assert.match(f.seen[0].body.toString(), /<Key>&lt;&amp;&#13;中<\/Key>/);
  } finally {
    await f.close();
  }
});
test("COS multipart repeated initial metadata is safe and changed metadata rejected", async () => {
  const f = await fixture((e, res) => {
    if (e.url.includes("uploads="))
      res.end(
        "<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>",
      );
    else {
      res.setHeader("etag", '"part"');
      res.end(
        '<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>',
      );
    }
  });
  try {
    const initial = {
      Metadata: { Key: "raw" },
      Tagging: "tag=value",
      ContentType: "text/plain",
      ContentLength: 9,
    };
    await send(f.client, "CreateMultipartUpload", initial);
    await send(f.client, "UploadPart", {
      ...initial,
      ContentLength: 3,
      Body: Buffer.from("abc"),
      UploadId: "upload",
      PartNumber: 1,
    });
    await assert.rejects(
      send(f.client, "UploadPart", {
        ...initial,
        Metadata: { Key: "changed" },
        Body: Buffer.from("abc"),
        UploadId: "upload",
        PartNumber: 2,
      }),
      { name: "NotImplemented" },
    );
    await send(f.client, "CompleteMultipartUpload", {
      ...initial,
      UploadId: "upload",
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"part"' }] },
    });
    assert.equal(f.seen.length, 3);
    assert.equal(f.seen[0].headers["x-cos-meta-key"], "raw");
    assert.equal(f.seen[1].headers["x-cos-meta-key"], undefined);
  } finally {
    await f.close();
  }
});
test("COS native rejects path style and bucket-bound standard endpoint", () => {
  assert.throws(
    () =>
      createCosClient(
        {
          endpoint: "https://cos.ap-guangzhou.myqcloud.com",
          forcePathStyle: true,
        },
        credentials,
        {},
      ),
    { name: "NotImplemented" },
  );
  assert.throws(
    () =>
      createCosClient(
        { endpoint: "https://bucket-123456.cos.ap-guangzhou.myqcloud.com" },
        credentials,
        {},
      ),
    { name: "NotImplemented" },
  );
});

import cosUtil from "cos-nodejs-sdk-v5/sdk/util.js";
test("COS wire signature binds actual raw path, opaque query and condition/token headers", async () => {
  const f = await fixture((e, res) => res.end("body"));
  try {
    const out = await send(f.client, "GetObject", {
      VersionId: "opaque/+ ?=",
      IfMatch: '"etag"',
      Range: "bytes=0-3",
    });
    for await (const c of out.Body) {
    }
    const wire = f.seen[0];
    const auth = new URLSearchParams(wire.headers.authorization);
    const query = Object.fromEntries(
      new URLSearchParams(wire.url.split("?")[1]),
    );
    const signed = cosUtil.getAuth({
      SecretId: credentials.accessKeyId,
      SecretKey: credentials.secretAccessKey,
      UseRawKey: true,
      Method: wire.method,
      Key: decodeURIComponent(wire.url.split("?")[0].slice(1)),
      Query: query,
      Headers: wire.headers,
      KeyTime: auth.get("q-key-time"),
    });
    assert.equal(signed, wire.headers.authorization);
    assert.match(wire.headers.authorization, /q-url-param-list=versionid/);
    assert.match(wire.headers.authorization, /x-cos-security-token/);
    assert.equal(wire.headers["if-match"], '"etag"');
    assert.equal(wire.headers.range, "bytes=0-3");
  } finally {
    await f.close();
  }
});
test("COS bucket listing and metadata normalize singleton responses and headers", async () => {
  const f = await fixture((e, res) => {
    if (e.method === "HEAD") {
      res.setHeader("content-length", "7");
      res.setHeader("content-type", "text/plain");
      res.setHeader("x-cos-version-id", "opaque/+=");
      res.setHeader("x-cos-meta-case", "raw");
      res.setHeader("etag", '"opaque"');
      res.end();
    } else
      res.end(
        "<ListAllMyBucketsResult><Buckets><Bucket><Name>bucket-123456</Name></Bucket></Buckets><NextMarker>opaque/+</NextMarker></ListAllMyBucketsResult>",
      );
  });
  try {
    const listed = await f.client.send(
      new commands.ListBucketsCommand({
        Prefix: "bucket",
        MaxBuckets: 200,
        ContinuationToken: "opaque/+",
      }),
    );
    assert.equal(listed.Buckets[0].Name, input.Bucket);
    assert.equal(listed.ContinuationToken, "opaque/+");
    assert.equal(
      new URL(f.seen[0].url, "http://local").searchParams.get("marker"),
      "opaque/+",
    );
    const head = await send(f.client, "HeadObject", { IfNoneMatch: '"other"' });
    assert.equal(head.ContentLength, 7);
    assert.equal(head.Metadata.case, "raw");
    assert.equal(head.VersionId, "opaque/+=");
    assert.equal(head.ETag, '"opaque"');
  } finally {
    await f.close();
  }
});
test("COS destroy closes active streaming response and rejects later operations", async () => {
  const f = await fixture((e, res) => {
    res.writeHead(200);
    res.write("part");
  });
  try {
    const out = await send(f.client, "GetObject");
    const consumed = (async () => {
      for await (const chunk of out.Body) {
      }
    })();
    f.client.destroy();
    await assert.rejects(consumed, { name: "AbortError" });
    await assert.rejects(send(f.client, "HeadObject"), {
      name: "NotImplemented",
    });
  } finally {
    await f.close();
  }
});
test("COS custom API service host stays endpoint-bound with bucket virtual hosting", async () => {
  const server = http.createServer((req, res) => {
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let looked;
  const client = createCosClient(
    {
      endpoint: `http://service.internal:${server.address().port}`,
      region: "ap-guangzhou",
    },
    credentials,
    {},
    {
      lookup: (host, opts, cb) => {
        looked = host;
        cb(null, [{ address: "127.0.0.1", family: 4 }]);
      },
    },
  );
  try {
    await send(client, "HeadObject");
    assert.equal(looked, "bucket-123456.service.internal");
    const config = await client.config.endpoint();
    assert.equal(config.hostname, "service.internal");
    assert.equal(client.config.forcePathStyle, false);
    assert.equal(
      await client.config.requestChecksumCalculation(),
      "WHEN_REQUIRED",
    );
  } finally {
    client.destroy();
    await new Promise((r) => server.close(r));
  }
});

import { spawnSync } from "node:child_process";
test("COS malformed XML rejects safely without crashing the host process", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import http from 'node:http';
    import assert from 'node:assert/strict';
    import {ListObjectsV2Command} from '@aws-sdk/client-s3';
    import {createCosClient} from './electron/providers/cos.js';
    const server=http.createServer((req,res)=>res.end('<foo><bar attr="unterminated></bar>'));
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const client=createCosClient({endpoint:'http://cos.ap-guangzhou.myqcloud.com:'+server.address().port,region:'ap-guangzhou'}, {accessKeyId:'id',secretAccessKey:'secret'}, {}, {lookup:(host,opts,cb)=>cb(null,[{address:'127.0.0.1',family:4}])});
    try {
      await assert.rejects(client.send(new ListObjectsV2Command({Bucket:'bucket-123456'})), error=>{
        assert.equal(error.name,'InvalidResponse');
        assert.equal(error.message,'COS request failed.');
        assert.equal(error.message.includes('unterminated'),false);
        return true;
      });
      console.log('host survived malformed XML');
    } finally {client.destroy(); await new Promise(r=>server.close(r));}
  `,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /host survived malformed XML/);
});

test("COS copy maps internal directives to native Copy/Replaced on the wire", async () => {
  const f = await fixture((entry, res) => {
    if (
      !["Copy", "Replaced"].includes(
        entry.headers["x-cos-metadata-directive"],
      ) ||
      !["Copy", "Replaced"].includes(entry.headers["x-cos-tagging-directive"])
    ) {
      res.writeHead(400);
      res.end("<Error><Code>InvalidArgument</Code></Error>");
    } else res.end('<CopyObjectResult><ETag>"copy"</ETag></CopyObjectResult>');
  });
  try {
    await send(f.client, "CopyObject", {
      CopySource: "bucket-123456/raw",
      CopySourceIfMatch: '"source"',
      MetadataDirective: "REPLACE",
      Metadata: { raw: "value" },
      TaggingDirective: "COPY",
    });
    assert.equal(f.seen[0].headers["x-cos-metadata-directive"], "Replaced");
    assert.equal(f.seen[0].headers["x-cos-tagging-directive"], "Copy");
    assert.equal(f.seen[0].headers["x-cos-meta-raw"], "value");
    assert.equal(f.seen[0].headers["x-cos-copy-source-if-match"], '"source"');
    await send(f.client, "CopyObject", {
      CopySource: "bucket-123456/raw",
      MetadataDirective: "COPY",
      TaggingDirective: "REPLACE",
      Tagging: "tag=value",
    });
    assert.equal(f.seen[1].headers["x-cos-metadata-directive"], "Copy");
    assert.equal(f.seen[1].headers["x-cos-tagging-directive"], "Replaced");
    assert.equal(f.seen[1].headers["x-cos-tagging"], "tag=value");
    for (const field of ["MetadataDirective", "TaggingDirective"]) {
      await assert.rejects(
        send(f.client, "CopyObject", {
          CopySource: "bucket-123456/raw",
          [field]: "invalid",
        }),
        { name: "NotImplemented" },
      );
    }
    assert.equal(f.seen.length, 2);
  } finally {
    await f.close();
  }
});

test("COS rejects HTTP200 wrong-root and incomplete management responses", async () => {
  for (const [name, extra, body] of [
    ["ListObjectsV2", {}, "<html>gateway response</html>"],
    ["ListObjectVersions", {}, "<html>gateway response</html>"],
    ["GetBucketVersioning", {}, "<html>gateway response</html>"],
    ["GetObjectTagging", {}, "<html>gateway response</html>"],
    [
      "DeleteObjects",
      { Delete: { Objects: [{ Key: "raw" }] } },
      "<html>gateway response</html>",
    ],
    ["ListParts", { UploadId: "upload" }, "<html>gateway response</html>"],
    [
      "CopyObject",
      { CopySource: "bucket-123456/raw" },
      "<html>gateway response</html>",
    ],
    [
      "CopyObject",
      { CopySource: "bucket-123456/raw" },
      "<CopyObjectResult><LastModified>2026-10-28T00:00:00Z</LastModified></CopyObjectResult>",
    ],
    [
      "CopyObject",
      { CopySource: "bucket-123456/raw" },
      "<CopyObjectResult>not an object</CopyObjectResult>",
    ],
    [
      "CreateMultipartUpload",
      {},
      "<InitiateMultipartUploadResult><Bucket>bucket-123456</Bucket></InitiateMultipartUploadResult>",
    ],
    [
      "CompleteMultipartUpload",
      { UploadId: "upload", MultipartUpload: { Parts: [] } },
      "<CompleteMultipartUploadResult><Bucket>bucket-123456</Bucket></CompleteMultipartUploadResult>",
    ],
    [
      "CompleteMultipartUpload",
      { UploadId: "upload", MultipartUpload: { Parts: [] } },
      "<html>gateway response</html>",
    ],
  ]) {
    const f = await fixture((entry, res) => res.end(body));
    try {
      await assert.rejects(send(f.client, name, extra), {
        name: "InvalidResponse",
        message: "COS request failed.",
      });
    } finally {
      await f.close();
    }
  }
});
test("COS retains legitimate empty responses for bodyless operations and disabled versioning", async () => {
  const f = await fixture((entry, res) => {
    if (entry.url.includes("versioning="))
      res.end("<VersioningConfiguration/>");
    else {
      res.setHeader("etag", '"stored"');
      res.end();
    }
  });
  try {
    for (const [name, extra] of [
      ["HeadObject", {}],
      ["PutObject", { Body: Buffer.from("x") }],
      ["DeleteObject", {}],
      ["PutObjectTagging", { Tagging: { TagSet: [] } }],
      ["DeleteObjectTagging", {}],
      ["AbortMultipartUpload", { UploadId: "upload" }],
    ])
      await send(f.client, name, extra);
    assert.equal(
      (await send(f.client, "GetBucketVersioning")).Status,
      undefined,
    );
  } finally {
    await f.close();
  }
});
