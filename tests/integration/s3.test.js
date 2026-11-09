import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PutObjectCommand,
  ListMultipartUploadsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Operations } from "../../electron/s3/operations.js";
import { uploadObject } from "../../electron/transfers/upload.js";
import {
  createIntegrationFixture,
  integrationConfig,
  waitForJobs,
  createListDeniedProxy,
} from "./setup.js";
const config = await integrationConfig();
const hash = (b) => createHash("sha256").update(b).digest("hex");
test(
  "real local S3: multipart, raw keys, pagination, preview, signed GET, SHA256 download, conditional overwrite, cancellation and reopen",
  { skip: !config, timeout: 120000 },
  async () => {
    const proxy =
      process.env.STORAGELAB_TEST_RESTRICTED === "1"
        ? await createListDeniedProxy(config)
        : undefined;
    const activeConfig = proxy?.config ?? config;
    let f;
    try {
      f = await createIntegrationFixture(activeConfig);
      const p = { connectionId: f.profile.id, bucket: f.bucket };
      if (process.env.STORAGELAB_TEST_RESTRICTED === "1") {
        await assert.rejects(
          f.service.invoke("listBuckets", { connectionId: f.profile.id }),
          { code: "ACCESS_DENIED" },
        );
        assert.equal(
          (await f.service.invoke("checkConnection", p)).status,
          "success",
        );
      }
      const payload = randomBytes(17 * 1024 * 1024 + 317);
      const path = join(f.directory, "中文 +% payload.bin");
      await writeFile(path, payload);
      f.selectUploads([path]);
      const { jobs } = await f.service.invoke("uploadFiles", {
        ...p,
        overwrite: false,
      });
      await assert.rejects(
        f.service.invoke("saveConnection", {
          connection: { ...f.profile, name: "busy edit" },
          credentialStorage: "session",
        }),
        { code: "CONNECTION_BUSY" },
      );
      assert.equal(
        (
          await waitForJobs(
            f.service,
            jobs.map((j) => j.id),
          )
        )[0].state,
        "success",
      );
      assert.equal(
        JSON.stringify(await f.service.invoke("listJobs", {})).includes(
          f.credentials.secretAccessKey,
        ),
        false,
      );
      const key = "中文 +% payload.bin";
      const head = await f.service.invoke("headObject", { ...p, key });
      assert.equal(head.size, payload.length);
      await Promise.all(
        [
          " ",
          "中文/+%?#.txt",
          ...Array.from(
            { length: 201 },
            (_, i) => `page-${String(i).padStart(3, "0")}`,
          ),
        ].map((Key) =>
          f.client.send(
            new PutObjectCommand({
              Bucket: f.bucket,
              Key,
              Body: "hello 中文",
              ContentType: "text/plain",
            }),
          ),
        ),
      );
      const page = await f.service.invoke("listObjects", {
        ...p,
        prefix: "page-",
      });
      assert.equal(page.objects.length, 200);
      assert.ok(page.nextCursor);
      assert.equal(
        (
          await f.service.invoke("listObjects", {
            ...p,
            prefix: "page-",
            cursor: page.nextCursor,
          })
        ).objects.length,
        1,
      );
      assert.equal(
        (await f.service.invoke("headObject", { ...p, key: " " })).size,
        12,
      );
      assert.equal(
        (
          await f.service.invoke("previewObject", {
            ...p,
            key: "中文/+%?#.txt",
          })
        ).content,
        "hello 中文",
      );
      const signed = await f.service.invoke("shareObject", {
        ...p,
        key: "中文/+%?#.txt",
        kind: "signed",
        expiresIn: 900,
      });
      const response = await fetch(signed.url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "hello 中文");
      assert.equal(
        new URL(signed.url).host,
        new URL(activeConfig.endpoint).host,
      );
      const downloadDir = join(f.directory, "downloads");
      await mkdir(downloadDir);
      f.selectDownloadDirectory(downloadDir);
      const d = await f.service.invoke("downloadFiles", {
        ...p,
        keys: [key],
        overwrite: false,
      });
      assert.equal(
        (
          await waitForJobs(
            f.service,
            d.jobs.map((j) => j.id),
          )
        )[0].state,
        "success",
      );
      assert.equal(hash(await readFile(join(downloadDir, key))), hash(payload));
      // Inject a concurrent writer between preflight HEAD and conditional multipart completion.
      let race = false;
      const raced = {
        config: f.client.config,
        send: async (command, options) => {
          if (
            command.constructor.name === "CompleteMultipartUploadCommand" &&
            !race
          ) {
            race = true;
            assert.equal(command.input.IfNoneMatch, "*");
            await f.client.send(
              new PutObjectCommand({
                Bucket: f.bucket,
                Key: "race",
                Body: "concurrent",
              }),
            );
          }
          return f.client.send(command, options);
        },
      };
      await assert.rejects(
        uploadObject({
          client: raced,
          bucket: f.bucket,
          key: "race",
          path,
          overwrite: false,
          signal: new AbortController().signal,
          onProgress() {},
        }),
        (e) =>
          e.$metadata?.httpStatusCode === 412 ||
          e.$metadata?.httpStatusCode === 409,
      );
      assert.equal(
        (
          await f.client.send(
            new HeadObjectCommand({ Bucket: f.bucket, Key: "race" }),
          )
        ).ContentLength,
        10,
      );
      const controller = new AbortController();
      await assert.rejects(
        uploadObject({
          client: f.client,
          bucket: f.bucket,
          key: "cancelled",
          path,
          overwrite: false,
          signal: controller.signal,
          onProgress() {
            controller.abort();
          },
        }),
      );
      assert.equal(
        (
          await f.client.send(
            new ListMultipartUploadsCommand({ Bucket: f.bucket }),
          )
        ).Uploads?.length ?? 0,
        0,
      );
      const del = await f.service.invoke("deleteObjects", {
        ...p,
        keys: [" ", "中文/+%?#.txt"],
      });
      assert.equal(del.deleted.length, 2);
      assert.equal(del.errors.length, 0);
      const reopened = await f.reopen();
      assert.equal(reopened.listJobs()[0].state, "success");
      assert.equal(reopened.getCredentials(f.profile.id), undefined);
    } finally {
      try {
        await f?.cleanup();
      } finally {
        await proxy?.close();
      }
    }
  },
);
