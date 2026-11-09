import test from "node:test";
import assert from "node:assert/strict";
import {
  PutObjectCommand,
  GetObjectCommand,
  PutBucketVersioningCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { integrationConfig, createIntegrationFixture } from "./setup.js";
const config = await integrationConfig();
test(
  "real MinIO tag CRUD, raw keys, concurrent tags and version isolation preserve object bytes",
  { skip: !config },
  async () => {
    const f = await createIntegrationFixture(config);
    try {
      const key = " 中文/+%?#.txt ",
        p = { connectionId: f.profile.id, bucket: f.bucket, key };
      await f.client.send(
        new PutObjectCommand({
          Bucket: f.bucket,
          Key: key,
          Body: "unchanged",
          Metadata: { purpose: "tags" },
        }),
      );
      const initial = await f.service.invoke("getObjectTags", p);
      assert.deepEqual(initial.tags, []);
      const tags = [
        { key: "env", value: " dev " },
        { key: "owner", value: "" },
      ];
      const binding =
        initial.versionId === undefined ? {} : { versionId: initial.versionId };
      // This isolated MinIO release rejects Unicode tag values; do not conflate
      // provider validation with a network failure or a successful empty tag set.
      await assert.rejects(
        f.service.invoke("saveObjectTags", {
          ...p,
          ...binding,
          originalTags: [],
          tags: [{ key: "env", value: "开发" }],
        }),
        { code: "INVALID_TAGS" },
      );
      await f.service.invoke("saveObjectTags", {
        ...p,
        ...binding,
        originalTags: [],
        tags,
      });
      assert.deepEqual((await f.service.invoke("getObjectTags", p)).tags, tags);
      await assert.rejects(
        f.service.invoke("saveObjectTags", {
          ...p,
          ...binding,
          originalTags: [],
          tags: [],
        }),
        { code: "CONFLICT" },
      );
      await f.service.invoke("saveObjectTags", {
        ...p,
        ...binding,
        originalTags: tags,
        tags: [],
      });
      assert.deepEqual((await f.service.invoke("getObjectTags", p)).tags, []);
      const object = await f.client.send(
        new GetObjectCommand({ Bucket: f.bucket, Key: key }),
      );
      assert.equal(await object.Body.transformToString(), "unchanged");
      assert.equal(object.Metadata.purpose, "tags");
      await f.client.send(
        new PutBucketVersioningCommand({
          Bucket: f.bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
      const v1 = await f.client.send(
        new PutObjectCommand({ Bucket: f.bucket, Key: key, Body: "v1" }),
      );
      const read = await f.service.invoke("getObjectTags", p);
      assert.equal(read.versionId, v1.VersionId);
      const v2 = await f.client.send(
        new PutObjectCommand({ Bucket: f.bucket, Key: key, Body: "v2" }),
      );
      await f.service.invoke("saveObjectTags", {
        ...p,
        versionId: read.versionId,
        tags,
        originalTags: [],
      });
      assert.deepEqual(
        (
          await f.service.invoke("getObjectTags", {
            ...p,
            versionId: v1.VersionId,
          })
        ).tags,
        tags,
      );
      const latest = await f.service.invoke("getObjectTags", p);
      assert.equal(latest.versionId, v2.VersionId);
      assert.deepEqual(latest.tags, []);
    } finally {
      // Fixture's regular cleanup handles current objects; remove all versions first.
      try {
        const r = await f.client.send(
          new ListObjectVersionsCommand({ Bucket: f.bucket }),
        );
        const objects = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].map(
          (v) => ({ Key: v.Key, VersionId: v.VersionId }),
        );
        if (objects.length)
          await f.client.send(
            new DeleteObjectsCommand({
              Bucket: f.bucket,
              Delete: { Objects: objects },
            }),
          );
      } finally {
        await f.cleanup();
      }
    }
  },
);
