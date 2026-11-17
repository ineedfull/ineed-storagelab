// Normalize native response values; streams and multipart state belong to the client.
import { array, metadataHeaders } from "./schema.js";

export function normalizeResponse(name, r) {
  const d = r.data ?? {};
  if (d.Code) throw { code: d.Code, status: r.status };
  const h = r.headers ?? r.res?.headers ?? {};
  const out = {
    $metadata: { httpStatusCode: r.status },
    ETag: h.etag,
    VersionId: h["x-cos-version-id"],
    DeleteMarker: h["x-cos-delete-marker"] === "true",
  };
  if (name === "GetObject" || name === "HeadObject") {
    Object.assign(out, {
      ContentLength:
        h["content-length"] === undefined
          ? undefined
          : Number(h["content-length"]),
      ContentType: h["content-type"],
      LastModified: h["last-modified"]
        ? new Date(h["last-modified"])
        : undefined,
      StorageClass: h["x-cos-storage-class"],
      ContentRange: h["content-range"],
      Metadata: Object.fromEntries(
        Object.entries(h)
          .filter(([k]) => k.startsWith("x-cos-meta-"))
          .map(([k, v]) => [k.slice(11), v]),
      ),
    });
    for (const [k, v] of Object.entries(metadataHeaders))
      if (!["ContentType", "ContentLength"].includes(k))
        out[k] = h[v];

  }
  const entries = (v) =>
    array(v).map((o) => ({
      ...o,
      ...(o.Size !== undefined ? { Size: Number(o.Size) } : {}),
      ...(o.PartNumber !== undefined
        ? { PartNumber: Number(o.PartNumber) }
        : {}),
      ...(o.IsLatest !== undefined
        ? { IsLatest: o.IsLatest === true || o.IsLatest === "true" }
        : {}),
      ...(o.LastModified
        ? { LastModified: new Date(o.LastModified) }
        : {}),
    }));
  if (name === "ListBuckets")
    Object.assign(out, {
      Buckets: array(d.Buckets?.Bucket),
      ContinuationToken: d.NextMarker,
      IsTruncated: d.IsTruncated === true || d.IsTruncated === "true",
    });
  if (name === "ListObjectsV2")
    Object.assign(out, {
      Contents: entries(d.Contents),
      CommonPrefixes: array(d.CommonPrefixes),
      IsTruncated: d.IsTruncated === true || d.IsTruncated === "true",
      NextContinuationToken: d.NextMarker,
      KeyCount: array(d.Contents).length,
    });
  if (name === "ListObjectVersions")
    Object.assign(out, {
      Versions: entries(d.Version),
      DeleteMarkers: entries(d.DeleteMarker),
      CommonPrefixes: array(d.CommonPrefixes),
      IsTruncated: d.IsTruncated === true || d.IsTruncated === "true",
      NextKeyMarker: d.NextKeyMarker,
      NextVersionIdMarker: d.NextVersionIdMarker,
    });
  if (name === "GetBucketVersioning") out.Status = d.Status;
  if (name === "GetObjectTagging") out.TagSet = array(d.TagSet?.Tag);
  if (name === "DeleteObjects")
    Object.assign(out, {
      Deleted: array(d.Deleted),
      Errors: array(d.Error),
    });
  if (name === "CopyObject")
    out.CopyObjectResult = {
      ETag: d.ETag,
      LastModified: d.LastModified
        ? new Date(d.LastModified)
        : undefined,
    };
  if (name === "CreateMultipartUpload") {
    out.UploadId = d.UploadId;

  }

  if (name === "ListParts")
    Object.assign(out, {
      Parts: entries(d.Part),
      IsTruncated: d.IsTruncated === true || d.IsTruncated === "true",
      NextPartNumberMarker:
        d.NextPartNumberMarker === undefined
          ? undefined
          : Number(d.NextPartNumberMarker),
    });
  if (name === "CompleteMultipartUpload")
    Object.assign(out, {
      ETag: d.ETag,
      Location: d.Location,
      Bucket: d.Bucket,
      Key: d.Key,
    });
  return out;
}
