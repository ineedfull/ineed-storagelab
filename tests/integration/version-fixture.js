import {
  PutBucketVersioningCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";

export async function seedVersionHistory(f) {
  const key = "中文/old +%.txt";
  await f.client.send(
    new PutBucketVersioningCommand({
      Bucket: f.bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  const old = await f.client.send(
    new PutObjectCommand({
      Bucket: f.bucket,
      Key: key,
      Body: "old historical body\n",
      ContentType: "text/plain",
      Metadata: { purpose: "historical" },
      Tagging: "env=old",
    }),
  );
  const newer = await f.client.send(
    new PutObjectCommand({
      Bucket: f.bucket,
      Key: key,
      Body: "new current body\n",
      ContentType: "text/plain",
      Metadata: { purpose: "new" },
    }),
  );
  const marker = await f.client.send(
    new DeleteObjectCommand({ Bucket: f.bucket, Key: key }),
  );
  await f.client.send(
    new PutObjectCommand({
      Bucket: f.bucket,
      Key: key + "-neighbor",
      Body: "neighbor",
    }),
  );
  return {
    key,
    old: old.VersionId,
    newer: newer.VersionId,
    marker: marker.VersionId,
  };
}
export async function readVersionContent(f, key, versionId) {
  const r = await f.client.send(
    new GetObjectCommand({ Bucket: f.bucket, Key: key, VersionId: versionId }),
  );
  const tags = await f.client.send(
    new GetObjectTaggingCommand({
      Bucket: f.bucket,
      Key: key,
      VersionId: versionId,
    }),
  );
  return {
    content: await r.Body.transformToString(),
    versionId: r.VersionId,
    metadata: r.Metadata,
    tags: tags.TagSet,
  };
}
export async function readVersionHistory(f, key) {
  const r = await f.client.send(
    new ListObjectVersionsCommand({ Bucket: f.bucket, Prefix: key }),
  );
  return {
    versions: (r.Versions ?? [])
      .filter((v) => v.Key === key)
      .map((v) => v.VersionId),
    markers: (r.DeleteMarkers ?? [])
      .filter((v) => v.Key === key)
      .map((v) => v.VersionId),
  };
}
