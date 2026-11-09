# StorageLab 全仓代码审查（2026-10-30）

审查对象为 `codex/storagelab-initial`、HEAD `1758a5cb327ccf94b3dfa55d5097b63d5bad1ff3` 及本地最新页面导航改动。覆盖 `electron/`、`src/`、`scripts/` 的业务实现、平台桥、领域规则、界面与发布链路，并对照相关测试和产品契约。本报告主体保留审查时的结果与复现证据；后续修复与本轮验证见[修复记录](2026-10-30-review-fixes.md)。MQTT、LinkLab、NetTool 不在本轮范围。

开始时已有四个修改：`src/components/Workbench.vue`、`src/components/TaskCenter.vue`、`src/styles/workbench.css`、`docs/ui.md`。审查过程中未改这些文件或其它产品源码。

## 已确认问题

共 5 项：2 项 P1、3 项 P2。P1 建议在下一次发布前优先修复；没有发现经过证实的 P0 问题。

| 编号 | 优先级 | 问题 | 主要定位 |
| --- | --- | --- | --- |
| SL-1 | P1 | 重复启动共享数据库，会破坏运行任务保护 | `electron/main.js:19`、`electron/store.js:46` |
| SL-2 | P1 | 原生厂商下载按总耗时超时，正常长传输被中断 | `electron/providers/oss.js:268`、`obs.js:346`、`cos.js:435`、`tos.js:361` |
| SL-3 | P2 | 任务列表刷新没有顺序保护，旧响应覆盖新状态 | `src/composables/useWorkbench.js:75` |
| SL-4 | P2 | 桶列表只取一页，后续桶静默缺失 | `electron/s3/operations.js:70` |
| SL-5 | P2 | 原始前缀包含空路径段时，“上级”原地刷新 | `src/components/ObjectBrowser.vue:58` |

### SL-1：重复启动会将另一个进程的活动任务当成重启遗留任务

主程序固定使用同一个 userData，初始化 store 前没有取得 `app.requestSingleInstanceLock()`，store 也没有进程所有权保护。每个新 store 都无条件把数据库里的 queued/running/cancelling 标为 interrupted，而连接锁只存在于各自进程内存。

**触发与影响：**从命令行再次启动应用，或在允许重复启动的平台打开第二个实例。第二进程把第一进程仍在执行的任务改成 interrupted，因而允许编辑或删除该连接；第一进程仍持有旧凭证、配置与 runner 并继续运行。两边界面与数据库状态发生分歧，第一进程写入后的记录还可能引用已经删除的连接。两个进程还会共享续传记录文件。

**隔离复现：**使用实际 createStore/createQueue 和临时目录，在父进程保留 running 任务及连接锁；父进程删除连接正确返回 CONNECTION_BUSY。随后子进程打开相同临时数据库，读到 interrupted 并成功删除连接，而父进程队列仍是 running。没有打开第二个真实用户实例。

**建议：**在初始化数据库、凭证和恢复任务前取得应用单实例锁；第二次启动应唤起既有窗口并退出。若今后允许多实例，需改为独立工作区或真正的进程间所有权与恢复协议，不能仅依赖内存锁。补充两个进程竞争启动与正常退出后重启的回归。

### SL-2：正常下载超过 timeoutSeconds 就会失败

四家原生适配器在 send 开始时创建固定 deadline，收到 GET 响应后仍保留这个定时器，直到正文 end/close/error 才清理。到期会直接 destroy 正文和连接；持续收到数据不会延长期限。默认 30 秒，设置最多 120 秒，因此正常大文件下载也会被当成网络故障，重试仍然在相同时间失败。

**隔离复现：**回环 HTTP 服务每 100ms 发送 1KiB，64KiB 正文约 6.5 秒完成；使用设置允许的最小超时 5 秒，通过实际 downloadObject 和官方 SDK 执行。COS/OBS 仅注入 DNS/transport 将测试域名定向回环，协议映射与签名仍用实际适配器。

| 数据面 | 结果 | 实际耗时 | 收到进度次数 | 失败距末次进度 |
| --- | --- | --- | --- | --- |
| 通用 S3 | 成功 | 6506ms | 64 | — |
| OSS 原生 | TimeoutError | 5010ms | 49 | 25ms |
| TOS 原生 | TimeoutError | 5015ms | 49 | 30ms |
| COS 原生 | TimeoutError | 5013ms | 49 | 28ms |
| OBS 原生 | TimeoutError | 5020ms | 49 | 37ms |

5 秒只是缩短复现时间；相同固定定时器也用于默认 30 秒和最大 120 秒。这与单文件支持至 64GiB 的流式下载存在实际冲突。在约 10MiB/s 的网络中，默认配置下数百 MiB 文件就可能失败。下载失败清理临时文件，没有把半成品错误标成成功。

**建议：**区分建立连接/等待响应头、传输空闲超时和整体任务取消。正文持续传输时使用空闲检测，完整保留取消、停滞断开、错误和资源清理；核对底层 SDK 自身的 timeout 配置，避免只清除外层 deadline。增加四家长于阈值但持续进展的下载，以及真正停滞和取消的对照回归。无需用全文件缓冲解决。

### SL-3：旧任务快照可能把成功改回运行中

refreshJobs 每次直接将 `await action("listJobs")` 赋给 jobs，没有请求序号、串行化或合并保护。原生进度通知、用户刷新、添加/取消/删除任务后都会触发它。listJobs 内部读取 checkpoint 并异步核对每个本地文件，两个请求有可能倒序完成。

**隔离复现：**调用两次真实 createWorkbench.refreshJobs，先让后发请求返回 success/100B，再让先发请求返回 running/1B；最终界面模型倒退为 running/1B。删除后的旧快照也可能把记录短暂显示回来；最后一次通知已经消费时，需要用户手动刷新才能恢复。此问题没有改变原生传输结果。

**建议：**采用递增刷新序号丢弃旧响应，或串行合并通知并确保最终补刷。dispose 时失效仍在等待的刷新；错误提示也应遵守同一顺序。回归至少覆盖成功、取消、删除和窗口释放。

### SL-4：桶分页游标在公共操作层被丢弃

listBuckets 只调用一次 ListBucketsCommand，并仅返回 buckets。OSS 原生适配器已经将 NextMarker 映射为 ContinuationToken，但公共操作层既不继续取页，也不将截断状态/游标交给界面。

**触发与影响：**账号的桶数量超过服务端单页上限时，侧栏静默缺少后续桶；刷新仍只显示第一页，用户容易误认为桶不存在或权限缺失。手输已知桶仍可作为绕行方式。

**隔离复现：**实际 OSS 适配器注入两页 SDK 响应，第一页包含一个桶和 NextMarker，第二页包含另一个桶。经真实 createS3Operations.listBuckets 调用后只发起一次请求，返回值没有后续游标或截断提示。

**建议：**统一厂商的桶分页结果，按需提供“加载更多”，或在总数/页数受控、重复游标检测的前提下聚合。不能通过一次性递归盘点对象解决；保留列桶失败时打开已知桶的功能。增加第二页、重复游标、部分失败及连接切换回归。

### SL-5：前导或连续斜杠目录无法返回上级

“上级”使用 `/[^/]+\/$/` 删除末段，这要求斜杠前至少存在一个非斜杠字符。当真实 S3 前缀是 `/`、`data//` 等合法原始前缀时，替换结果等于输入，按钮只是再次读取同一目录。

**隔离复现：**浏览器加载真实 Vue 工作台并注入回环性质的静态目录 fixture；分别通过目录按钮进入 `/` 和 `data//`，点击“上级”，实际 listObjects 请求仍是 `/` 和 `data//`。这不仅是正则表达式推演，已验证实际页面事件链。

**建议：**按原始分隔符位置退一层，包含空路径段；`/` 应退到空前缀，`data//` 应退到 `data/`。不能 normalize、合并连续斜杠或改写 dot segments，因为这些代表不同对象。补充普通、多重斜杠、前导斜杠及 dot-segment 前缀的导航回归。

## 验证与证据

本轮新执行：

- 产品目录 `npm test`：219 项，218 通过、1 项既有跳过、0 失败。
- 产品目录 `npm run build`：通过。
- 隔离双进程 store/queue、任务倒序刷新复现：通过确认 SL-1、SL-3。
- 回环五数据面对照下载：通用 S3 成功，四家原生按固定期限失败，确认 SL-2。
- 原生 OSS 适配器分页响应复现：确认 SL-4。
- 实际 Vue 页面目录点击与“上级”复现：确认 SL-5；Chrome 浏览器 fixture，不记作 Electron 安装包验收。
- 62 个已快照源码/脚本文件的 SHA-256 在审查前后保持一致；本轮只新增报告与工作区交接资料。

证据保存在工具工作区 `scratch/2026-10-30-storagelab-review/`：`source-before.json`、`source-after.json`、`node-tests.log`、`build.log`、`reproduce.mjs/.log`、`slow-download.mjs/.log`、`bucket-pagination.mjs/.log`、`navigation-ui.mjs/.log`。复现断言专门确认当前缺陷，不能解释成这些边界已通过产品验收。临时数据库、下载文件和本轮回环进程已清理，复现脚本与日志保留。

前轮 201 项浏览器、13 项原生及长跑结果仍见对应验收文档，本轮没有把它们冒充新执行的检查。此次未重新运行长跑、云账号验收或跨平台安装，也未打包/上传。

## 依赖与维护补充

官方 npm registry 的 `npm audit --omit=dev --registry=https://registry.npmjs.org --json` 返回 7 个包节点告警（5 high、2 moderate），不是 7 个已证实的产品漏洞；保存于 `npm-audit-official.json`。默认 npmmirror 不支持 audit 接口，已换官方 registry 完成查询。

告警涉及 Vue 带入的 server-renderer、TOS 带入的旧 Axios/uniapp adapter，以及 OBS 带入的 fast-xml-parser。当前产品使用 Vue DOM 渲染，没有 SSR；TOS 使用自定义 Node 请求 adapter，不能把默认浏览器/HTTP adapter 的所有告警直接归因到当前调用链；OBS 告警针对 XMLBuilder，当前适配依赖的响应解析并非同一入口。本轮未证明这些通告在产品中的可利用链。应独立安排兼容升级与可达性核查，不能直接执行 audit fix 的 SDK 降级建议。

维护文档也有漂移：README 已说明 schema2 和四家原生 SDK，而 `docs/architecture.md` 仍多处写当前 SQLite 是 schema1、全厂商共用 AWS 数据面。首版历史契约可以保留，但当前维护入口应更新，避免后续开发按旧结构理解任务文件关联和原生适配层。这不计入上面 5 项功能缺陷。

## 修复顺序

先处理 SL-1、SL-2，随后处理 SL-3、SL-4、SL-5。各项修复先补失败回归，再运行相邻原生/界面验证；最终运行基础测试、构建及必要集成检查。发布前应明确产品代码提交与新安装包来源，当前本地导航样式尚未包含在已经发布的安装包内。
