import { TosClient } from "@volcengine/tos-sdk";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { watchDownloadIdle } from "./download-idle.js";

const array = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const unsupported = (field) =>
  Object.assign(new Error(`TOS does not support ${field}.`), {
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
      code === "AbortError" ? "Request aborted." : "TOS request failed.",
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
    "Metadata",
    "Tagging",
    "UploadId",
    "PartNumber",
    "Body",
    ...Object.keys(metadataHeaders),
  ],
  ListParts: ["UploadId", "PartNumberMarker", "MaxParts"],
  CompleteMultipartUpload: [
    "Metadata",
    "Tagging",
    "UploadId",
    "MultipartUpload",
    ...Object.keys(metadataHeaders),
  ],
  AbortMultipartUpload: ["UploadId"],
};

/** Native TOS V4 transport for the application's internal command bridge. */
export function createTosClient(
  connection,
  credentials,
  settings,
  { sdkFactory = (opts) => new TosClient(opts) } = {},
) {
  const endpoint = new URL(connection.endpoint);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    /^tos-s3-/i.test(endpoint.hostname)
  )
    throw unsupported("native TOS endpoint");
  const scope = new AsyncLocalStorage(),
    clients = new Map(),
    uploads = new Map(),
    active = new Set();
  let closed = false;
  const timeout = (settings?.timeoutSeconds ?? 30) * 1000;
  const requestAdapter = (cfg) =>
    new Promise((resolve, reject) => {
      const state = scope.getStore();
      const target = new URL(cfg.baseURL);
      if (state.terminated) {
        reject(normalized(state.terminated));
        return;
      }
      const params = Object.entries(cfg.params ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const transport = target.protocol === "https:" ? https : http;
      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          port: target.port,
          method: cfg.method,
          path: cfg.url + (params ? "?" + params : ""),
          headers: cfg.headers,
          agent:
            target.protocol === "https:" ? state.httpsAgent : state.httpAgent,
        },
        (res) => {
          const response = {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            config: cfg,
            request: req,
          };
          if (cfg.responseType === "stream" && res.statusCode < 300) {
            resolve({ ...response, data: res });
            return;
          }
          const chunks = [];
          let bytes = 0;
          res.on("data", (c) => {
            bytes += c.length;
            if (bytes > 16 * 1024 * 1024) {
              res.destroy(new Error("TOS response exceeds limit"));
              return;
            }
            chunks.push(c);
          });
          res.on("error", reject);
          res.on("end", () => {
            let data = Buffer.concat(chunks).toString();
            try {
              data = data.length ? JSON.parse(data) : {};
              if (!data || typeof data !== "object" || Array.isArray(data))
                throw new Error();
            } catch {
              reject(new Error("Invalid TOS JSON response"));
              return;
            }
            if (res.statusCode >= 300)
              reject(
                Object.assign(new Error("TOS request failed"), {
                  code:
                    data?.Code ||
                    {
                      403: "AccessDenied",
                      404: "NoSuchKey",
                      412: "PreconditionFailed",
                    }[res.statusCode],
                  statusCode: res.statusCode,
                }),
              );
            else resolve({ ...response, data });
          });
        },
      );
      state.request = req;
      req.on("error", reject);
      if (cfg.data?.pipe) {
        const sourceError = (e) => req.destroy(e);
        cfg.data.on("error", sourceError);
        const sourceCleanup = () => {
          cfg.data.removeListener("error", sourceError);
          cfg.data.unpipe(req);
          req.removeListener("close", sourceCleanup);
        };
        state.sourceCleanup = sourceCleanup;
        req.once("close", sourceCleanup);
        cfg.data.pipe(req);
      } else req.end(cfg.data);
    });
  const getClient = () => {
    if (closed) throw unsupported("closed client");
    if (!clients.has(""))
      clients.set(
        "",
        sdkFactory({
          endpoint: endpoint.host,
          region: connection.region,
          accessKeyId: credentials.accessKeyId,
          accessKeySecret: credentials.secretAccessKey,
          stsToken: credentials.sessionToken,
          secure: endpoint.protocol === "https:",
          enableVerifySSL: true,
          maxRetryCount: 0,
          requestTimeout: timeout,
          forcePathStyle: !!connection.forcePathStyle,
          requestAdapter,
        }),
      );
    return clients.get("");
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
      const checkFields = (obj, fields) => {
        for (const [k, v] of Object.entries(obj ?? {}))
          if (v !== undefined && !fields.includes(k)) throw unsupported(k);
      };
      if (
        i.Tagging !== undefined &&
        name !== "PutObjectTagging" &&
        typeof i.Tagging !== "string"
      )
        throw unsupported("Tagging");
      if (
        i.Metadata !== undefined &&
        (i.Metadata === null ||
          typeof i.Metadata !== "object" ||
          Array.isArray(i.Metadata) ||
          Object.values(i.Metadata).some((v) => typeof v !== "string"))
      )
        throw unsupported("Metadata");
      if (name === "PutObjectTagging") {
        checkFields(i.Tagging, ["TagSet"]);
        for (const tag of i.Tagging?.TagSet ?? [])
          checkFields(tag, ["Key", "Value"]);
      }
      if (name === "CompleteMultipartUpload") {
        checkFields(i.MultipartUpload, ["Parts"]);
        for (const part of i.MultipartUpload?.Parts ?? [])
          checkFields(part, ["PartNumber", "ETag"]);
      }
      const initializationFields = [
        "Metadata",
        "Tagging",
        ...Object.keys(metadataHeaders).filter((k) => k !== "ContentLength"),
      ];
      const uploadKey = JSON.stringify([i.Bucket, i.Key, i.UploadId]);
      const comparable = (v) =>
        JSON.stringify(
          v && typeof v === "object" && !(v instanceof Date)
            ? Object.fromEntries(
                Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
              )
            : v,
        );
      if (["UploadPart", "CompleteMultipartUpload"].includes(name))
        for (const field of initializationFields)
          if (
            i[field] !== undefined &&
            comparable(i[field]) !== comparable(uploads.get(uploadKey)?.[field])
          )
            throw unsupported("changed multipart initialization " + field);
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
        state.sourceCleanup?.();
        clearTimeout(deadline);
        state.idleCleanup?.();
        abortSignal?.removeEventListener("abort", abort);
        state.httpAgent.destroy();
        state.httpsAgent.destroy();
        active.delete(abort);
      };
      const terminate = (reason) => {
        state.terminated = reason;
        state.body?.destroy(normalized(reason));
        state.request?.destroy(normalized(reason));
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
              p.content = v;
              p.headers["content-type"] = "application/json";
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
              p.headers[`x-tos-meta-${k}`] = v;
            if (i.Tagging !== undefined && typeof i.Tagging === "string")
              p.headers["x-tos-tagging"] = i.Tagging;
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
                doc("Tagging", { TagSet: { Tags: i.Tagging?.TagSet ?? [] } });
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
                  Objects: i.Delete?.Objects ?? [],
                });
                root = true;
                break;
              case "CopyObject":
                if (
                  typeof i.CopySource !== "string" ||
                  /[\r\n]/.test(i.CopySource) ||
                  (i.CopySource.includes("?") &&
                    !/^[^?]+\?versionId=[^?&]*$/.test(i.CopySource))
                )
                  throw unsupported("ambiguous CopySource");
                p.method = "PUT";
                p.headers["x-tos-copy-source"] = i.CopySource?.startsWith("/")
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
                      `x-tos-copy-source-${k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`
                    ] = v instanceof Date ? v.toUTCString() : v;
                }
                if (i.MetadataDirective)
                  p.headers["x-tos-metadata-directive"] = i.MetadataDirective;
                if (i.TaggingDirective) {
                  // Native TOS directive values retain the uppercase protocol form.
                  const directive = { COPY: "COPY", REPLACE: "REPLACE" }[
                    i.TaggingDirective
                  ];
                  if (!directive) throw unsupported("TaggingDirective");
                  p.headers["x-tos-tagging-directive"] = directive;
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
                  Parts: i.MultipartUpload?.Parts ?? [],
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
            const numericDns =
              !isIP(endpoint.hostname.replace(/^\[|\]$/g, "")) &&
              /^(\d|:)/.test(endpoint.hostname) &&
              !connection.forcePathStyle &&
              p.bucket;
            const receiver = numericDns
              ? {
                  ...sdk,
                  opts: {
                    ...sdk.opts,
                    endpoint: `${p.bucket}.${endpoint.host}`,
                  },
                }
              : sdk;
            const r0 = await sdk.fetch.call(
              receiver,
              p.method,
              p.object === undefined ? "/" : "/" + encodeURIComponent(p.object),
              p.query,
              p.headers,
              p.stream ?? p.content,
              {
                subdomainBucket: numericDns ? undefined : p.bucket,
                axiosOpts: {
                  adapter: requestAdapter,
                  ...(p.customResponse ? { responseType: "stream" } : {}),
                },
              },
            );
            const r = {
              ...r0,
              status: r0.statusCode,
              res: p.customResponse ? r0.data : undefined,
            };
            const d = r.data ?? {};
            if (d.Code) throw { code: d.Code, status: r.status };
            const h = r.headers ?? r.res?.headers ?? {};
            const out = {
              $metadata: { httpStatusCode: r.status },
              ETag: h.etag,
              VersionId: h["x-tos-version-id"],
              DeleteMarker: h["x-tos-delete-marker"] === "true",
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
                StorageClass: h["x-tos-storage-class"],
                ContentRange: h["content-range"],
                Metadata: Object.fromEntries(
                  Object.entries(h)
                    .filter(([k]) => k.startsWith("x-tos-meta-"))
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
                Buckets: array(d.Buckets),
                ContinuationToken: d.NextMarker,
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
                Versions: entries(d.Versions),
                DeleteMarkers: entries(d.DeleteMarkers),
                CommonPrefixes: array(d.CommonPrefixes),
                IsTruncated: d.IsTruncated === true || d.IsTruncated === "true",
                NextKeyMarker: d.NextKeyMarker,
                NextVersionIdMarker: d.NextVersionIdMarker,
              });
            if (name === "GetBucketVersioning") out.Status = d.Status;
            if (name === "GetObjectTagging") out.TagSet = array(d.TagSet?.Tags);
            if (name === "DeleteObjects")
              Object.assign(out, {
                Deleted: array(d.Deleted),
                Errors: array(d.Error),
              });
            if (
              ["CopyObject", "CompleteMultipartUpload"].includes(name) &&
              (typeof (d.ETag ?? h.etag) !== "string" ||
                !(d.ETag ?? h.etag).length)
            )
              throw new Error("Invalid TOS mutation response");
            if (name === "CopyObject")
              out.CopyObjectResult = {
                ETag: d.ETag ?? h.etag,
                LastModified: d.LastModified
                  ? new Date(d.LastModified)
                  : undefined,
              };
            if (name === "CreateMultipartUpload") {
              if (typeof d.UploadId !== "string" || !d.UploadId.length)
                throw new Error(
                  "Invalid TOS multipart initialization response",
                );
              out.UploadId = d.UploadId;
              uploads.set(
                JSON.stringify([i.Bucket, i.Key, d.UploadId]),
                Object.fromEntries(
                  initializationFields
                    .filter((k) => i[k] !== undefined)
                    .map((k) => [k, structuredClone(i[k])]),
                ),
              );
            }
            if (
              ["AbortMultipartUpload", "CompleteMultipartUpload"].includes(name)
            )
              uploads.delete(uploadKey);
            if (name === "ListParts")
              Object.assign(out, {
                Parts: entries(d.Parts),
                IsTruncated: d.IsTruncated === true || d.IsTruncated === "true",
                NextPartNumberMarker:
                  d.NextPartNumberMarker === undefined
                    ? undefined
                    : Number(d.NextPartNumberMarker),
              });
            if (name === "CompleteMultipartUpload")
              Object.assign(out, {
                ETag: d.ETag ?? h.etag,
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
        const sdk = getClient();
        const pathStyle =
          !!connection.forcePathStyle ||
          !!isIP(endpoint.hostname.replace(/^\[|\]$/g, ""));
        const host = pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`;
        const path =
          (pathStyle ? "/" + bucket : "") + "/" + encodeURIComponent(key);
        // SDK 2.9.1's getSignatureQuery reads opts.endpoint as its region.
        // Bind only the signing call to the configured region; the request host is explicit.
        const query = sdk.getSignatureQuery.call(
          { ...sdk, opts: { ...sdk.opts, endpoint: connection.region } },
          {
            bucket: "",
            method: "GET",
            path,
            endpoint: host,
            subdomain: false,
            expires: expiresIn,
            query: {},
          },
        );
        return (
          endpoint.protocol +
          "//" +
          host +
          path +
          "?" +
          new URLSearchParams(query).toString()
        );
      } catch (e) {
        throw normalized(e);
      }
    },
    destroy() {
      closed = true;
      for (const abort of active) abort();
      active.clear();
      uploads.clear();
      for (const sdk of clients.values()) {
        sdk.httpAgent?.destroy();
        sdk.httpsAgent?.destroy();
      }
      clients.clear();
    },
  };
}
