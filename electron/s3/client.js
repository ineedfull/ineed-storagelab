import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";
export function createS3Client(
  connection,
  credentials,
  settings,
  { maxAttempts = 3 } = {},
) {
  const client = new S3Client({
    endpoint: connection.endpoint,
    region: connection.region,
    forcePathStyle: connection.forcePathStyle,
    credentials: { ...credentials },
    maxAttempts,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: Math.min(10000, settings.timeoutSeconds * 1000),
      socketTimeout: settings.timeoutSeconds * 1000,
      requestTimeout: settings.timeoutSeconds * 1000,
      throwOnRequestTimeout: true,
    }),
  });
  // Older MinIO requires MD5 for batch deletion even when the SDK sends CRC32.
  // Hash the serialized XML before signing; never buffer object upload streams.
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const request = args.request;
      if (
        context.commandName === "DeleteObjectsCommand" &&
        typeof request.body === "string" &&
        !request.headers["content-md5"]
      ) {
        request.headers["content-md5"] = createHash("md5")
          .update(request.body, "utf8")
          .digest("base64");
      }
      return next(args);
    },
    { step: "build", name: "legacyDeleteContentMd5", priority: "low" },
  );
  return client;
}
