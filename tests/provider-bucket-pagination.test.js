import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import ObsClient from "esdk-obs-nodejs";
import { createOssClient } from "../electron/providers/oss.js";
import { createObsClient } from "../electron/providers/obs.js";
import { createCosClient } from "../electron/providers/cos.js";
import { createTosClient } from "../electron/providers/tos.js";
import { createS3Client } from "../electron/s3/client.js";
import { createS3Operations } from "../electron/s3/operations.js";
const credentials = {
  accessKeyId: "fixture-access",
  secretAccessKey: "fixture-secret",
};
const lookup = (_host, opts, cb) =>
  cb(null, opts.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
for (const [provider, factory] of Object.entries({
  S3: createS3Client,
  OSS: createOssClient,
  OBS: createObsClient,
  COS: createCosClient,
  TOS: createTosClient,
})) {
  test(`${provider}: official SDK enumerates bucket pages using its native wire contract`, async () => {
    const calls = [],
      cursor = "opaque /+雪=";
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://fixture");
      calls.push(u);
      const next = calls.length === 1,
        bucket = next ? "first" : "second";
      if (provider === "TOS") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ Buckets: [{ Name: "all" }] }));
        return;
      }
      const marker = provider === "S3" ? "ContinuationToken" : "NextMarker";
      res.setHeader("content-type", "application/xml");
      res.end(
        `<ListAllMyBucketsResult><IsTruncated>${next}</IsTruncated>${next ? `<${marker}>${cursor}</${marker}>` : ""}<Buckets><Bucket><Name>${bucket}</Name><CreationDate>2026-10-30T00:00:00Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`,
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const connection = {
      provider: provider.toLowerCase(),
      endpoint: `http://127.0.0.1:${port}`,
      region: "cn-hangzhou",
      forcePathStyle: true,
    };
    const agent = new http.Agent({ lookup }),
      options = {};
    if (provider === "COS") {
      connection.endpoint = `http://cos.ap-guangzhou.myqcloud.com:${port}`;
      connection.region = "ap-guangzhou";
      connection.forcePathStyle = false;
      options.lookup = lookup;
    }
    if (provider === "OBS") {
      connection.endpoint = `http://obs.cn-test.myhuaweicloud.com:${port}`;
      connection.forcePathStyle = false;
      options.sdkFactory = (opts) =>
        new ObsClient({
          ...opts,
          http_agent: agent,
          third_http_lib: {
            request: (opts) => http.request({ ...opts, agent }),
          },
        });
    }
    const client = factory(
      connection,
      credentials,
      { timeoutSeconds: 2 },
      options,
    );
    try {
      const result = await createS3Operations({
        client,
        connection,
      }).listBuckets();
      assert.deepEqual(
        result.buckets.map((b) => b.name),
        provider === "TOS" ? ["all"] : ["first", "second"],
      );
      assert.equal(calls.length, provider === "TOS" ? 1 : 2);
      if (calls.length === 2)
        assert.equal(
          calls[1].searchParams.get(
            provider === "S3" ? "continuation-token" : "marker",
          ),
          cursor,
        );
      else assert.equal([...calls[0].searchParams].length, 0);
    } finally {
      client.destroy();
      agent.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
}
