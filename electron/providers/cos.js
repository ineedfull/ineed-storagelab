import { watchDownloadIdle } from "./download-idle.js";
import COS from "cos-nodejs-sdk-v5";
import cosUtil from "cos-nodejs-sdk-v5/sdk/util.js";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";
import { unsupported, normalized, allowed } from "./cos/schema.js";
import { buildRequest } from "./cos/requestMapping.js";
import { normalizeResponse } from "./cos/responseMapping.js";

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
            const p = buildRequest(name, i, { timeout, region: connection.region });
            const r = await request(sdk, p);
            const out = normalizeResponse(name, r);
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
            if (name === "CreateMultipartUpload") {
              uploads.set(JSON.stringify([i.Bucket, i.Key, out.UploadId]), {
                ...i,
              });
            }
            if (
              ["CompleteMultipartUpload", "AbortMultipartUpload"].includes(name)
            )
              uploads.delete(uploadKey);
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
