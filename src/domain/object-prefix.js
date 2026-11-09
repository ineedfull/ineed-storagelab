/** Remove exactly one raw slash-delimited level, including an empty segment. */
export function parentPrefix(prefix) {
  const end = prefix.endsWith("/") ? prefix.length - 1 : prefix.length;
  if (end === 0) return "";
  return prefix.slice(0, prefix.lastIndexOf("/", end - 1) + 1);
}
