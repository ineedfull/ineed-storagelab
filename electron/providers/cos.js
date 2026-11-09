import { watchDownloadIdle } from "./download-idle.js";
import COS from "cos-nodejs-sdk-v5";
import cosUtil from "cos-nodejs-sdk-v5/sdk/util.js";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";
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
  Object.assign(new Error(`COS does not support ${field}.`), {
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
      code === "AbortError" ? "Request aborted." : "COS request failed.",
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

/** Official COS signer with a single-attempt native transport for the application's internal command bridge. */
export function createCosClient(
  connection,
  credentials,
  settings,
  { sdkFactory = (opts) => new COS(opts), lookup } = {},
) {
  if (connection.forcePathStyle || connection.pathStyle)
    throw unsupported("native COS path style");
  const endpoint = new URL(
    connection.endpoint || "https://cos.ap-guangzhou.myqcloud.com",
  );
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    /^s3\.cos-/i.test(endpoint.hostname) ||
    /^[^.]+\.cos\.[^.]+\.myqcloud\.com$/i.test(endpoint.hostname)
  )
    throw unsupported("native COS endpoint");
  const uploads = new Map();
  const scope = new AsyncLocalStorage(),
    clients = new Map(),
    active = new Set();
  let closed = false;
  // Endpoint is a service base; native requests prepend the selected bucket.
  // Bucket-bound custom CNAMEs require a separate explicit mode and are unsupported.
  const timeout =
    settings?.requestTimeoutMs ??
    settings?.timeoutMs ??
    (settings?.timeoutSeconds ?? 30) * 1000;
  const getClient = (bucket) => {
    if (closed) throw unsupported("closed client");
    const key = bucket ?? "";
    if (!clients.has(key))
      clients.set(
        key,
        sdkFactory({
          SecretId: credentials.accessKeyId,
          SecretKey: credentials.secretAccessKey,
          SecurityToken: credentials.sessionToken,
          Domain: `{Bucket}.${endpoint.host}`,
          ServiceDomain: endpoint.host,
          Protocol: endpoint.protocol,
          ForcePathStyle: false,
          UseRawKey: true,
          ChunkRetryTimes: 0,
          CorrectClockSkew: false,
          AutoSwitchHost: false,
          KeepAlive: false,
          StrictSsl: true,
          ObjectKeySimplifyCheck: false,
        }),
      );
    return clients.get(key);
  };
  // The SDK's high-level request method hardcodes up to four attempts, including
  // writes. Use its official COS signer/parser with a single Node request instead.
  // A legacy Node path string preserves literal dot segments after signing.
  async function request(sdk, p) {
    const state = scope.getStore();
    const host = p.bucket ? `${p.bucket}.${endpoint.host}` : endpoint.host;
    const rawKey = p.object ?? "";
    const pathname =
      "/" + cosUtil.camSafeUrlEncode(rawKey).replace(/%2F/g, "/");
    const query = Object.fromEntries(
      Object.entries(p.query).map(([k, v]) => [k, String(v)]),
    );
    const headers = { ...p.headers, host };
    if (credentials.sessionToken)
      headers["x-cos-security-token"] = credentials.sessionToken;
    const body = p.stream ?? p.content;
    if (body !== undefined && !body?.pipe)
      headers["content-length"] = Buffer.byteLength(body);
    if (typeof p.content === "string" && p.mime === "application/xml")
      headers["content-md5"] = createHash("md5")
        .update(p.content)
        .digest("base64");
    headers.authorization = sdk.getAuth({
      Method: p.method,
      Key: rawKey,
      Query: query,
      Headers: headers,
      Bucket: p.bucket,
      Region: connection.region,
    });
    return new Promise((resolve, reject) => {
      const req = (endpoint.protocol === "https:" ? https : http).request(
        {
          protocol: endpoint.protocol,
          hostname: host.replace(/:\d+$/, ""),
          port: endpoint.port || undefined,
          method: p.method,
          path:
            pathname +
            (Object.keys(query).length ? "?" + cosUtil.obj2str(query) : ""),
          headers,
          agent:
            endpoint.protocol === "https:" ? state.httpsAgent : state.httpAgent,
          rejectUnauthorized: true,
        },
        (res) => {
          state.response = res;
          if (
            p.customResponse &&
            res.statusCode >= 200 &&
            res.statusCode < 300
          ) {
            state.body = res;
            resolve({ status: res.statusCode, headers: res.headers, res });
            return;
          }
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 16 * 1024 * 1024)
              res.destroy(unsupported("response size"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              const doc = cosUtil.parseResBody(
                Buffer.concat(chunks).toString("utf8"),
              );
              if (res.statusCode >= 300 || doc?.Error) {
                reject({
                  code:
                    doc?.Error?.Code ||
                    {
                      403: "AccessDenied",
                      404: "NoSuchKey",
                      412: "PreconditionFailed",
                    }[res.statusCode] ||
                    "StorageError",
                  status: res.statusCode,
                });
                return;
              }
              let data = {};
              if (p.expectedRoot) {
                if (
                  !doc ||
                  typeof doc !== "object" ||
                  Array.isArray(doc) ||
                  !Object.hasOwn(doc, p.expectedRoot)
                )
                  throw new Error("Invalid response root");
                data = doc[p.expectedRoot];
                // Disabled versioning and quiet batch deletion may have empty roots.
                if (
                  data === "" &&
                  ["VersioningConfiguration", "DeleteResult"].includes(
                    p.expectedRoot,
                  )
                )
                  data = {};
                if (!data || typeof data !== "object" || Array.isArray(data))
                  throw new Error("Invalid response structure");
                if (
                  p.requiredField &&
                  (typeof data[p.requiredField] !== "string" ||
                    !data[p.requiredField].length)
                )
                  throw new Error("Incomplete mutation response");
              }
              resolve({
                status: res.statusCode,
                headers: res.headers,
                data,
              });
            } catch {
              // SDK XML parsing runs in an EventEmitter callback, outside the
              // Promise executor. Never let malformed remote XML crash main.
              reject({ code: "InvalidResponse", status: res.statusCode });
            }
          });
        },
      );
      state.request = req;
      req.on("error", reject);
      if (p.stream) {
        state.source = p.stream;
        state.sourceError = (e) => req.destroy(e);
        p.stream.on("error", state.sourceError);
        p.stream.pipe(req);
      } else req.end(body);
    });
  }
  const config = {
    endpoint: async () => ({
      hostname: endpoint.hostname,
      protocol: endpoint.protocol,
      port: endpoint.port ? Number(endpoint.port) : undefined,
      path: "/",
    }),
    forcePathStyle: false,
    requestChecksumCalculation: async () => "WHEN_REQUIRED",
  };
  async function send(command, { abortSignal } = {}) {
    const name = command.constructor.name.replace(/Command$/, "");
    const i = { ...(command.input ?? {}) };
    const uploadKey = JSON.stringify([i.Bucket, i.Key, i.UploadId]);
    if (["UploadPart", "CompleteMultipartUpload"].includes(name)) {
      const initial = uploads.get(uploadKey);
      for (const field of ["Metadata", "Tagging"])
        if (i[field] !== undefined) {
          if (
            !initial ||
            JSON.stringify(initial[field]) !== JSON.stringify(i[field])
          )
            throw unsupported(field);
          delete i[field];
        }
    }
    if (
      name === "CompleteMultipartUpload" &&
      i.MultipartUpload &&
      Object.keys(i.MultipartUpload).some((k) => k !== "Parts")
    )
      throw unsupported("MultipartUpload fields");
    for (const part of i.MultipartUpload?.Parts ?? [])
      if (Object.keys(part).some((k) => !["PartNumber", "ETag"].includes(k)))
        throw unsupported("part fields");
    if (name === "PutObjectTagging") {
      if (Object.keys(i.Tagging ?? {}).some((k) => k !== "TagSet"))
        throw unsupported("Tagging fields");
      for (const tag of i.Tagging?.TagSet ?? [])
        if (Object.keys(tag).some((k) => !["Key", "Value"].includes(k)))
          throw unsupported("tag fields");
    }
    try {
      if (!allowed[name]) throw unsupported(name);
      for (const [k, v] of Object.entries(i))
        if (v !== undefined && !["Bucket", "Key", ...allowed[name]].includes(k))
          throw unsupported(k);
      if (abortSignal?.aborted) throw { name: "AbortError" };
      const sdk = getClient(i.Bucket);
      const state = {
        httpAgent: new http.Agent({ keepAlive: false, lookup }),
        httpsAgent: new https.Agent({
          keepAlive: false,
          lookup,
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
        if (state.sourceError)
          state.source?.removeListener("error", state.sourceError);
        abortSignal?.removeEventListener("abort", abort);
        state.httpAgent.destroy();
        state.httpsAgent.destroy();
        active.delete(abort);
      };
      const terminate = (reason) => {
        state.request?.destroy(normalized(reason));
        state.response?.destroy(normalized(reason));
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
              p.headers[`x-cos-meta-${k}`] = v;
            if (i.Tagging !== undefined && typeof i.Tagging === "string")
              p.headers["x-cos-tagging"] = i.Tagging;
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
                if (
                  i.ContinuationToken !== undefined &&
                  i.StartAfter !== undefined
                )
                  throw unsupported("ambiguous marker");
                for (const [k, v] of Object.entries({
                  prefix: i.Prefix,
                  delimiter: i.Delimiter,
                  "max-keys": i.MaxKeys,
                  marker: i.ContinuationToken ?? i.StartAfter,
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
                {
                  const source = String(i.CopySource ?? "").replace(/^\//, "");
                  const slash = source.indexOf("/");
                  if (slash < 1) throw unsupported("CopySource");
                  const sourceBucket = decodeURIComponent(
                    source.slice(0, slash),
                  );
                  if (!/^[a-z0-9][a-z0-9-]*-\d+$/.test(sourceBucket))
                    throw unsupported("CopySource bucket");
                  p.headers["x-cos-copy-source"] =
                    `${sourceBucket}.cos.${connection.region}.myqcloud.com/${source.slice(slash + 1)}`;
                }
                for (const k of [
                  "IfMatch",
                  "IfNoneMatch",
                  "IfModifiedSince",
                  "IfUnmodifiedSince",
                ]) {
                  const v = i[`CopySource${k}`];
                  if (v !== undefined)
                    p.headers[
                      `x-cos-copy-source-${k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`
                    ] = v instanceof Date ? v.toUTCString() : v;
                }
                if (i.MetadataDirective !== undefined) {
                  const directive = { COPY: "Copy", REPLACE: "Replaced" }[
                    i.MetadataDirective
                  ];
                  if (!directive) throw unsupported("MetadataDirective");
                  p.headers["x-cos-metadata-directive"] = directive;
                }
                if (i.TaggingDirective !== undefined) {
                  const directive = { COPY: "Copy", REPLACE: "Replaced" }[
                    i.TaggingDirective
                  ];
                  if (!directive) throw unsupported("TaggingDirective");
                  p.headers["x-cos-tagging-directive"] = directive;
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
            p.expectedRoot = {
              ListBuckets: "ListAllMyBucketsResult",
              ListObjectsV2: "ListBucketResult",
              GetBucketVersioning: "VersioningConfiguration",
              ListObjectVersions: "ListVersionsResult",
              GetObjectTagging: "Tagging",
              DeleteObjects: "DeleteResult",
              CopyObject: "CopyObjectResult",
              CreateMultipartUpload: "InitiateMultipartUploadResult",
              ListParts: "ListPartsResult",
              CompleteMultipartUpload: "CompleteMultipartUploadResult",
            }[name];
            p.requiredField = {
              CopyObject: "ETag",
              CompleteMultipartUpload: "ETag",
              CreateMultipartUpload: "UploadId",
            }[name];
            const r = await request(sdk, p);
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
              uploads.set(JSON.stringify([i.Bucket, i.Key, out.UploadId]), {
                ...i,
              });
            }
            if (
              ["CompleteMultipartUpload", "AbortMultipartUpload"].includes(name)
            )
              uploads.delete(uploadKey);
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
        const sdk = getClient(bucket);
        const host = `${bucket}.${endpoint.host}`;
        const rawKey = key;
        const query = credentials.sessionToken
          ? { "x-cos-security-token": credentials.sessionToken }
          : {};
        const auth = sdk.getAuth({
          Method: "GET",
          Key: rawKey,
          Query: query,
          Headers: { host },
          Expires: expiresIn,
        });
        return `${endpoint.protocol}//${host}/${cosUtil.camSafeUrlEncode(rawKey).replace(/%2F/g, "/")}?${auth}${Object.keys(query).length ? "&" + cosUtil.obj2str(query) : ""}`;
      } catch (e) {
        throw normalized(e);
      }
    },
    destroy() {
      closed = true;
      for (const abort of active) abort();
      active.clear();
      clients.clear();
      uploads.clear();
    },
  };
}
