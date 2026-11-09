# StorageLab 架构与维护阅读路径

首版1.0.0使用Vue3/Vite/Electron43.1.0（嵌入Node见验收记录），工程Node>=22.16，npm锁文件。只实现Electron；没有Tauri、自动更新或后台同步。产品身份StorageLab / ineed-storagelab / com.ineedfull.storagelab，副标题“对象存储工具箱”。

## 从界面到持久化

1. `src/components/Workbench.vue` 与连接、对象、详情、任务、设置弹窗构成唯一工作台；`src/composables/useWorkbench.js`管理异步状态，连接切换同步失效旧列表/属性/预览请求，移除连接捕获原id。任务刷新只接纳最新请求的快照或错误，dispose使未完成刷新失效。`src/styles/`集中主题和字号token。
2. `src/runtime/bridge.js`只调用固定方法，克隆Vue payload并把结构化错误转为AppError。浏览器预览不提供真实文件或网络存储能力，返回NATIVE_REQUIRED。
3. `electron/preload.cjs`只公开invoke/onChange；`electron/ipc.js`检查方法白名单、payload、受信任主窗口mainFrame URL。变更事件无业务正文，只通知刷新。renderer没有Node、任意磁盘路径或读取长期凭证接口。
4. `electron/service.js`将操作分发到S3、传输和store。生产文件选择/删除确认在原生dialog完成；测试只在独立harness注入选择/确认依赖。`electron/s3/`封装公共操作语义，`electron/providers/client.js`选择AWS S3或OSS/OBS/COS/TOS官方SDK原生适配器。四家原生传输不走AWS网络数据面，内部共用Command/响应形状。raw Key/prefix/cursor从头到尾保留；上级导航只移除一层原始斜杠分段，包括空段，不合并连续斜杠或折叠点路径。
5. `electron/transfers/`管理有界队列、流式上传下载、取消和重试；任务固定捕获配置/凭证并锁定连接，实际提交结果决定取消竞争结果。下载路径校验防越界、同名/大小写、Windows保留名及符号链接风险。
6. `electron/store.js`使用独立userData下schema3 SQLite（兼容schema1/2），将公开配置和凭证blob分开；`electron/vault.js`只接受安全safeStorage后端，拒绝Linux basic_text。不可用时用户明确选择会话模式，绝无明文落盘降级。设置和历史不与其他Tool共享。
7. `tests/*.test.js`验证领域/IPC/存储/S3/队列/路径/取消/异步界面；`tests/integration/`使用隔离回环服务；`tests/ui/`是浏览器fixture；`tests/native/`使用真实Electron与本地MinIO。发布测试在`scripts/*.test.mjs`，不接网络。

## 不变量与生命周期

最多100连接、100排队、200最近任务；对象每页200。列桶按服务返回的opaque游标聚合，最多100页/10000桶；重复或缺失游标、超限及中途失败均拒绝整次列桶，不返回伪完整列表；已知桶入口仍可用。OBS的BucketName在适配器映射为公共Name，marker与S3游标双向转换；TOS官方接口单页全量，不额外发送S3分页字段。传输并发1–4默认2，超时5–120秒默认30。四家原生GET等待响应头保持有界，收到正文后改为socket空闲超时；持续传输可超过阈值，不提前消费或缓存全文件。结束/失败解除监听，清理幂等，防止旧响应影响复用socket；用户取消与client.destroy仍贯穿正文。非GET操作保留原有请求时限。上传单文件64GiB，普通上传分片8MiB且分片并发2；显式续传每片8MiB串行，完整文件使用有界读取计算SHA-256。普通上传和显式续传之外，目录交付通过独立有界批次调度。AWS数据面通常最多3次尝试，四家原生关闭SDK自动重试；历史版本恢复客户端仅1次，避免Copy重复创建新版本。checksum WHEN_REQUIRED，TLS验证始终开启。

`src/domain/datetime.js`集中本地完整时间YYYY-MM-DD HH:mm:ss.SSS；缺失/无效--、epoch0有效，存储与协议时间不改写。ETag仅展示，不能充当MD5或内容校验。上传按保守扩展名推断MIME，仅元数据用途，非内容验证；HTML/SVG/未知类型为octet-stream。

主进程在打开数据库和执行重启恢复前取得Electron单实例锁；第二次启动退出并恢复/显示/聚焦既有窗口（启动尚未完成时保留唤醒请求）。独立测试宿主使用隔离appData，不共享真实数据。主进程sandbox/contextIsolation开启，nodeIntegration关闭，拒绝导航、新窗、权限请求。官网只允许固定https://www.ineedfull.com。退出abort并最多等待三秒，释放监听/store。重启将queued/running/cancelling标为interrupted，文件授权不持久化；显式续传任务从私有checkpoint恢复，但必须重新原生选择文件授权。

## 上传断点恢复

`electron/transfers/checkpoints.js`维护独立userData/upload-checkpoints版本1原子JSON，私有字段白名单，不含源文件路径/凭证/签名链接。`resumable-upload.js`负责句柄绑定完整SHA-256、ListParts严格比对、8MiB串行分片、完成前复核和不确定结果处理；`resume-service.js`负责原生重新授权、配置绑定、独占恢复、清理确认及历史淘汰后恢复行。公开任务只有resumable/resumeAvailable等显示字段。最多100条私有记录；当前SQLite为schema3。

Create/Complete仅一次尝试；completing状态恢复只用HEAD token/size核实。丢失Create响应且没有UploadId无法定位远端孤儿；放弃前明确只清除本机记录。配置变化/删除不向新服务发Abort，只允许明确本地放弃。POSIX使用0700目录/0600文件，Windows权限依赖用户数据目录的系统账户ACL，不能把libuv合成的Unix mode当真实ACL。详见[续传契约](resumable-upload.md)。

## 变更与迁移

对象版本模块`electron/s3/versions.js`由operations组合，service负责原生确认/只读/连接锁；`useObjectVersions.js`和`ObjectVersionsDialog.vue`提供独立窗口。版本列表每页200，双标记opaque原样传递（包括MinIO内部后缀），精确Key过滤。指定下载在queue/store公开任务JSON增加可选versionId，旧schema1记录兼容，重试保留版本；下载校验响应版本。恢复限enabled桶/不可变VersionId/≤5GiB，源条件Copy不提供目标CAS；详见[版本契约与验证](object-versions.md)。

2026-10-28管理增强不改变schema1：新增`src/domain/object-tags.js`与`useObjectTags.js`，详情按需读取/完整替换标签，generation绑定上下文，原生确认/只读/连接锁及保存前比较；HEAD再绑定VersionId，见[标签契约](object-tags.md)。`src/domain/providers.js`集中连接身份、Endpoint配置助手和能力限制，提供MinIO/通用S3、常用云厂商及四家原生SDK入口，旧连接身份兼容读取，详见[云存储接入](cloud-providers.md)与[厂商原生接入](native-providers.md)。云身份扩展到公开连接JSON，不引入新密钥表或回传长期凭证。

schema1首次建库；schema2新增私有job_files表保存本地任务文件关联；schema3增加独立directory_batches保存完整目录交付结果，已有连接、凭证、历史兼容保留，renderer仅获可用状态；后续修改须显式迁移版本，在隔离旧库上验证原子成功/失败回滚、历史和密钥可读性，不能删库代替迁移。升级保留应用ID、userData目录和safeStorage身份；备份时退出应用并连同SQLite关联文件妥善保存，密钥blob依赖原操作系统安全后端，复制数据库不等于可跨机解密。会话凭证重启必须重新填写。当前无跨机导入、自动迁移其他Tool或跨产品共享数据。

连接成功保存（包括修改端点或凭证）或移除后，原生撤销该连接终态任务的重试授权与私有上下文，公开任务历史保留。需重新选择文件/目录，以当前连接重新创建任务；保存/移除失败不会撤销仍有效的授权。活动任务继续受连接锁保护。

目录交付由`directory-plan.js`、`integrity.js`和`directory-service.js`负责有界预览、完整摘要、一次性授权和滑动窗口队列。批次结果独立于200条普通任务历史，核验失败保留物理提交状态；schema3启动恢复未完成项。原始Key/本地映射分离，清单保留创建时公开URL配置。限制、额外GET与验证边界见[目录交付](directory-delivery.md)。

## 目录交付界面状态

`DirectoryDelivery.vue`负责控件与表格绑定，`src/composables/useDirectoryDelivery.js`拥有预览、所选批次/条目、分页、动作错误与轮询。`previewDirectory`取得一次性授权，`startTransfer`消费授权；取消与导出通过`runTransferAction`统一busy/异常收尾。`refreshBatches`只接纳最新修订的快照或错误；失败保留已有结果。

窗口关闭清理轮询、使迟到刷新失效并撤销未消费预览；原生服务继续拥有传输批次，关闭窗口不取消传输。详情中的传输状态与核验结论分别显示，不能把已提交、跳过或仅有ETag当作内容一致。相关浏览器回归在`tests/ui/directory-delivery.spec.js`，原生/隔离流测试在`tests/directory-delivery.test.js`。本轮审查与平台边界见[可读性记录](reviews/2026-11-02-readability.md)。
