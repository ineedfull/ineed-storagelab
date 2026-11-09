import {
  AppError,
  fail,
  record,
  publicError,
  text,
} from "../src/domain/errors.js";
import { validateId } from "../src/domain/connection.js";
import { validateObjectTags } from "../src/domain/object-tags.js";
import {
  validateMutation,
  validateMutationKey,
} from "../src/domain/object-mutations.js";
export const METHODS = Object.freeze([
  "prepareDirectory",
  "startDirectory",
  "discardDirectoryPlan",
  "listDirectoryBatches",
  "getDirectoryBatch",
  "cancelDirectory",
  "exportDirectory",
  "prepareObjectMutation",
  "executeObjectMutation",
  "bootstrap",
  "saveConnection",
  "removeConnection",
  "checkConnection",
  "listBuckets",
  "listObjects",
  "headObject",
  "listObjectVersions",
  "headObjectVersion",
  "restoreObjectVersion",
  "downloadObjectVersion",
  "getObjectTags",
  "saveObjectTags",
  "previewObject",
  "shareObject",
  "deleteObjects",
  "resumeUpload",
  "discardUpload",
  "uploadFiles",
  "downloadFiles",
  "listJobs",
  "cancelJob",
  "retryJob",
  "removeJob",
  "openJobFile",
  "revealJobFile",
  "exportJobs",
  "saveSettings",
  "copyText",
  "openWebsite",
]);
export const INVOKE_CHANNEL = "storagelab:invoke";
export const CHANGE_CHANNEL = "storagelab:change";
function validateRawKey(key) {
  text(key, "Key", 1024);
  if (key.length === 0) fail("INVALID_INPUT", "Key不能为空。");
  return key;
}
function validateKeyMarker(marker) {
  text(marker, "Key标记", 16384);
  if (!marker.length) fail("INVALID_INPUT", "Key标记不能为空。");
}
export function validatePayload(method, payload) {
  record(payload);
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    fail("INVALID_INPUT", "参数无法序列化。");
  }
  if (serialized.length > 262144) fail("INVALID_INPUT", "参数超出大小限制。");
  if (method === "prepareDirectory") {
    validateId(payload.connectionId);
    text(payload.bucket, "桶", 255, true);
    text(payload.prefix, "前缀", 1024);
    if (
      (payload.prefix && !payload.prefix.endsWith("/")) ||
      !["upload", "download"].includes(payload.direction) ||
      !["skip", "overwrite"].includes(payload.conflict)
    )
      fail("INVALID_INPUT", "目录方向、前缀或冲突策略无效。");
    if (
      Object.keys(payload).some(
        (k) =>
          ![
            "connectionId",
            "bucket",
            "prefix",
            "direction",
            "conflict",
          ].includes(k),
      )
    )
      fail("INVALID_INPUT", "目录预览参数无效。");
  }
  if (["startDirectory", "discardDirectoryPlan"].includes(method)) {
    validateId(payload.token);
    if (Object.keys(payload).some((k) => k !== "token"))
      fail("INVALID_INPUT", "此操作仅接受预览token。");
  }
  if (
    ["getDirectoryBatch", "cancelDirectory", "exportDirectory"].includes(method)
  ) {
    validateId(payload.id);
    if (Object.keys(payload).some((k) => k !== "id"))
      fail("INVALID_INPUT", "此操作仅接受批次ID。");
  }
  if (["prepareObjectMutation", "executeObjectMutation"].includes(method)) {
    validateId(payload.connectionId);
    text(payload.bucket, "桶", 255, true);
    validateMutationKey(payload.key);
    if (method === "executeObjectMutation") validateMutation(payload);
  }
  const versionMethod = [
    "listObjectVersions",
    "headObjectVersion",
    "restoreObjectVersion",
    "downloadObjectVersion",
  ].includes(method);
  if (versionMethod) {
    validateId(payload.connectionId);
    text(payload.bucket, "桶", 255, true);
    validateRawKey(payload.key);
    if (method !== "listObjectVersions")
      text(payload.versionId, "版本ID", 1024, true);
    if (payload.keyMarker !== undefined) validateKeyMarker(payload.keyMarker);
    if (payload.versionIdMarker !== undefined) {
      text(payload.versionIdMarker, "版本标记", 1024, true);
      validateKeyMarker(payload.keyMarker);
    }
  }
  if (
    [
      "removeConnection",
      "cancelJob",
      "retryJob",
      "removeJob",
      "openJobFile",
      "revealJobFile",
      "resumeUpload",
      "discardUpload",
    ].includes(method)
  )
    validateId(payload.id);
  if (
    [
      "checkConnection",
      "listBuckets",
      "listObjects",
      "headObject",
      "getObjectTags",
      "saveObjectTags",
      "previewObject",
      "shareObject",
      "deleteObjects",
      "uploadFiles",
      "downloadFiles",
    ].includes(method)
  )
    validateId(payload.connectionId);
  if (
    [
      "listObjects",
      "headObject",
      "getObjectTags",
      "saveObjectTags",
      "previewObject",
      "shareObject",
      "deleteObjects",
      "uploadFiles",
      "downloadFiles",
    ].includes(method)
  )
    text(payload.bucket, "桶", 255, true);
  if (method === "checkConnection" && payload.bucket !== undefined)
    text(payload.bucket, "桶", 255, true);
  if (
    [
      "headObject",
      "previewObject",
      "shareObject",
      "getObjectTags",
      "saveObjectTags",
    ].includes(method)
  )
    validateRawKey(payload.key);
  if (
    ["getObjectTags", "saveObjectTags"].includes(method) &&
    payload.versionId !== undefined
  )
    text(payload.versionId, "版本ID", 1024, true);
  if (method === "saveObjectTags") {
    validateObjectTags(payload.tags);
    validateObjectTags(payload.originalTags);
  }
  if (payload.prefix !== undefined) text(payload.prefix, "Prefix", 1024);
  if (payload.cursor !== undefined) text(payload.cursor, "Cursor", 16384);
  if (["deleteObjects", "downloadFiles"].includes(method)) {
    if (
      !Array.isArray(payload.keys) ||
      !payload.keys.length ||
      payload.keys.length > 200
    )
      fail("INVALID_INPUT", "请选择1至200个对象。");
    for (const key of payload.keys) validateRawKey(key);
  }
  if (
    method === "shareObject" &&
    (!["signed", "public"].includes(payload.kind) ||
      !Number.isInteger(payload.expiresIn) ||
      payload.expiresIn < 60 ||
      payload.expiresIn > 604800)
  )
    fail("INVALID_INPUT", "分享参数无效。");
  if (method === "copyText") text(payload.text, "文本", 1048576);
  if (payload.overwrite !== undefined && typeof payload.overwrite !== "boolean")
    fail("INVALID_INPUT", "覆盖选项无效。");
  if (
    payload.resumable !== undefined &&
    (method !== "uploadFiles" || typeof payload.resumable !== "boolean")
  )
    fail("INVALID_INPUT", "续传选项无效。");
  if (
    ["resumeUpload", "discardUpload"].includes(method) &&
    Object.keys(payload).some((k) => k !== "id")
  )
    fail("INVALID_INPUT", "续传操作仅接受任务ID。");
  // Production file grants originate exclusively from native pickers.
  if (
    ["removeJob", "openJobFile", "revealJobFile"].includes(method) &&
    Object.keys(payload).some((k) => k !== "id")
  )
    fail("INVALID_INPUT", "任务文件操作仅接受任务ID。");
  for (const key of ["path", "paths", "directory", "filePath", "destination"])
    if (key in payload) fail("INVALID_INPUT", "不接受外部文件路径。");
  return payload;
}
export function registerIpc({ ipcMain, trustedUrl, getWebContents, dispatch }) {
  const handler = async (event, method, payload = {}) => {
    try {
      const contents = getWebContents();
      if (
        !contents ||
        event.sender.id !== contents.id ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame?.url !== trustedUrl
      )
        fail("UNTRUSTED_SENDER", "页面来源不受信任。");
      if (!METHODS.includes(method)) fail("UNKNOWN_METHOD", "未知操作。");
      validatePayload(method, payload);
      return { ok: true, value: await dispatch(method, payload) };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  };
  ipcMain.handle(INVOKE_CHANNEL, handler);
  return () => ipcMain.removeHandler(INVOKE_CHANNEL);
}
export function createChangeNotifier(send, delay = 100) {
  let timer;
  return {
    notify() {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          send();
        }, delay);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
