# StorageLab 首版契约

用户已批准 MinIO＋通用 S3 的首版完整工作流及名称 StorageLab。本文件落实已批准方向，不新增提供商或后台管理范围。

## 产品和架构

- 显示名称 StorageLab；副标题“对象存储工具箱”；包/仓库 `ineed-storagelab`，应用 ID `com.ineedfull.storagelab`。
- 首版 Vue 3 + Vite + Electron，Node >=22.16，npm 锁文件；Node host 与 Electron 实际版本写入验收。Electron 单端便于复用 AWS JS SDK 与安全原生流；未来适配器不要求第二套 UI。
- `src/domain/` 纯领域/格式化，`src/runtime/` 浏览器/桌面桥，`src/components/` Vue 工作台，`electron/` IPC/存储/S3/任务。每文件聚焦一个职责，README 提供完整调用链。
- macOS arm64 原生开发宿主为本机验收目标；配置 macOS arm64/x64 DMG、Windows x64 NSIS、Linux x64 DEB/AppImage，配置不代表目标系统验收。首版不自动更新、不自动上传或发布。
- 独立 userData/SQLite schema1；测试用隔离数据。最多100连接、100排队任务、200条最近任务；列表单页200对象。启动不递归盘点远端。

## 共用数据和桥

连接公开形状：`{id,name,group,provider:'minio'|'s3',endpoint,region,forcePathStyle,defaultBucket,readOnly,publicBaseUrl,hasCredentials,credentialStorage:'encrypted'|'session'}`；长久密钥不回传 renderer。
保存 payload：`{connection,credentials?:{accessKeyId,secretAccessKey,sessionToken},credentialStorage}`。新建必需 credentials，编辑省略则保留；`id`由原生生成/验证。更换凭证须完整提交。Endpoint 限 http/https，不含 userinfo/query/hash；region 默认 us-east-1；MinIO 默认 path style。publicBaseUrl 可空，单独校验。
设置：`{theme:'system'|'light'|'dark',largeText:false,sidebarCollapsed:false,concurrency:2,timeoutSeconds:30}`；并发1–4、超时5–120秒。
任务公开形状：`{id,connectionId,connectionName,bucket,key,direction:'upload'|'download',state,bytesTransferred,totalBytes,rate,createdAt,updatedAt,error?,warning?}`；不导出凭证、签名链接或任意原始错误堆栈。

桥：`window.storageLab.invoke(method,payload={}) -> Promise<{ok:true,value}|{ok:false,error:{code,message}}>`；`onChange(callback)->dispose`，事件只触发重取任务/公开状态，节流避免每字节跨IPC。

| method | payload | value |
| --- | --- | --- |
| bootstrap | {} | {connections,settings,jobs,app:{name,version,runtime,dataDirectory,native:true,vaultAvailable}} |
| saveConnection | 上述保存形状 | connection |
| removeConnection | {id} | true |
| checkConnection | {connectionId,bucket?} | {scope,status,message}；bucket 优先只读列表检查，否则列桶 |
| listBuckets | {connectionId} | {buckets:[{name,creationDate?}]} |
| listObjects | {connectionId,bucket,prefix:'',cursor?} | {objects:[{key,size,lastModified,etag?,storageClass?}],prefixes:[string],nextCursor?} |
| headObject | {connectionId,bucket,key} | {key,size,lastModified,contentType,etag,metadata,versionId?,checksum?} |
| previewObject | {connectionId,bucket,key} | {kind:'text'|'image',content,contentType}；image content 为 dataURL |
| shareObject | {connectionId,bucket,key,expiresIn:900,kind:'signed'|'public'} | {url,expiresAt?,warning} |
| deleteObjects | {connectionId,bucket,keys} | {deleted:[string],errors:[{key,code,message}],versioning:'enabled'|'suspended'|'unknown'|'disabled',cancelled?:true} |
| uploadFiles | {connectionId,bucket,prefix:'',overwrite:false} | {jobs:[job],cancelled?:true} |
| downloadFiles | {connectionId,bucket,keys,overwrite:false} | {jobs:[job],cancelled?:true} |
| listJobs | {} | jobs[] |
| cancelJob / retryJob | {id} | job |
| exportJobs | {} | {cancelled?:true,path?:string} |
| saveSettings | settings | settings |
| copyText | {text} | true |
| openWebsite | {} | true |

原生对方法、sender 的受信任 mainFrame URL、payload、长度和数量二次校验。sandbox/contextIsolation 开启、nodeIntegration 关闭；禁止任意导航/新窗。openWebsite 只允许固定 https://www.ineedfull.com（StorageLab独立站尚未创建），失败可见。允许在 test harness 通过服务依赖注入文件选择/确认；生产不接受 renderer 提交任意磁盘路径。浏览器 native:false，仅外观预览，真实存储操作 NATIVE_REQUIRED，测试 fixture 不进入生产。

## 凭证与持久化

Electron safeStorage 只在操作系统安全后端可用时保存加密 blob；Linux basic_text 拒绝。不可用时表单明确选择会话模式；不允许悄悄降级。公开连接字段与密钥分开存储，更新/删除原子回滚；序列化/导出不包含有效签名 query、密钥、原始 headers。session 凭证不落盘，重启显示需要重填。正在执行/排队关联任务时禁止编辑/删除连接，任务捕获稳定配置与凭证上下文。SQLite失败要明确报告；远端已完成但历史保存失败保持远端真实结果并附持久化警告。
重启恢复历史：running/queued/cancelling 一律 interrupted，不保留文件授权；提示重新选择文件，不能假称续传。

## S3 与对象浏览

AWS SDK v3，签名V4、可选sessionToken、区域/寻址设置。重试最多3次；超时有界；checksum WHEN_REQUIRED 兼容旧服务。不关闭 TLS 校验。
ListBuckets 被拒时仍允许手输已知桶并用 ListObjectsV2 访问。delimiter `/`，MaxKeys200，保留原始 prefix/key/cursor。前缀导航、返回上级、刷新及下一页；筛选/排序标注仅当前页。对象 key 不是本地路径，绝不替换反斜杠或规范化 dot segments。无权限/不支持/未知/暂时网络故障分开反馈。
属性只读。预览先 HEAD 并限制流实际读取：文本/JSON最多2MiB，png/jpeg/gif/webp最多8MiB；不渲染 HTML/SVG。metadata 不执行、不注入HTML。预览切换行丢弃旧响应。ETag只展示，不宣称MD5或完成内容校验。
预签名 GET 默认900秒、允许60–604800秒，说明临时凭证可能提前失效及“生成未代表可访问”。独立公开 base URL 按完整 raw key 编码；无法安全表示 dot segments 时拒绝，不能签名后替换主机名。URL只在当前弹窗中持有。

## 传输、取消和删除

多文件 picker 上传，下载选中对象到 picker 所选目录；不递归处理文件夹。单文件上限64GiB；上传 AWS Upload 分片8MiB、分片并发2、失败清理本任务 multipart；整体并发来自设置，队列有界。流式下载，不全量缓冲。
默认拒绝覆盖，提供明确覆盖选项。上传存在检查与服务能力/条件写入保护避免静默覆盖；不能满足强不覆盖时明确能力限制，禁止谎称原子保护。下载 key 映射必须防越界、Windows保留名/非法字符、大小写冲突、同名冲突、符号链接越界；可拒绝不可安全表示的key。下载临时文件和原子/排他完成，失败/取消清理半成品，只有流和落盘完成才success。明确校验范围，ETag/大小不是内容证明。
任务状态 queued→running→success/failed，cancel queued→cancelled、running→cancelling→cancelled，取消/完成竞争按实际提交结果。进度真实字节和速率，切页继续。重试限本会话仍有效文件授权的failed/cancelled；重启interrupted需重新选择。退出abort并有界等待清理，注销监听器。
删除最多200已选对象，原生确认明确桶/数量/keys及版本语义；只读在原生阻断。GetBucketVersioning 权限/能力不足标unknown；当前对象删除可能生成标记，不称永久删除。DeleteObjects HTTP200的逐项 Errors 必须呈现。取消确认不发删除。

## UI

左侧连接/分组与桶、主区稳定列宽对象表格/面包屑/当前页筛选排序，右侧可收起属性预览，任务中心可独立页签用于窄窗。空态/加载/错误/反馈可见，长key完整可查看复制。连接编辑字段整齐，所有操作有中文文字或lucide图标和可访问名称。
单token文件：侧栏240/58、顶栏48、普通控件>=32、表格行>=40。浅深按系列色；普通/大字语义字号参考工作区 TOOL-UI.md。主题system/light/dark、设置草稿预览、取消/失败还原；设置/关于不重置工作台。折叠设置持久化。
本地日期显示统一 YYYY-MM-DD HH:mm:ss.SSS，无效/缺失--、epoch0有效；存储仍ISO/epoch。弹窗Escape/滚动/焦点返回/焦点约束，键盘可操作，错误持续到处理。关于显示真实版本/运行时/独立数据目录/官网，注明Electron资源使用与浏览器预览边界。
实际桌面初始1440×900、最小920×620；验收16组合（浅深×普通大字×展开折叠×1440×900/920×620）及system、设置、关于、详情、长表单滚动和完整主流程。

## 品牌、验证和交付

current 图标源新增 storagelab 标准/小尺寸 SVG，系列渐变和白色i＋存储对象符号；只增本产品资源/索引，不重生成其他产品图标。安装png/ico/icns从该源产生，记录命令。macOS开发宿主有独立品牌名/图标，不修改node_modules Electron.app。
验证必须有真实本地MinIO或明确区分的S3兼容服务集成、分片/特殊key/分页/403指定桶、断线/取消/安全路径/部分删除错误/凭证和重启恢复测试。无真实服务能力的项目记录边界；不使用146生产测试。
交付：产品README/架构/用户指南/验收记录、标准release脚本及测试、工作区登记和任务记录。所有构建/平台/签名结论有命令证据，不声称所有S3厂商已验收。后续功能：桶管理/版本管理/重命名/同步/重启续传/额外厂商/Tauri均不在首版。
