export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
export function fail(code, message) {
  throw new AppError(code, message);
}
export function publicError(error) {
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : { code: "INTERNAL_ERROR", message: "操作失败，请重试。" };
}
export function record(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("INVALID_INPUT", "参数必须为对象。");
  return value;
}
export function text(value, name, max = 2048, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim()) ||
    value.includes("\0")
  )
    fail("INVALID_INPUT", `${name}格式无效。`);
  return value;
}
