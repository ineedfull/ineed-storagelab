import { fail, record } from "./errors.js";

// S3 counts UTF-16 units. Preserve spaces/case: tags are not display labels.
const characters = /^[\p{L}\p{N}\p{Z}_.:/=+@-]*$/u;
export function validateObjectTags(tags) {
  if (!Array.isArray(tags) || tags.length > 10)
    fail("INVALID_INPUT", "每个对象最多10个标签。");
  const keys = new Set();
  return tags.map((tag) => {
    record(tag);
    if (
      typeof tag.key !== "string" ||
      !tag.key.length ||
      tag.key.length > 128 ||
      typeof tag.value !== "string" ||
      tag.value.length > 256 ||
      !characters.test(tag.key) ||
      !characters.test(tag.value) ||
      /^aws:/i.test(tag.key) ||
      keys.has(tag.key)
    )
      fail(
        "INVALID_INPUT",
        "标签Key须唯一且为1–128字符，Value最多256字符；仅允许字母、数字、空格和 _ . : / = + @ -，不能使用aws:前缀。",
      );
    keys.add(tag.key);
    return { key: tag.key, value: tag.value };
  });
}

export function sameObjectTags(a, b) {
  const pairs = (tags) =>
    tags.map((t) => JSON.stringify([t.key, t.value])).sort();
  const left = pairs(a),
    right = pairs(b);
  return (
    left.length === right.length &&
    left.every((pair, index) => pair === right[index])
  );
}
