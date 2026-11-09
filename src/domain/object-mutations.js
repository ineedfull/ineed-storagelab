import { fail, record, text } from "./errors.js";
export function validateMutationKey(key) {
  text(key, "Key", 1024);
  if (!key.length || new TextEncoder().encode(key).length > 1024)
    fail("INVALID_INPUT", "Key必须为1至1024字节。");
  return key;
}
export function validateMetadata(metadata) {
  record(metadata);
  let bytes = 0;
  const seen = new Set();
  for (const [key, value] of Object.entries(metadata)) {
    if (
      !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) ||
      typeof value !== "string" ||
      !/^[\x20-\x7e]*$/.test(value) ||
      seen.has(key.toLowerCase())
    )
      fail("INVALID_INPUT", "Metadata须为不重复的ASCII键和可见ASCII值。");
    seen.add(key.toLowerCase());
    bytes += key.length + value.length;
  }
  if (bytes > 2048) fail("INVALID_INPUT", "Metadata总大小不能超过2KiB。");
  return metadata;
}
export function validateMutation(p) {
  validateMutationKey(p.key);
  if (!["copy", "rename", "metadata"].includes(p.kind))
    fail("INVALID_INPUT", "对象操作类型无效。");
  record(p.original);
  if (
    p.original.key !== p.key ||
    !Number.isSafeInteger(p.original.size) ||
    p.original.size < 0 ||
    typeof p.original.etag !== "string" ||
    !p.original.etag
  )
    fail("INVALID_INPUT", "请先读取完整对象快照。");
  if (p.kind !== "metadata") {
    validateMutationKey(p.targetKey);
    if (p.key === p.targetKey) fail("INVALID_INPUT", "目标Key不能与源相同。");
  } else {
    text(p.contentType, "Content-Type", 2048, true);
    text(p.cacheControl, "Cache-Control", 2048);
    for (const v of [p.contentType, p.cacheControl])
      if (!/^[\x20-\x7e]*$/.test(v))
        fail("INVALID_INPUT", "HTTP元数据须使用可见ASCII。");
    validateMetadata(p.metadata);
  }
}
