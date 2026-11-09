import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PutObjectCommand,
  PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import {
  integrationConfig,
  createIntegrationFixture,
  waitForJobs,
} from "./setup.js";
import {
  seedVersionHistory,
  readVersionContent,
  readVersionHistory,
} from "./version-fixture.js";
const config = await integrationConfig();
test(
  "real MinIO paginates 201 versions of a whitespace raw Key without including prefix neighbors",
  { skip: !config },
  async () => {
    const f = await createIntegrationFixture(config);
    try {
      await f.client.send(
        new PutBucketVersioningCommand({
          Bucket: f.bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
      for (let i = 0; i < 201; i++)
        await f.client.send(
          new PutObjectCommand({ Bucket: f.bucket, Key: " ", Body: String(i) }),
        );
      await f.client.send(
        new PutObjectCommand({
          Bucket: f.bucket,
          Key: " neighbor",
          Body: "excluded",
        }),
      );
      const p = { connectionId: f.profile.id, bucket: f.bucket, key: " " };
      const first = await f.service.invoke("listObjectVersions", p);
      assert.equal(first.entries.length, 200);
      assert.equal(typeof first.nextPage.keyMarker, "string");
      assert.ok(first.nextPage.versionIdMarker);
      const second = await f.service.invoke("listObjectVersions", {
        ...p,
        ...first.nextPage,
      });
      assert.equal(second.entries.length, 1);
      assert.equal(second.nextPage, undefined);
      assert.ok(
        [...first.entries, ...second.entries].every((v) => v.key === " "),
      );
      assert.equal(
        new Set([...first.entries, ...second.entries].map((v) => v.versionId))
          .size,
        201,
      );
    } finally {
      await f.cleanup();
    }
  },
);
test(
  "real MinIO deleted object history, historical download and restore preserve original versions, metadata and tags",
  { skip: !config },
  async () => {
    const f = await createIntegrationFixture(config);
    try {
      const h = await seedVersionHistory(f);
      const p = { connectionId: f.profile.id, bucket: f.bucket, key: h.key };
      const versions = await f.service.invoke("listObjectVersions", p);
      assert.equal(versions.versioning, "enabled");
      assert.equal(versions.entries.length, 3);
      assert.equal(versions.entries[0].deleteMarker, true);
      assert.equal(versions.entries[0].versionId, h.marker);
      const head = await f.service.invoke("headObjectVersion", {
        ...p,
        versionId: h.old,
      });
      assert.equal(head.metadata.purpose, "historical");
      const directory = join(f.directory, "downloads");
      await mkdir(directory);
      f.selectDownloadDirectory(directory);
      const { jobs } = await f.service.invoke("downloadObjectVersion", {
        ...p,
        versionId: h.old,
        overwrite: false,
      });
      const completed = await waitForJobs(
        f.service,
        jobs.map((j) => j.id),
      );
      assert.equal(completed[0].state, "success", completed[0].error);
      assert.equal(completed[0].versionId, h.old);
      assert.equal(
        await readFile(join(directory, h.key), "utf8"),
        "old historical body\n",
      );
      const duplicate = await f.service.invoke("downloadObjectVersion", {
        ...p,
        versionId: h.newer,
        overwrite: false,
      });
      const rejected = await waitForJobs(
        f.service,
        duplicate.jobs.map((j) => j.id),
      );
      assert.equal(rejected[0].state, "failed");
      assert.equal(
        await readFile(join(directory, h.key), "utf8"),
        "old historical body\n",
      );
      f.confirmDelete(false);
      assert.equal(
        (
          await f.service.invoke("restoreObjectVersion", {
            ...p,
            versionId: h.old,
          })
        ).cancelled,
        true,
      );
      assert.equal((await readVersionHistory(f, h.key)).versions.length, 2);
      f.confirmDelete(true);
      const restored = await f.service.invoke("restoreObjectVersion", {
        ...p,
        versionId: h.old,
      });
      assert.equal(restored.restored, true);
      assert.ok(restored.versionId && restored.versionId !== h.old);
      const result = await readVersionContent(f, h.key);
      assert.equal(result.content, "old historical body\n");
      assert.equal(result.metadata.purpose, "historical");
      assert.deepEqual(result.tags, [{ Key: "env", Value: "old" }]);
      const history = await readVersionHistory(f, h.key);
      assert.equal(history.versions.length, 3);
      assert.ok(history.versions.includes(h.old));
      assert.ok(history.versions.includes(h.newer));
      assert.deepEqual(history.markers, [h.marker]);
    } finally {
      await f.cleanup();
    }
  },
);
