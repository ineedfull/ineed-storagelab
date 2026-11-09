import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";
import {
  integrationConfig,
  createIntegrationFixture,
  waitForJobs,
} from "./setup.js";
import { createService } from "../../electron/service.js";
import { createS3Client } from "../../electron/s3/client.js";
import { createCheckpointStore } from "../../electron/transfers/checkpoints.js";
const config = await integrationConfig();
test(
  "real MinIO: private part1 survives service/store restart, reauthorization skips it and independent body SHA256 matches",
  { skip: !config },
  async () => {
    const f = await createIntegrationFixture(config, {
      temporaryRoot: process.env.STORAGELAB_TEST_TEMPORARY_ROOT,
    });
    let service;
    try {
      const body = Buffer.alloc(8 * 1024 * 1024 * 2 + 179, 65),
        path = join(f.directory, "source.bin");
      await writeFile(path, body);
      f.selectUploads([path]);
      const checkpoints = createCheckpointStore(
        join(f.directory, "profile", "upload-checkpoints"),
      );
      const app = {
        getPath: () => join(f.directory, "profile"),
        getName: () => "test",
        getVersion: () => "test",
      };
      let fail = true;
      const numbers = [];
      const factory = (...args) => {
        const c = createS3Client(...args),
          send = c.send.bind(c);
        c.send = async (command, ...options) => {
          if (command.constructor.name === "UploadPartCommand") {
            numbers.push(command.input.PartNumber);
            if (fail && command.input.PartNumber === 2)
              throw new Error("test disconnect before second part");
          }
          return send(command, ...options);
        };
        return c;
      };
      const make = () =>
        createService({
          store: f.store,
          dialog: f.dialog,
          app,
          clientFactory: factory,
        });
      service = make();
      let { jobs } = await service.invoke("uploadFiles", {
        connectionId: f.profile.id,
        bucket: f.bucket,
        overwrite: true,
        resumable: true,
      });
      const [stopped] = await waitForJobs(
        service,
        jobs.map((j) => j.id),
      );
      assert.equal(stopped.state, "failed");
      assert.equal(stopped.resumeAvailable, true);
      const [record] = await checkpoints.list();
      assert.equal(record.parts.length, 1);
      assert.equal(record.parts[0].size, 8 * 1024 * 1024);
      const remote = await f.client.send(
        new ListPartsCommand({
          Bucket: f.bucket,
          Key: "source.bin",
          UploadId: record.uploadId,
        }),
      );
      assert.equal(remote.Parts.length, 1);
      const raw = await readFile(
        join(f.directory, "profile", "upload-checkpoints", record.id + ".json"),
        "utf8",
      );
      assert.ok(!raw.includes(path));
      assert.ok(!raw.includes(config.secretAccessKey));
      await service.dispose();
      await f.reopen();
      service = make();
      await assert.rejects(service.invoke("resumeUpload", { id: stopped.id }), {
        code: "CREDENTIALS_REQUIRED",
      });
      f.store.saveConnection({
        connection: f.store.getConnection(f.profile.id),
        credentialStorage: "session",
        credentials: f.credentials,
      });
      const original = f.store.getConnection(f.profile.id);
      f.store.saveConnection({
        connection: { ...original, region: "changed-region" },
        credentialStorage: "session",
      });
      await assert.rejects(service.invoke("resumeUpload", { id: stopped.id }), {
        code: "CONNECTION_CHANGED",
      });
      f.confirmDelete(false);
      assert.deepEqual(
        await service.invoke("discardUpload", { id: stopped.id }),
        { cancelled: true },
      );
      f.confirmDelete(true);
      f.store.saveConnection({
        connection: original,
        credentialStorage: "session",
      });
      const wrong = join(f.directory, "wrong.bin");
      await writeFile(wrong, Buffer.alloc(body.length, 66));
      f.selectUploads([wrong]);
      await assert.rejects(service.invoke("resumeUpload", { id: stopped.id }), {
        code: "FILE_MISMATCH",
      });
      const moved = join(f.directory, "new-location.bin");
      await writeFile(moved, body);
      f.selectUploads([moved]);
      fail = false;
      ({ jobs } = await service.invoke("resumeUpload", { id: stopped.id }));
      const [complete] = await waitForJobs(
        service,
        jobs.map((j) => j.id),
      );
      assert.equal(complete.state, "success");
      assert.equal(numbers.filter((n) => n === 1).length, 1);
      const response = await f.client.send(
        new GetObjectCommand({ Bucket: f.bucket, Key: "source.bin" }),
      );
      const downloaded = await response.Body.transformToByteArray();
      const hash = (b) => createHash("sha256").update(b).digest("hex");
      assert.equal(hash(downloaded), hash(body));
      assert.deepEqual(await checkpoints.list(), []);
      const publicRows = JSON.stringify(await service.invoke("listJobs"));
      assert.ok(!publicRows.includes(record.uploadId));
      assert.ok(!publicRows.includes(path));
      // Explicit abandonment, unlike cancellation, removes real provider parts.
      fail = true;
      f.selectUploads([path]);
      ({ jobs } = await service.invoke("uploadFiles", {
        connectionId: f.profile.id,
        bucket: f.bucket,
        prefix: "discard-",
        overwrite: true,
        resumable: true,
      }));
      const [abandoned] = await waitForJobs(
        service,
        jobs.map((j) => j.id),
      );
      assert.equal(abandoned.resumeAvailable, true);
      const [abandonedRecord] = await checkpoints.list();
      assert.deepEqual(
        await service.invoke("discardUpload", { id: abandoned.id }),
        { discarded: true },
      );
      const pending = await f.client.send(
        new ListMultipartUploadsCommand({ Bucket: f.bucket }),
      );
      // MinIO 2024 can briefly include another bucket's upload in this list
      // during parallel tests. Verify this exact upload and its actual parts.
      assert.equal(
        (pending.Uploads ?? []).some(
          (upload) => upload.UploadId === abandonedRecord.uploadId,
        ),
        false,
      );
      await assert.rejects(
        f.client.send(
          new ListPartsCommand({
            Bucket: f.bucket,
            Key: abandonedRecord.key,
            UploadId: abandonedRecord.uploadId,
          }),
        ),
        (error) => error.name === "NoSuchUpload",
      );
    } finally {
      await service?.dispose();
      await f.cleanup();
    }
  },
);
