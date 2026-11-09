# 对象版本与恢复

2026-10-28。在原工作台新增单对象历史、指定版本下载和受控恢复；不改变schema1、应用ID、凭证方式或依赖。适用于提供相应S3版本接口的服务和账号，R2接入明确不可用；其他云账号尚未实际联调。

## 使用

1. 选连接并打开桶，点击工具栏“版本与恢复”；或选对象，在详情点击“查看此 Key 的版本”。
2. 填完整原始Key，点击“读取历史版本”。Key可以当前已删除；不会因打开窗口扫描全桶。Key不裁剪、不规范化；空格也是合法字符。
3. 列表显示数据版本、删除标记、最新状态、本地毫秒时间、大小和版本ID；只显示严格相等Key。每页最多200，下一页使用服务原样返回的双标记。服务按Prefix查询，某页可能只含相邻Key而本页为空，仍可显式翻页；本页为空不等于全桶没有历史。
4. 点击数据版本ID读取该版本属性、Metadata和可读的Object Lock保留头。缺失保留模式/到期/Legal Hold不代表无保护，可能是权限或兼容性限制。删除标记只展示，不提供下载或恢复；若要找回内容，选择此前的数据版本。
5. “下载所选版本”通过原生目录选择器加入现有流式队列。默认拒绝本地同名覆盖；不同版本使用同一Key相对路径，可选不同目录或明确允许覆盖。任务中心和导出保留VersionId，当前会话重试仍固定该版本；重启不保留目录授权、不续传。响应VersionId不一致则拒绝落盘，避免服务忽略版本参数而保存当前内容。
6. “恢复为当前对象”先由原生确认目标连接、桶、完整Key与源版本，再将历史内容复制为当前对象的新版本。成功后刷新本Key历史和当前桶列表。历史数据与删除标记都保留。

窗口固定打开时的连接/桶上下文；改Key或关闭会使旧响应失效。下载选择/恢复确认正在执行时暂不能关闭，防止目标和结果不明确。读取权限错误与空态分开；刷新后再核实异常结果。

## 恢复边界

- 只读连接在原生阻止恢复，仍可查看和下载。
- 桶版本控制必须确认`enabled`，未知/暂停/未开启拒绝恢复。需要读取桶版本状态的权限，不能仅凭界面显示判断。
- 仅非空且非字面量`null`的不可变数据VersionId；HEAD返回的版本必须一致，大小已知且≤5 GiB，并有ETag作为源条件。`null`版本可被替换，仅允许查看和下载当时内容。
- 单次CopyObject使用精确VersionId和CopySourceIfMatch，源Key逐段编码；保留正文、Metadata与标签。旧ACL不继承，新对象通常采用默认private ACL或桶所有权规则；加密、保留和Legal Hold不会照搬源配置，采用新对象对应的桶默认规则。需要自行核对这些默认规则是否符合业务要求。
- 原生确认后重新核验源和桶状态；服务端Copy请求不自动重试（客户端maxAttempts1）。恢复不是目标原子条件写，检查后桶状态及目标仍可能发生并发变更，后续写入可能成为最新；不提供此竞争的隔离保证。
- Copy失败或超时可能发生在服务已写入后。先重新读取历史和当前对象核实，不盲目重复操作。归档源、缺少复制/标签权限、厂商参数子集或加密限制可能拒绝恢复，不通过关闭TLS或绕过保留策略迁就服务。
- 不永久删除版本/删除标记，不修改版本控制、保留、Legal Hold或桶策略。大于5 GiB的分片复制、跨桶/跨云恢复、归档解冻、复制/重命名、元数据改写和重启续传仍需后续独立实现。

账号通常需要`s3:ListBucketVersions`、`s3:GetBucketVersioning`、`s3:GetObjectVersion`；写入另需目标`s3:PutObject`以及复制源/目标标签等相应权限。读取保留信息可能另需GetObjectRetention/GetObjectLegalHold及服务支持。权限、桶策略、KMS和厂商差异以服务实际响应为准；预设存在不是授权证明。

## 维护接口

| 方法 | 参数（另含connectionId/bucket/key） | 返回 |
| --- | --- | --- |
| `listObjectVersions` | 可选`keyMarker` / `versionIdMarker`；版本标记存在须带Key标记 | `{entries,nextPage?,versioning}` |
| `headObjectVersion` | 必填`versionId` | 绑定版本的属性、Metadata、`retention:{mode?,retainUntil?,legalHold?}` |
| `downloadObjectVersion` | 必填`versionId`，可选`overwrite` | `{jobs,cancelled?}`，任务包含versionId |
| `restoreObjectVersion` | 必填不可变`versionId` | `{restored:true,versionId?,warning}`或`{cancelled:true}` |

Key遵循现有1024 UTF-8字节限制；KeyMarker是opaque标记，可包含服务内部后缀，非空、≤16384字符，不裁剪。VersionId/版本标记≤1024字符。IPC总payload仍≤256KiB，不接受外部磁盘路径。

- `electron/s3/versions.js`：精确Key过滤、原样双标记、版本HEAD、受控Copy与源冲突映射；由operations组合。
- `electron/service.js`：捕获配置/凭证、连接锁、原生只读及确认，恢复客户端单次尝试。
- `electron/transfers/download.js` / `queue.js` / `store.js`：GET固定VersionId、响应核验、重试/公开历史保留可选VersionId。旧任务没有该字段仍兼容schema1。
- `useObjectVersions.js` / `ObjectVersionsDialog.vue`：独立窗口和请求代次、稳定表格/滚动、主题/大字/焦点返回；原生失败不污染全局或新Key。

## 验证（macOS arm64）

Node26.10.0 / Electron43.1.0，真实回环MinIO RELEASE.2025-09-07T16-13-09Z。所有命令在产品目录执行。

| 命令 | 结果 |
| --- | --- |
| `npm test` | 100通过、1原有Tauri条件跳过，0失败；版本定向13项包含在内 |
| `STORAGELAB_TEST_CONFIG=<私有回环配置> npm run test:integration` | 4通过；201个空白Key版本两页200+1、无重复/前缀隔离；删除后版本列表/指定下载/取消恢复/新版本恢复及独立SDK正文/Metadata/标签/旧版本与删除标记保留；标签与原传输相邻回归 |
| `npm run test:ui` | 60通过；版本18（2流程+16显示组合）及原工作台、标签、提供商回归 |
| `STORAGELAB_TEST_CONFIG=<私有回环配置> npm run test:native` | 构建通过、4原生流程通过，含新增生产UI→IPC→真实MinIO版本下载/取消恢复/恢复和任务VersionId |
| 改动JS/Vue/CSS的Prettier、`git diff --check` | 通过 |

开发先运行失败测试再实现。复核修复：空白KeyMarker误拒绝、MinIO附带内部cache后缀导致误截断、长Key带后缀超原Key限制、窄窗新入口被详情浮层遮挡；原生测试文件未完成即ENOENT的等待问题和环境变量skip入口也已修正。独立最终复审无遗留发现。代表浅色1440、深色大字920截图人工检查通过；16版本显示组合为浏览器生产组件，原生版本流程在1440执行，原有原生标签矩阵仍单列。

原生选择/确认由隔离harness注入，不是人工OS对话框验收。保留头渲染由定向/浏览器数据验证，真实对象锁策略与KMS、归档源、5 GiB边界对象、云厂商账号及Windows/Linux/新安装包均未在本轮实测。不访问146生产桶；测试桶/所有版本/删除标记已清理，测试服务停止、私有配置移除。代码尚未提交，没有打包或发布；现有安装包早于本功能。
