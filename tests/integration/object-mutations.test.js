import test from "node:test";
import assert from "node:assert/strict";
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectTaggingCommand,
} from "@aws-sdk/client-s3";
import { integrationConfig, createIntegrationFixture } from "./setup.js";
const config = await integrationConfig();
test(
  "real MinIO conditional copy/delete gates, controlled mutations preserve body/tags",
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
          Body: "body",
          ContentType: "text/plain",
          ContentDisposition: "inline",
          ContentLanguage: "en",
          Metadata: { old: "yes" },
          Tagging: "env=test",
        }),
      );
      await f.client.send(
        new PutObjectCommand({
          Bucket: f.bucket,
          Key: "occupied",
          Body: "occupied",
        }),
      );
      // This pinned MinIO ignores both conditions. Verify independently and never
      // promote provider capabilities from a HEAD existence check.
      await f.client.send(
        new CopyObjectCommand({
          Bucket: f.bucket,
          Key: "occupied",
          CopySource: `${f.bucket}/${encodeURIComponent(key)}`,
          IfNoneMatch: "*",
        }),
      );
      assert.equal(
        await (
          await f.client.send(
            new GetObjectCommand({ Bucket: f.bucket, Key: "occupied" }),
          )
        ).Body.transformToString(),
        "body",
      );
      await f.client.send(
        new PutObjectCommand({
          Bucket: f.bucket,
          Key: "sacrifice",
          Body: "data",
        }),
      );
      await f.client.send(
        new DeleteObjectCommand({
          Bucket: f.bucket,
          Key: "sacrifice",
          IfMatch: '"wrong"',
        }),
      );
      await assert.rejects(
        f.client.send(
          new HeadObjectCommand({ Bucket: f.bucket, Key: "sacrifice" }),
        ),
        (e) => e.$metadata?.httpStatusCode === 404,
      );
      let original = await f.service.invoke("prepareObjectMutation", p);
      assert.equal(
        (
          await f.service.invoke("executeObjectMutation", {
            ...p,
            original,
            kind: "copy",
            targetKey: "copy",
            overwrite: true,
          })
        ).copied,
        true,
      );
      await assert.rejects(
        f.service.invoke("executeObjectMutation", {
          ...p,
          original,
          kind: "copy",
          targetKey: "occupied",
          overwrite: false,
        }),
        { code: "NO_OVERWRITE_UNVERIFIED" },
      );
      const update = await f.service.invoke("executeObjectMutation", {
        ...p,
        original,
        kind: "metadata",
        contentType: "application/json",
        cacheControl: "max-age=5",
        metadata: { new: "yes" },
      });
      assert.equal(update.updated, true);
      const body = await f.client.send(
        new GetObjectCommand({ Bucket: f.bucket, Key: key }),
      );
      assert.equal(await body.Body.transformToString(), "body");
      assert.equal(body.ContentDisposition, "inline");
      assert.equal(body.ContentLanguage, "en");
      assert.deepEqual(body.Metadata, { new: "yes" });
      assert.deepEqual(
        (
          await f.client.send(
            new GetObjectTaggingCommand({ Bucket: f.bucket, Key: key }),
          )
        ).TagSet,
        [{ Key: "env", Value: "test" }],
      );
      original = await f.service.invoke("prepareObjectMutation", p);
      const rename = await f.service.invoke("executeObjectMutation", {
        ...p,
        original,
        kind: "rename",
        targetKey: "renamed",
        overwrite: true,
      });
      assert.equal(rename.sourceRetained, true);
      assert.equal(rename.renamed, undefined);
      assert.equal(
        (
          await f.client.send(
            new HeadObjectCommand({ Bucket: f.bucket, Key: key }),
          )
        ).ETag,
        original.etag,
      );
      assert.equal(
        await (
          await f.client.send(
            new GetObjectCommand({ Bucket: f.bucket, Key: "renamed" }),
          )
        ).Body.transformToString(),
        "body",
      );
    } finally {
      await f.cleanup();
    }
  },
);
