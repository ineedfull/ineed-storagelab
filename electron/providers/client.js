import { createS3Client } from "../s3/client.js";
import { createOssClient } from "./oss.js";
import { createObsClient } from "./obs.js";
import { createCosClient } from "./cos.js";
import { createTosClient } from "./tos.js";

// Existing queues use a stable command/response shape. The selected adapter
// owns the actual vendor transport and signing; legacy profiles retain S3.
export function createProviderClient(
  connection,
  credentials,
  settings,
  options,
) {
  switch (connection.provider) {
    case "oss":
      return createOssClient(connection, credentials, settings, options);
    case "obs":
      return createObsClient(connection, credentials, settings, options);
    case "cos-native":
      return createCosClient(connection, credentials, settings, options);
    case "tos-native":
      return createTosClient(connection, credentials, settings, options);
    default:
      return createS3Client(connection, credentials, settings, options);
  }
}
