export async function installFixture(page) {
  await page.addInitScript(() => {
    let settings = {
        theme: "light",
        largeText: false,
        sidebarCollapsed: false,
        concurrency: 2,
        timeoutSeconds: 30,
      },
      connections = [
        {
          id: "c1",
          name: "本地测试",
          group: "开发环境",
          provider: "minio",
          endpoint: "http://127.0.0.1:9000",
          region: "us-east-1",
          forcePathStyle: true,
          defaultBucket: "known",
          hasCredentials: true,
          credentialStorage: "session",
        },
      ],
      jobs = [];
    window.__failSettings = false;
    const objectTags = {};
    window.__tagCalls = [];
    window.storageLab = {
      invoke: async (method, payload = {}) => {
        try {
          let value;
          switch (method) {
            case "getObjectTags":
              window.__tagCalls.push({ method, payload });
              if (window.__denyTags)
                throw Object.assign(new Error("标签权限不足"), {
                  code: "ACCESS_DENIED",
                });
              value = {
                tags: objectTags[payload.key] ?? [],
                versionId: "fixture-version",
              };
              break;
            case "saveObjectTags":
              window.__tagCalls.push({ method, payload });
              objectTags[payload.key] = payload.tags;
              value = {
                saved: true,
                tags: payload.tags,
                versionId: payload.versionId,
              };
              break;
            case "bootstrap":
              value = {
                connections,
                settings,
                jobs,
                app: {
                  native: true,
                  vaultAvailable: false,
                  version: "1.0.0",
                  runtime: "test-only browser fixture",
                  dataDirectory: "isolated",
                },
              };
              break;
            case "listBuckets":
              throw Object.assign(new Error("无权列桶，请手输已知桶"), {
                code: "PERMISSION_DENIED",
              });
            case "listObjects":
              value = {
                objects: payload.cursor
                  ? [{ key: "next.txt", size: 1, lastModified: 0 }]
                  : payload.prefix
                    ? [
                        {
                          key: payload.prefix + "raw\\../对象.txt",
                          size: 12,
                          lastModified: 0,
                        },
                      ]
                    : [
                        { key: "slow.txt", size: 4, lastModified: 0 },
                        { key: "fast.txt", size: 4, lastModified: 0 },
                      ],
                prefixes: payload.prefix ? [] : ["raw/../"],
                nextCursor: payload.cursor ? undefined : "raw-cursor",
              };
              break;
            case "headObject":
              await new Promise((r) =>
                setTimeout(r, payload.key === "slow.txt" ? 250 : 0),
              );
              value = {
                key: payload.key,
                size: 4,
                lastModified: 0,
                contentType: "text/plain",
                metadata: { raw: payload.key },
              };
              break;
            case "previewObject":
              value = {
                kind: "text",
                content: payload.key,
                contentType: "text/plain",
              };
              break;
            case "saveConnection":
              value = {
                ...payload.connection,
                id: payload.connection.id || "new",
                hasCredentials: true,
                credentialStorage: payload.credentialStorage,
              };
              connections = connections
                .filter((c) => c.id !== value.id)
                .concat(value);
              break;
            case "saveSettings":
              if (window.__failSettings)
                throw new Error("模拟 SQLite 保存失败");
              settings = payload;
              value = settings;
              break;
            case "listJobs":
              value = jobs;
              break;
            case "uploadFiles":
            case "downloadFiles":
              jobs = [
                {
                  id: "j1",
                  connectionId: "c1",
                  connectionName: "本地测试",
                  bucket: "known",
                  key: "payload.bin",
                  direction: method === "uploadFiles" ? "upload" : "download",
                  state: "running",
                  bytesTransferred: 20,
                  totalBytes: 100,
                  rate: 10,
                  updatedAt: 0,
                },
              ];
              value = { jobs };
              break;
            case "cancelJob":
              jobs[0].state = "cancelled";
              value = jobs[0];
              break;
            case "retryJob":
              jobs[0].state = "running";
              value = jobs[0];
              break;
            case "deleteObjects":
              value = {
                deleted: [payload.keys[0]],
                errors: [
                  {
                    key: "denied.txt",
                    code: "PERMISSION_DENIED",
                    message: "拒绝删除",
                  },
                ],
                versioning: "unknown",
              };
              break;
            case "shareObject":
              value = {
                url: "http://127.0.0.1/object?signed=test",
                warning: "生成未代表可访问",
              };
              break;
            default:
              value = true;
          }
          return { ok: true, value: structuredClone(value) };
        } catch (e) {
          return {
            ok: false,
            error: { code: e.code || "STORAGE_ERROR", message: e.message },
          };
        }
      },
      onChange: () => () => {},
    };
  });
}
