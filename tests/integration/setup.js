// Native-only reusable fixture. Never import this module into renderer or main production composition.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../../electron/s3/client.js";
import { createStore } from "../../electron/store.js";
import { createVault } from "../../electron/vault.js";
import { createService } from "../../electron/service.js";
export async function integrationConfig() {
  if (process.env.STORAGELAB_TEST_CONFIG)
    return JSON.parse(
      await readFile(process.env.STORAGELAB_TEST_CONFIG, "utf8"),
    );
  if (!process.env.STORAGELAB_TEST_ENDPOINT) return;
  return {
    endpoint: process.env.STORAGELAB_TEST_ENDPOINT,
    accessKeyId: process.env.STORAGELAB_TEST_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGELAB_TEST_SECRET_ACCESS_KEY,
  };
}
export async function createIntegrationFixture(config, options = {}) {
  const url = new URL(config.endpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error(
      "Integration endpoint must be loopback; no production defaults.",
    );
  const directory = await mkdtemp(
    join(options.temporaryRoot ?? tmpdir(), "storagelab-integration-"),
  );
  const bucket = `storagelab-${randomUUID()}`;
  let client,
    store,
    service,
    bucketCreated = false,
    cleanupPromise;
  function cleanup() {
    return (cleanupPromise ??= (async () => {
      let error;
      async function attempt(fn) {
        try {
          await fn();
        } catch (e) {
          error ??= e;
        }
      }
      await attempt(() => service?.dispose());
      await attempt(() => store?.close());
      await attempt(async () => {
        if (!bucketCreated) return;
        const m = await client.send(
          new ListMultipartUploadsCommand({ Bucket: bucket }),
        );
        for (const u of m.Uploads ?? [])
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: u.Key,
              UploadId: u.UploadId,
            }),
          );
        // Test buckets can enable versioning. Remove exact versions and markers,
        // rather than creating more delete markers during cleanup.
        while (true) {
          const r = await client.send(
            new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }),
          );
          const versions = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])];
          if (!versions.length) break;
          const deleted = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Objects: versions.map((v) => ({
                  Key: v.Key,
                  VersionId: v.VersionId,
                })),
              },
            }),
          );
          if (deleted.Errors?.length)
            throw new Error("Isolated version cleanup failed");
        }
        let cursor;
        do {
          const r = await client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              ContinuationToken: cursor,
            }),
          );
          if (r.Contents?.length)
            await client.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: r.Contents.map((o) => ({ Key: o.Key })) },
              }),
            );
          cursor = r.NextContinuationToken;
        } while (cursor);
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        bucketCreated = false;
      });
      await attempt(() => client?.destroy());
      await attempt(() => rm(directory, { recursive: true, force: true }));
      if (error) throw error;
    })());
  }
  try {
    const connection = {
      name: "Isolated MinIO",
      provider: "minio",
      endpoint: config.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      defaultBucket: bucket,
    };
    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    };
    client = createS3Client(connection, credentials, {
      timeoutSeconds: 10,
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
    const vault = createVault({
      safeStorage: { isEncryptionAvailable: () => false },
    });
    store = createStore({ directory: join(directory, "profile"), vault });
    const profile = store.saveConnection({
      connection,
      credentials,
      credentialStorage: "session",
    });
    let selected = [],
      destination = directory,
      confirmation = 0;
    const dialog = {
      showOpenDialog: async (o) => ({
        canceled: false,
        filePaths: o.properties.includes("openFile") ? selected : [destination],
      }),
      showMessageBox: async () => ({ response: confirmation }),
      showSaveDialog: async () => ({ canceled: true }),
      ...options.dialog,
    };
    service = createService({
      store,
      dialog,
      clientFactory: options.clientFactory,
      clipboard: { writeText() {} },
      shell: { openExternal: async () => {} },
      app: {
        getName: () => "StorageLab test",
        getVersion: () => "1.0.0",
        getPath: () => join(directory, "profile"),
      },
    });
    return {
      directory,
      bucket,
      profile,
      client,
      credentials,
      connection,
      dialog,
      get store() {
        return store;
      },
      get service() {
        return service;
      },
      selectUploads(paths) {
        selected = paths;
      },
      selectDownloadDirectory(path) {
        destination = path;
      },
      confirmDelete(value) {
        confirmation = value ? 0 : 1;
      },
      async reopen() {
        await service.dispose();
        store.close();
        store = createStore({ directory: join(directory, "profile"), vault });
        return store;
      },
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Integration setup and rollback failed",
        { cause: error },
      );
    }
    throw error;
  }
}
export async function waitForJobs(service, ids, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rows = await service.invoke("listJobs", {});
    const jobs = ids.map((id) => rows.find((j) => j.id === id));
    if (
      jobs.every(
        (j) => j && !["running", "queued", "cancelling"].includes(j.state),
      )
    )
      return jobs;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for isolated transfer jobs");
}
/** Fault-injection boundary: only account-level bucket enumeration is synthetic403.
 * All object/transfer requests reach the real local provider with original signed Host.
 */
export async function createListDeniedProxy(config) {
  const { createServer, request } = await import("node:http");
  const target = new URL(config.endpoint);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  )
    throw new Error("Proxy requires local HTTP fixture");
  const server = createServer((incoming, outgoing) => {
    if (
      incoming.method === "GET" &&
      new URL(incoming.url, "http://test").pathname === "/"
    ) {
      outgoing.writeHead(403, { "Content-Type": "application/xml" });
      outgoing.end(
        "<Error><Code>AccessDenied</Code><Message>Test-only ListBuckets denial</Message></Error>",
      );
      return;
    }
    const upstream = request(
      {
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    config: {
      ...config,
      endpoint: `http://127.0.0.1:${server.address().port}`,
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
