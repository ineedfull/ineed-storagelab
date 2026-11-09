# StorageLab Object Management Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task. Shared original product directory is required by user AGENTS; no source copying/moving. One implementation agent at a time; controller may edit disjoint UI/docs. Each task needs independent review before advancing.

**Goal:** 实现同桶复制/受控重命名、元数据编辑、上传重启断点恢复，并整体压力验收与打包。
**Architecture:** 独立S3对象变更模块与原生确认；Vue管理窗口复用；私有版本化checkpoint与分片上传恢复，队列公开历史不含路径/密钥。
**Tech Stack:** 现有Vue/Electron/AWS SDK/SQLite/node:test/Playwright，不新增依赖。
**Spec:** docs/superpowers/specs/2026-10-28-object-management-design.md

## Global Constraints

- 原始Key≤1024 UTF-8字节，不trim；单次Copy≤5GiB；只读原生阻止写入；Copy/删除不自动重试。
- 不改变应用ID/userData/安全凭证策略，保留schema1兼容；仅隔离回环目标；不访问146或自动发布。
- 不承诺目标跨请求事务/同ETag变更保护；不永久删版本。所有部分成功都可读、可核实。

### Task 1: 原生对象变更链路

**Ownership:** electron/s3/mutations.js（新增）、src/domain/object-mutations.js（新增）、electron/ipc.js、electron/service.js、electron/s3/operations.js；tests/object-mutations.test.js、tests/integration/object-mutations.test.js（新增）。不改UI/传输/store。

- [x] 写失败Node测试：IPC原始Key/元数据限制、prepare快照、源变更拒绝、目标不覆盖条件、只读/确认取消、复制成功后删除失败部分结果、编码和标准元数据保留。
- [x] 实现prepareObjectMutation/executeObjectMutation固定方法；prepare返回可序列化HEAD快照，execute携原始快照、kind(copy/rename/metadata)、targetKey/overwrite或metadata字段。原生确认前后比较源快照，捕获连接并锁定。
- [x] CopyIfNoneMatch能力仅对官方AWS接入开放（本轮实际MinIO忽略Copy和Delete条件，因此禁用其能力），其他提供商需显式覆盖；服务确认/错误不得假称原子。条件Delete未知时复制成功源保留。验证目标再删除、IfMatch、删除失败不丢复制结果。
- [x] 元数据REPLACE保留ContentDisposition/Encoding/Language/Expires/WebsiteRedirectLocation等未编辑属性，保留标签（不支持标签提供商按能力处理）、正文与版本语义清楚。HEAD公开快照必要字段，不泄密。
- [x] 真实本地MinIO集成：复制/冲突/重命名/源未丢失/元数据正文与标签读回；测试清理完整；交报告，不自行提交或开代理。controller负责commit/review。

### Task 2: 管理窗口与交互验收

**Ownership:** 新useObjectMutation.js、ObjectMutationDialog.vue、Workbench/ObjectDetails、管理CSS、tests/ui/object-mutations.spec.js及定向composable测试。

- [x] 失败UI测试覆盖选择对象打开、读取失败/取消/部分完成、目标原始Key、元数据草稿和上下文隔离。
- [x] 实现复制/重命名/编辑元数据三个入口和同一窗口。原生确认工作期间禁止关闭；提交后成功或部分完成显示准确结果并刷新当前相同上下文；不使用全局action污染新上下文。
- [x] 16显示组合、窄窗/长Key/滚动和焦点返回，检查代表截图；真实Electron→IPC→MinIO流程。

### Task 3: 上传checkpoint与原生恢复

**Ownership:** 新增electron/transfers/checkpoints.js、resumable-upload.js、resume-service.js；electron/service.js/queue.js/store.js/IPC必要接线；tests/resumable-upload.test.js、tests/integration/resumable-upload.test.js。controller负责TaskCenter/ObjectBrowser UI，worker不改UI/native host及其他文件。

- [x] 先失败回归：私有记录持久化/安全边界、重启凭证/配置变化、文件重授权与完整指纹、ListParts匹配、不重发已完成分片、取消/清理、完成结果不明。
- [x] uploadFiles增加可选resumable:boolean（默认false）；显式选择续传上传仅支持≥8MiB、≤64GiB普通文件，小文件明确提示普通上传，普通上传行为保持。
- [x] 私有checkpoint版本1 JSON权限0600、原子保存；本地目录app.getPath('userData')/upload-checkpoints；没有path/credentials/signature URL，只有连接指纹、目标/覆盖策略、完整SHA256和size、UploadId、已完成part identity、阶段。JSON解析验证，公开job只新增resumable/resumeAvailable；旧schema1任务兼容，不升级SQLite结构。
- [x] 队列取消或服务退出保留续传分片，显式discardUpload({id})原生确认后Abort清理且删除checkpoint；失败保留记录并可重试。普通上传取消仍清理分片。
- [x] resumeUpload({id})只接受jobId，经原生picker重新选择一个文件；指纹size+完整SHA256一致（可不同路径），配置指纹一致且有当前凭证，再ListParts分页核验已完成part号码/大小/ETag；不可信或变化拒绝，绝不猜测跳过。尚无uploadID可按同策略重新开始，需明确状态。
- [x] 手写有界分片循环，每part8MiB（最后可短），串行或最多2并发，最大内存有界；UploadPart成功再保存checkpoint、真实进度。完整文件指纹计算使用stream、绑定打开file handle及stat，Complete前重新核验完整内容，拒绝过程变更。
- [x] Complete前持久化completing状态；不自动重试Create/Complete；把唯一私有resume token存对象Metadata辅助结果识别，保留ContentType。发生完成响应不明时HEAD核验token/size，必要时可确认成功；不能核实则保留不确定状态，禁止重复Complete或重传盲目覆盖。采用已有上传覆盖授权及IfNoneMatch策略，非已验证厂商拒绝默认不覆盖。
- [x] API结果resumeUpload与uploadFiles一样{jobs,cancelled?}；discardUpload返回{discarded:true}或cancelled。bootstrap/listJobs动态注入resumeAvailable（仅终态有效私有记录）；retryJob对resumable走明确重新授权提示，不复用已失效checkpoint闭包。
- [x] 每个恢复checkpoint只能一个活跃job；恢复新job关联同checkpoint，旧job不再显示可恢复。连接编辑/删除后旧checkpoint不能重新指向新服务；禁止盲Abort到已变化Endpoint，明确提示不能远端清理。
- [x] 真实MinIO跨store/service重启至少一个8MiB已完成part并独立读回最终正文SHA256；可注入SDK连接切断来确定中断点，重启用真实新service。断网后checkpoint安全、拒绝不同文件/配置、放弃清理和公开导出无UploadId；测试清理全量版本和分片。
- [x] 完成报告，controller负责UI接线/原生验收/独立review/提交；不得启动新MinIO、开子代理或提交其他文件。

### Task 4: 整体验收、压力与打包交接

- [x] 独立代码审查各子项，修复并复核；全量Node/集成/UI/原生/构建/格式及diff。
- [x] 隔离MinIO持续传输压力与异常/取消/断连/恢复，至少20分钟负载，记录实际时长/完整性/资源/限制，不宣称所有云和平台验收。
- [x] 本机适用安装包重新构建并校验；目标平台原生/签名差异明确，无自动上传发布。
- [x] 产品使用/架构/验证和工作区任务索引更新；明确文件提交，无push。
