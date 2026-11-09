import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ObsClient from "esdk-obs-nodejs";
import { createOssClient } from "../electron/providers/oss.js";
import { createObsClient } from "../electron/providers/obs.js";
import { createCosClient } from "../electron/providers/cos.js";
import { createTosClient } from "../electron/providers/tos.js";
import { downloadObject } from "../electron/transfers/download.js";
const factories = {
  OSS: createOssClient,
  OBS: createObsClient,
  COS: createCosClient,
  TOS: createTosClient,
};
const credentials = {
  accessKeyId: "fixture-access",
  secretAccessKey: "fixture-secret",
};
const lookup = (_host, options, cb) =>
  cb(
    null,
    options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1",
    4,
  );
// Each official SDK signs and parses real HTTP. COS/OBS DNS routes only to loopback.
async function fixture(provider, mode, run) {
  const directory = await mkdtemp(join(tmpdir(), "storagelab-timeout-"));
  const agent = new http.Agent({ lookup });
  const chunk = Buffer.alloc(1024, 42),
    count = 12;
  let writes = 0;
  const server = http.createServer((_req, res) => {
    if (mode === "headers") return;
    res.writeHead(200, {
      "content-length": chunk.length * count,
      "content-type": "application/octet-stream",
    });
    res.write(chunk);
    writes++;
    if (mode !== "flow") return;
    const timer = setInterval(() => {
      res.write(chunk);
      if (++writes === count) {
        clearInterval(timer);
        res.end();
      }
    }, 80);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const connection = {
    endpoint: `http://127.0.0.1:${port}`,
    region: "cn-hangzhou",
    forcePathStyle: true,
  };
  const options = {};
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
        third_http_lib: { request: (opts) => http.request({ ...opts, agent }) },
      });
  }
  const client = factories[provider](
    connection,
    credentials,
    { timeoutSeconds: 0.4 },
    options,
  );
  const ac = new AbortController();
  let progress = 0;
  const download = () =>
    downloadObject({
      client,
      bucket: "fixture-123456",
      key: "download.bin",
      directory,
      overwrite: false,
      signal: ac.signal,
      onProgress: () => progress++,
    });
  try {
    await run({
      client,
      download,
      ac,
      directory,
      bytes: Buffer.alloc(chunk.length * count, 42),
      progress: () => progress,
    });
  } finally {
    client.destroy();
    agent.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(directory, { recursive: true, force: true });
  }
}
for (const provider of Object.keys(factories)) {
  test(`${provider}: continuous download exceeds timeout without losing first or later bytes`, async () =>
    fixture(provider, "flow", async ({ download, directory, bytes }) => {
      const start = Date.now();
      await download();
      assert.ok(Date.now() - start > 800);
      assert.deepEqual(await readFile(join(directory, "download.bin")), bytes);
    }));
  for (const mode of ["headers", "stalled"])
    test(`${provider}: ${mode} wait remains bounded and removes partial file`, async () =>
      fixture(provider, mode, async ({ download, directory }) => {
        const start = Date.now();
        await assert.rejects(download(), { name: "TimeoutError" });
        assert.ok(Date.now() - start < 2500);
        assert.deepEqual(await readdir(directory), []);
      }));
  for (const reason of ["cancel", "destroy"])
    test(`${provider}: ${reason} stops streaming and cleans partial file`, async () =>
      fixture(
        provider,
        "stalled",
        async ({ download, ac, client, directory }) => {
          const timer = setTimeout(
            () => (reason === "cancel" ? ac.abort() : client.destroy()),
            100,
          );
          try {
            await assert.rejects(download(), { name: "AbortError" });
            assert.deepEqual(await readdir(directory), []);
          } finally {
            clearTimeout(timer);
          }
        },
      ));
}
