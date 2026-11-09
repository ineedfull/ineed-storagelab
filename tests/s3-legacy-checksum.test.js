import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "../electron/s3/client.js";

test("batch deletion supplies the serialized XML MD5 required by older MinIO", async () => {
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received = {
      body: body.toString("utf8"),
      md5: request.headers["content-md5"],
      expected: createHash("md5").update(body).digest("base64"),
    };
    response.setHeader("Content-Type", "application/xml");
    if (received.md5 !== received.expected) {
      response.writeHead(400);
      response.end(
        "<Error><Code>MissingContentMD5</Code><Message>Content-MD5 is required</Message></Error>",
      );
    } else {
      response.end(
        '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Deleted><Key>对象&amp;&lt;.txt</Key></Deleted></DeleteResult>',
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = createS3Client(
    {
      endpoint: `http://127.0.0.1:${server.address().port}`,
      region: "us-east-1",
      forcePathStyle: true,
    },
    { accessKeyId: "local-test", secretAccessKey: "local-test-only" },
    { timeoutSeconds: 5 },
    { maxAttempts: 1 },
  );
  try {
    const result = await client.send(
      new DeleteObjectsCommand({
        Bucket: "fixture",
        Delete: { Objects: [{ Key: "对象&<.txt" }] },
      }),
    );
    assert.equal(result.Deleted[0].Key, "对象&<.txt");
    assert.equal(received.md5, received.expected);
    assert.match(received.body, /对象&amp;&lt;\.txt/);
  } finally {
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
