# 原生存储协议与传输边界

生产调用链：renderer bridge → preload → 受信任主窗口 IPC → `createService` → SDK/队列或 store。方法、payload 和 value 使用[首版契约](superpowers/specs/2026-10-27-storagelab-v1.md)表；service 同时验证白名单与 payload，并按 UTF-8 字节限制 Key/Prefix1024。renderer 没有文件系统、凭证读取、测试 fixture 或任意目标地址接口。`getCredentials` 仅在原生捕获稳定连接上下文。

`createService({store,dialog,clipboard,shell,app,vaultAvailable?,clientFactory?})` 提供 `invoke(method,payload={})`、`onChange(callback) => unsubscribe`、`dispose() => Promise`。原生 invoke 返回表中 value、失败抛已清洗 AppError，IPC 再封装 envelope。onChange 不含业务数据；main 用100ms节流转发。app 提供真实名称、版本及 userData；vaultAvailable 可为 getter 函数。生产 dialog 是 Electron dialog；测试只能在原生侧依赖注入选文件、选目录、删除确认。

AWS SDK v3 凭证含可选 sessionToken，V4签名，使用连接 endpoint/region/pathStyle。maxAttempts3，连接超时不超过10秒，socket/request超时为设置5–120秒；checksum request/response `WHEN_REQUIRED`，不关闭 TLS 校验。listObjects 使用 delimiter `/`、MaxKeys200与原样 prefix/cursor；原始 Key 不改反斜杠、不消解 dot segments。ListBuckets 失败与已知桶访问独立。head 属性只读，ETag 仅展示。预览先 HEAD，随后逐块累计实际读取量，文本/JSON2MiB、PNG/JPEG/GIF/WebP8MiB，拒绝 HTML/SVG，超限关闭响应流。

签名 URL 直接由指定连接签名，不替换主机名；60–604800秒，默认900由调用端提供。URL不持久化到任务或日志；临时凭证可提前失效，生成不代表可访问。publicBaseUrl 独立拼接按完整 raw key 分段编码；含 dot segments 或反斜杠、无法安全表示的公开 Key 拒绝。

所有写入在原生检查 readOnly；删除先查询版本状态，失败为unknown；原生确认展示桶、数量、全部Key、版本状态及删除标记/历史版本语义。取消确认不发送 DeleteObjects；HTTP200逐项 Errors 原样关联Key、错误内容映射成安全分类。

多文件上传/下载目录来自原生 picker。每文件最大64GiB，整体并发设置1–4，最多100排队、200最近任务/本会话授权上下文；终态淘汰旧授权。上传使用 AWS Upload，partSize8MiB、queueSize2、leavePartsOnError=false；打开时拒绝符号链接，并校验选择时 dev/ino/size/mtime，失败/取消中止本任务 multipart。SDK3.1157.0 将 `IfNoneMatch:'*'` 传入 PutObject 和 CompleteMultipartUpload；默认不覆盖同时做 HEAD与最终条件提交，绝不退回仅HEAD保护。不支持条件写入时明确拒绝。真实 MinIO 已验证 multipart 条件提交的竞争写入不会被覆盖；其他服务须实现标准条件写入语义，未宣称全部厂商已验收。

下载流式写入同目录随机0600 `.part` 文件；校验实际字节数等于响应 ContentLength，fsync并关闭后提交；不以ETag或大小宣称内容哈希验证。默认通过 hard-link 排他提交，避免检查后竞争覆盖；文件系统不支持时明确拒绝，不退回非原子覆盖。显式覆盖使用同目录rename。失败/取消清理半成品；临时文件清理失败但已提交目标时，任务保持success并显示警告。Key路径拒绝绝对/空段/dot/反斜杠、Windows非法/保留名、尾点空格、选择内大小写/Unicode/文件目录冲突、现存大小写别名和符号链接目录/目标。对用户选择目录之外的恶意进程同时改写路径，不提供操作系统沙箱隔离保证。

队列状态遵循契约；运行取消先cancelling，实际提交成功优先于较晚取消。进度是真实字节，原生历史保存最多每100ms一次，终态完整保存。每任务捕获稳定连接/凭证和文件授权，queued/running/cancelling期间持有连接锁；重试仅保留于本会话最近200上下文中的failed/cancelled，上传重试再次检查当前readOnly。重启由store转interrupted，凭证会话和文件授权不恢复；必须重新选择。不将原始 SDK/SQLite Error、headers、链接或磁盘路径放公开任务。远端成功但历史保存失败保留内存真实success并附警告；退出dispose abort、清理监听器，main最多等待3秒。

## 可复用隔离集成环境

`npm run test:integration` 未配置时明确skip。设置 `STORAGELAB_TEST_CONFIG` 指向原生私有 JSON `{endpoint,accessKeyId,secretAccessKey,sessionToken?}`；或提供 `STORAGELAB_TEST_ENDPOINT/STORAGELAB_TEST_ACCESS_KEY_ID/STORAGELAB_TEST_SECRET_ACCESS_KEY`。只接受回环目标，无生产默认值。每次随机 `storagelab-UUID` 桶、临时SQLite/文件目录，finally清理桶/分片/目录。

`tests/integration/setup.js` 导出 `integrationConfig()`、`createIntegrationFixture(config)`、`waitForJobs(service,ids)`；fixture提供 service/store/client/profile/bucket/directory，原生方法 selectUploads(paths)、selectDownloadDirectory(path)、confirmDelete(bool)、reopen()、cleanup()。它不进入生产入口，可供后续原生窗口测试使用真实本地 provider，而不让 renderer 获得路径或密钥。

真实官方 MinIO 的 ListBuckets 在无 ListAllMyBuckets 权限时可能返回有权访问桶的过滤列表，不能等同403；该实现行为已区分。`STORAGELAB_TEST_RESTRICTED=1` 使用导出的 `createListDeniedProxy(config)`，仅根GET注入403，其余对象请求转发真实本地MinIO、保留签名Host。403来自明确的测试代理；已知桶访问、上传/下载/签名/删除来自真实MinIO。原生后续UI测试可复用这个边界，不混称代理错误是provider原生行为。

上传 Content-Type 根据保守文件名后缀设置：txt/log→text/plain、csv→text/csv、json→application/json、png/jpg/jpeg/gif/webp→对应位图类型，未知/HTML/SVG→application/octet-stream。仅是文件名推断元数据，不读取或证明文件内容；预览仍执行既有安全类型与实际字节限制。
