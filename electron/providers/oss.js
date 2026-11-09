import OSS from "ali-oss";
import { parse as parseUrl } from "node:url";
import http from "node:http";
import https from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { watchDownloadIdle } from "./download-idle.js";
const require = createRequire(import.meta.url);
const urllib = require("urllib");
const array = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const xmlEscape = (v) => {
  const text = String(v);
  for (const character of text) {
    const cp = character.codePointAt(0);
    if (!(
      cp === 9 ||
      cp === 10 ||
      cp === 13 ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff)
    ))
      throw unsupported("XML 1.0 character");
  }
  return text.replace(
    /[<>&"'\r]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
        "\r": "&#13;",
      })[c],
  );
};
const xml = (name, value) =>
  `<${name}>${
    Array.isArray(value)
      ? value.map((v) => xml(name, v)).join("")
      : value && typeof value === "object"
        ? Object.entries(value)
            .map(([k, v]) =>
              Array.isArray(v) ? v.map((x) => xml(k, x)).join("") : xml(k, v),
            )
            .join("")
        : xmlEscape(value ?? "")
  }</${name}>`;
const unsupported = (field) =>
  Object.assign(new Error(`OSS does not support ${field}.`), {
    name: "NotImplemented",
    code: "NotImplemented",
  });
function normalized(e) {
  const status = e?.status || e?.statusCode || e?.$metadata?.httpStatusCode;
  const statusCode = {
    403: "AccessDenied",
    404: "NoSuchKey",
    412: "PreconditionFailed",
  }[status];
  const code =
    e?.name === "AbortError"
      ? "AbortError"
      : ["ResponseTimeoutError", "ConnectionTimeoutError"].includes(e?.name)
        ? "TimeoutError"
        : e?.name === "UnknownError" && statusCode
          ? statusCode
          : String(e?.code || e?.name || "StorageError");
  return Object.assign(
    new Error(
      code === "AbortError" ? "Request aborted." : "OSS request failed.",
    ),
    {
      name: code,
      code,
      $metadata: {
        httpStatusCode:
          e?.status || e?.statusCode || e?.$metadata?.httpStatusCode,
      },
    },
  );
}
const metadataHeaders = {
  ContentType: "content-type",
  ContentLength: "content-length",
  CacheControl: "cache-control",
  ContentDisposition: "content-disposition",
  ContentEncoding: "content-encoding",
  ContentLanguage: "content-language",
  Expires: "expires",
};
const allowed = {
  ListBuckets: ["MaxBuckets", "ContinuationToken", "Prefix"],
  ListObjectsV2: [
    "Prefix",
    "Delimiter",
    "MaxKeys",
    "ContinuationToken",
    "StartAfter",
  ],
  HeadObject: [
    "VersionId",
    "IfMatch",
    "IfNoneMatch",
    "IfModifiedSince",
    "IfUnmodifiedSince",
  ],
  GetObject: [
    "VersionId",
    "Range",
    "IfMatch",
    "IfNoneMatch",
    "IfModifiedSince",
    "IfUnmodifiedSince",
  ],
  GetBucketVersioning: [],
  DeleteObjects: ["Delete"],
  GetObjectTagging: ["VersionId"],
  PutObjectTagging: ["VersionId", "Tagging"],
  DeleteObjectTagging: ["VersionId"],
  ListObjectVersions: [
    "Prefix",
    "Delimiter",
    "MaxKeys",
    "KeyMarker",
    "VersionIdMarker",
  ],
  CopyObject: [
    "CopySource",
    "CopySourceIfMatch",
    "CopySourceIfNoneMatch",
    "CopySourceIfModifiedSince",
    "CopySourceIfUnmodifiedSince",
    "MetadataDirective",
    "TaggingDirective",
    "Tagging",
    "Metadata",
    ...Object.keys(metadataHeaders),
  ],
  DeleteObject: ["VersionId"],
  PutObject: ["Body", "Metadata", "Tagging", ...Object.keys(metadataHeaders)],
  CreateMultipartUpload: [
    "Metadata",
    "Tagging",
    ...Object.keys(metadataHeaders),
  ],
  UploadPart: [
    "UploadId",
    "PartNumber",
    "Body",
    ...Object.keys(metadataHeaders),
  ],
  ListParts: ["UploadId", "PartNumberMarker", "MaxParts"],
  CompleteMultipartUpload: [
    "UploadId",
    "MultipartUpload",
    ...Object.keys(metadataHeaders),
  ],
  AbortMultipartUpload: ["UploadId"],
};

/** Native OSS V4 transport for the application's internal command bridge. */
export function createOssClient(
  connection,
  credentials,
  settings,
  { sdkFactory = (opts) => new OSS(opts) } = {},
) {
  const endpoint = new URL(connection.endpoint);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    /^s3\.oss-/i.test(endpoint.hostname)
  )
    throw unsupported("native OSS endpoint");
  const scope = new AsyncLocalStorage(),
    clients = new Map(),
    active = new Set();
  let closed = false;
  const timeout = (settings?.timeoutSeconds ?? 30) * 1000;
  const getClient = (bucket) => {
    if (closed) throw unsupported("closed client");
    const key = bucket ?? "";
    if (!clients.has(key))
      clients.set(
        key,
        sdkFactory({
          endpoint: connection.endpoint,
          region: connection.region,
          accessKeyId: credentials.accessKeyId,
          accessKeySecret: credentials.secretAccessKey,
          stsToken: credentials.sessionToken,
          authorizationV4: true,
          retryMax: 0,
          timeout,
          secure: new URL(connection.endpoint).protocol === "https:",
          sldEnable: !!connection.forcePathStyle,
          bucket: bucket || undefined,
          urllib: {
            request: (url, opts) => {
              const state = scope.getStore();
              // A WHATWG URL would collapse literal dot segments after signing.
              return urllib.request(parseUrl(url), {
                ...opts,
                agent: state?.httpAgent,
                httpsAgent: state?.httpsAgent,
              });
            },
          },
        }),
      );
    return clients.get(key);
  };
  const config = {
    endpoint: async () => ({
      hostname: new URL(connection.endpoint).hostname,
      protocol: new URL(connection.endpoint).protocol,
      port: new URL(connection.endpoint).port
        ? Number(new URL(connection.endpoint).port)
        : undefined,
      path: "/",
    }),
    forcePathStyle: !!connection.forcePathStyle,
    requestChecksumCalculation: async () => "WHEN_REQUIRED",
  };
  async function send(command, { abortSignal } = {}) {
    const name = command.constructor.name.replace(/Command$/, "");
    const i = command.input ?? {};
    try {
      if (!allowed[name]) throw unsupported(name);
      for (const [k, v] of Object.entries(i))
        if (v !== undefined && !["Bucket", "Key", ...allowed[name]].includes(k))
          throw unsupported(k);
      if (abortSignal?.aborted) throw { name: "AbortError" };
      const sdk = getClient(i.Bucket);
      const state = {
        httpAgent: new http.Agent({ keepAlive: false }),
        httpsAgent: new https.Agent({
          keepAlive: false,
          rejectUnauthorized: true,
        }),
        body: null,
      };
      let abortReject;
      const aborted = new Promise((_, reject) => {
        abortReject = reject;
      });
      let deadline;
      const clean = () => {
        clearTimeout(deadline);
        state.idleCleanup?.();
        abortSignal?.removeEventListener("abort", abort);
        state.httpAgent.destroy();
        state.httpsAgent.destroy();
        active.delete(abort);
      };
      const terminate = (reason) => {
        state.body?.destroy(normalized(reason));
        i.Body?.destroy?.();
        state.httpAgent.destroy();
        state.httpsAgent.destroy();
        abortReject(reason);
      };
      const abort = () => terminate({ name: "AbortError" });
      deadline = setTimeout(() => terminate({ name: "TimeoutError" }), timeout);
      deadline.unref?.();
      active.add(abort);
      abortSignal?.addEventListener("abort", abort, { once: true });
      try {
        return await Promise.race([
          scope.run(state, async () => {
            const p = {
              method: "GET",
              bucket: i.Bucket,
              object: i.Key,
              headers: {},
              query: {},
              successStatuses: [200],
              timeout,
            };
            let root;
            const query = (k, v) => {
              if (v !== undefined) p.query[k] = v;
            };
            const doc = (r, v) => {
              p.content = xml(r, v);
              p.mime = "application/xml";
              p.headers["content-type"] = "application/xml";
            };
            query("versionId", i.VersionId);
            for (const [k, h] of Object.entries(metadataHeaders))
              if (
                i[k] !== undefined &&
                (k !== "ContentLength" ||
                  ["PutObject", "UploadPart"].includes(name))
              )
                p.headers[h] = i[k] instanceof Date ? i[k].toUTCString() : i[k];
            for (const [k, v] of Object.entries(i.Metadata ?? {}))
              p.headers[`x-oss-meta-${k}`] = v;
            if (i.Tagging !== undefined && typeof i.Tagging === "string")
              p.headers["x-oss-tagging"] = i.Tagging;
            for (const k of [
              "IfMatch",
              "IfNoneMatch",
              "IfModifiedSince",
              "IfUnmodifiedSince",
            ])
              if (i[k] !== undefined)
                p.headers[k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()] =
                  i[k] instanceof Date ? i[k].toUTCString() : i[k];
            switch (name) {
              case "ListBuckets":
                query("max-keys", i.MaxBuckets);
                query("marker", i.ContinuationToken);
                query("prefix", i.Prefix);
                root = true;
                break;
              case "ListObjectsV2":
                query("list-type", 2);
                for (const [k, v] of Object.entries({
                  prefix: i.Prefix,
                  delimiter: i.Delimiter,
                  "max-keys": i.MaxKeys,
                  "continuation-token": i.ContinuationToken,
                  "start-after": i.StartAfter,
                }))
                  query(k, v);
                root = true;
                break;
              case "HeadObject":
                p.method = "HEAD";
                break;
              case "GetObject":
                p.customResponse = true;
                p.successStatuses = [200, 206];
                if (i.Range) p.headers.range = i.Range;
                break;
              case "GetBucketVersioning":
                query("versioning", "");
                root = true;
                break;
              case "ListObjectVersions":
                query("versions", "");
                for (const [k, v] of Object.entries({
                  prefix: i.Prefix,
                  delimiter: i.Delimiter,
                  "max-keys": i.MaxKeys,
                  "key-marker": i.KeyMarker,
                  "version-id-marker": i.VersionIdMarker,
                }))
                  query(k, v);
                root = true;
                break;
              case "GetObjectTagging":
                query("tagging", "");
                root = true;
                break;
              case "PutObjectTagging":
                p.method = "PUT";
                query("tagging", "");
                doc("Tagging", { TagSet: { Tag: i.Tagging?.TagSet ?? [] } });
                break;
              case "DeleteObjectTagging":
                p.method = "DELETE";
                query("tagging", "");
                p.successStatuses = [200, 204];
                break;
              case "DeleteObjects":
                p.method = "POST";
                query("delete", "");
                if (
                  Object.keys(i.Delete ?? {}).some(
                    (k) => !["Objects", "Quiet"].includes(k),
                  )
                )
                  throw unsupported("Delete fields");
                for (const o of i.Delete?.Objects ?? [])
                  if (
                    Object.keys(o).some(
                      (k) => !["Key", "VersionId"].includes(k),
                    )
                  )
                    throw unsupported("conditional deletion");
                doc("Delete", {
                  Quiet: !!i.Delete?.Quiet,
                  Object: i.Delete?.Objects ?? [],
                });
                root = true;
                break;
              case "CopyObject":
                p.method = "PUT";
                p.headers["x-oss-copy-source"] = i.CopySource?.startsWith("/")
                  ? i.CopySource
                  : `/${i.CopySource}`;
                for (const k of [
                  "IfMatch",
                  "IfNoneMatch",
                  "IfModifiedSince",
                  "IfUnmodifiedSince",
                ]) {
                  const v = i[`CopySource${k}`];
                  if (v !== undefined)
                    p.headers[
                      `x-oss-copy-source-${k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`
                    ] = v instanceof Date ? v.toUTCString() : v;
                }
                if (i.MetadataDirective)
                  p.headers["x-oss-metadata-directive"] = i.MetadataDirective;
                if (i.TaggingDirective) {
                  // OSS CopyObject documents Copy/Replace, unlike S3's COPY/REPLACE.
                  const directive = { COPY: "Copy", REPLACE: "Replace" }[
                    i.TaggingDirective
                  ];
                  if (!directive) throw unsupported("TaggingDirective");
                  p.headers["x-oss-tagging-directive"] = directive;
                }
                root = true;
                break;
              case "DeleteObject":
                p.method = "DELETE";
                p.successStatuses = [200, 204];
                break;
              case "PutObject":
                p.method = "PUT";
                if (i.Body?.pipe) p.stream = i.Body;
                else
                  p.content =
                    typeof i.Body === "string" ? Buffer.from(i.Body) : i.Body;
                break;
              case "CreateMultipartUpload":
                p.method = "POST";
                query("uploads", "");
                root = true;
                break;
              case "UploadPart":
                p.method = "PUT";
                query("uploadId", i.UploadId);
                query("partNumber", i.PartNumber);
                if (i.Body?.pipe) p.stream = i.Body;
                else
                  p.content =
                    typeof i.Body === "string" ? Buffer.from(i.Body) : i.Body;
                break;
              case "ListParts":
                query("uploadId", i.UploadId);
                query("part-number-marker", i.PartNumberMarker);
                query("max-parts", i.MaxParts);
                root = true;
                break;
              case "CompleteMultipartUpload":
                p.method = "POST";
                query("uploadId", i.UploadId);
                doc("CompleteMultipartUpload", {
                  Part: i.MultipartUpload?.Parts ?? [],
                });
                root = true;
                break;
              case "AbortMultipartUpload":
                p.method = "DELETE";
                query("uploadId", i.UploadId);
                p.successStatuses = [200, 204];
                break;
            }
            p.xmlResponse = !!root;
            const r = await sdk.request(p);
            const d = r.data ?? {};
            if (d.Code) throw { code: d.Code, status: r.status };
            const h = r.headers ?? r.res?.headers ?? {};
            const out = {
              $metadata: { httpStatusCode: r.status },
              ETag: h.etag,
              VersionId: h["x-oss-version-id"],
              DeleteMarker: h["x-oss-delete-marker"] === "true",
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
                StorageClass: h["x-oss-storage-class"],
                ContentRange: h["content-range"],
                Metadata: Object.fromEntries(
                  Object.entries(h)
                    .filter(([k]) => k.startsWith("x-oss-meta-"))
                    .map(([k, v]) => [k.slice(11), v]),
                ),
              });
              for (const [k, v] of Object.entries(metadataHeaders))
                if (!["ContentType", "ContentLength"].includes(k))
                  out[k] = h[v];
              if (name === "GetObject") {
                out.Body = r.res;
                state.body = r.res;
                state.idleCleanup = watchDownloadIdle(state.body, timeout, () =>
                  terminate({ name: "TimeoutError" }),
                );
                if (state.idleCleanup) clearTimeout(deadline);
                state.body.once("close", clean);
                state.body.once("end", clean);
                state.body.once("error", clean);
              }
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
                NextContinuationToken: d.NextContinuationToken,
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
            if (name === "CreateMultipartUpload") out.UploadId = d.UploadId;
            if (name === "ListParts")
              Object.assign(out, {
                Parts: entries(d.Part),
                IsTruncated: d.IsTruncated === true || d.IsTruncated === "true",
                NextPartNumberMarker: d.NextPartNumberMarker,
              });
            if (name === "CompleteMultipartUpload")
              Object.assign(out, {
                ETag: d.ETag,
                Location: d.Location,
                Bucket: d.Bucket,
                Key: d.Key,
              });
            return out;
          }),
          aborted,
        ]);
      } finally {
        if (!state.body) clean();
      }
    } catch (e) {
      throw normalized(e);
    }
  }
  return {
    config,
    send,
    async signGet({ bucket, key, expiresIn }) {
      try {
        // Browsers normalize dot path components even in an otherwise valid signed URL.
        if (/(^|\/)\.{1,2}(\/|$)/.test(key))
          throw unsupported("signed GET for dot-segment key");
        return await getClient(bucket).signatureUrlV4(
          "GET",
          expiresIn,
          {},
          key,
        );
      } catch (e) {
        throw normalized(e);
      }
    },
    destroy() {
      closed = true;
      for (const abort of active) abort();
      active.clear();
      clients.clear();
    },
  };
}
