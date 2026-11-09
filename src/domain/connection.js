import { fail, record, text } from "./errors.js";
import { getProvider } from "./providers.js";
export function validateId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    fail("INVALID_INPUT", "连接 ID 无效。");
  return id;
}
export function validateUrl(value, name = "Endpoint", allowEmpty = false) {
  text(value, name, 4096, !allowEmpty);
  if (allowEmpty && value === "") return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID_INPUT", `${name} URL 无效。`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !/^https?:\/\//i.test(value) ||
    value !== value.trim() ||
    /[?#]/.test(value) ||
    value.split("/")[2]?.includes("@") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    fail(
      "INVALID_INPUT",
      `${name} 仅允许无用户信息、查询和片段的 HTTP(S) URL。`,
    );
  return value;
}
export function validateConnection(input) {
  const c = record(input);
  const provider = getProvider(c.provider);
  const out = {
    name: text(c.name, "名称", 100, true),
    group: text(c.group ?? "", "分组", 100),
    provider: c.provider,
    endpoint: validateUrl(c.endpoint),
    region: text(
      c.region ||
        (["oss", "obs", "cos-native", "tos-native"].includes(c.provider)
          ? provider.location
          : c.provider === "r2"
            ? "auto"
            : "us-east-1"),
      "区域",
      100,
      true,
    ),
    forcePathStyle: c.forcePathStyle ?? provider.pathStyle,
    defaultBucket: text(c.defaultBucket ?? "", "默认桶", 255),
    readOnly: c.readOnly ?? false,
    publicBaseUrl: validateUrl(c.publicBaseUrl ?? "", "公开地址", true),
  };
  for (const key of ["forcePathStyle", "readOnly"])
    if (typeof out[key] !== "boolean")
      fail("INVALID_INPUT", `${key}必须为布尔值。`);
  if (c.provider === "cos-native" && out.forcePathStyle)
    fail("INVALID_INPUT", "COS原生接入不支持Path style，请使用虚拟主机寻址。");
  if (c.provider === "obs" && out.forcePathStyle)
    fail("INVALID_INPUT", "OBS原生接入不支持Path style，请使用虚拟主机寻址。");
  if (
    c.provider === "oss" &&
    /(^|\.)s3\.oss-[^.]+\.aliyuncs\.com$/i.test(
      new URL(out.endpoint).hostname.replace(/\.$/, ""),
    )
  )
    fail(
      "INVALID_INPUT",
      "OSS原生接入不能使用S3兼容域名，请使用oss-地域.aliyuncs.com并核对区域。",
    );
  if (
    c.provider === "tos-native" &&
    /(^|\.)tos-s3-[^.]+\.volces\.com$/i.test(
      new URL(out.endpoint).hostname.replace(/\.$/, ""),
    )
  )
    fail(
      "INVALID_INPUT",
      "TOS原生接入不能使用S3兼容域名，请使用tos-地域.volces.com并核对区域。",
    );
  if (c.id !== undefined) out.id = validateId(c.id);
  return out;
}
export function validateCredentials(input) {
  const c = record(input);
  const out = {
    accessKeyId: text(c.accessKeyId, "Access Key", 4096, true),
    secretAccessKey: text(c.secretAccessKey, "Secret Key", 4096, true),
  };
  if (c.sessionToken !== undefined)
    out.sessionToken = text(c.sessionToken, "Session Token", 16384);
  return out;
}
