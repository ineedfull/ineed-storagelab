import { AppError } from "../../src/domain/errors.js";
export function storageError(error) {
  if (error instanceof AppError) return error;
  const name = error?.name ?? error?.Code;
  const status = error?.$metadata?.httpStatusCode;
  if (["InvalidTag", "InvalidTagError", "TooManyTags"].includes(name))
    return new AppError(
      "INVALID_TAGS",
      "存储服务拒绝此标签格式或数量，请检查字符限制（部分服务仅接受ASCII标签）。",
    );
  if (name === "AbortError") return new AppError("CANCELLED", "操作已取消。");
  if (
    status === 403 ||
    [
      "AccessDenied",
      "InvalidAccessKeyId",
      "SignatureDoesNotMatch",
      "ExpiredToken",
    ].includes(name)
  )
    return new AppError(
      "ACCESS_DENIED",
      "权限不足或凭证无效，请检查连接与桶权限。",
    );
  if (
    status === 404 ||
    ["NotFound", "NoSuchKey", "NoSuchBucket"].includes(name)
  )
    return new AppError("NOT_FOUND", "对象或桶不存在。");
  if (
    status === 412 ||
    name === "PreconditionFailed" ||
    error?.code === "EEXIST"
  )
    return new AppError("ALREADY_EXISTS", "目标已存在，未覆盖。");
  if (status === 501 || ["NotImplemented", "NotSupported"].includes(name))
    return new AppError("UNSUPPORTED", "存储服务不支持此操作。");
  if (status === 409 || name === "ConditionalRequestConflict")
    return new AppError("CONFLICT", "对象发生并发变更，请刷新后重试。");
  if (
    status >= 500 ||
    [
      "TimeoutError",
      "RequestTimeout",
      "NetworkingError",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
    ].includes(name) ||
    ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"].includes(
      error?.code,
    )
  )
    return new AppError("NETWORK_ERROR", "网络或存储服务暂时不可用，请重试。");
  return new AppError(
    "STORAGE_ERROR",
    "存储操作失败，请检查服务状态与兼容性。",
  );
}
