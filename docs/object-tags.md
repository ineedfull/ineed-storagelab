# 对象标签：阶段 B 首批管理增强

日期：2026-10-28。基于首版 `98a5204`，不改变 schema1、应用身份或凭证模式。

## 行为契约

详情面板独立“对象标签”按需读取，不随启动/列桶/分页扫描。读取、编辑、撤销、重新读取、完整替换保存和清空；只读连接可查看，主进程阻断写入。错误持续显示；读取失败不显示为空标签。切换对象/桶/路径/连接丢弃草稿并使旧异步结果失效。

`getObjectTags({connectionId,bucket,key,versionId?}) → {tags:[{key,value}],versionId?}`。
未传版本时先 HEAD 解析版本，再 GetObjectTagging 指定该版本，兼容 MinIO 标签响应未带版本头的情况。

`saveObjectTags({connectionId,bucket,key,versionId?,originalTags,tags}) → {saved:true,tags,versionId?} | {cancelled:true}`。
固定捕获配置/凭证、锁住连接直到完成；原生确认显示目标和完整替换语义。确认后重新读取，整组比较忽略顺序，变化拒绝 `CONFLICT`；非空 PutObjectTagging，空组 DeleteObjectTagging。权限错误不发送写入，不记录标签或密钥到历史。

原生/UI共用校验：最多10项；Key唯一且1–128、Value 0–256 UTF-16单元；保留原始大小写/首尾空格，限制S3字符范围和保留前缀。服务器 `InvalidTag` / `InvalidTagError` / `TooManyTags` 映射为已清洗的 `INVALID_TAGS`，不回传原SDK错误。

S3标签API没有原子条件替换；检查后仍可能有并发修改。真正版本ID用于指定历史版本，字面量`null`可变，无版本时操作当前对象。网络错误可能发生在服务已写入后，先重新读取核实；不宣称失败一定没有写入。HEAD/GetObject权限是安全绑定版本的前提，不能只授予GetObjectTagging。Version API相应权限也需单独授予。

## 实现阅读入口

- `src/domain/object-tags.js`：校验及一一对应的整组比较（含重复草稿）。
- `src/composables/useObjectTags.js`：草稿与请求代次，集成到`useWorkbench.js`。
- `src/components/ObjectTags.vue`：详情中的独立编辑区；语义主题变量及窄窗口换行。
- `electron/ipc.js` / `service.js`：公开白名单、参数、只读、确认、连接锁及保存前检查。
- `electron/s3/operations.js`：HEAD版本绑定、标签读/替换/清空。

## 本轮证据与限制

- 开发按测试先行：接口/原生只读/确认取消/标签冲突/切换对象测试先失败，再实现通过；复核发现重复草稿比较问题，新增失败回归并修复，复审通过。
- `node --test tests/object-tags.test.js`：8通过。
- `STORAGELAB_TEST_CONFIG=<私有回环配置> npm run test:integration`：2通过，含真实MinIO标签CRUD、原始中文/特殊Key、正文/Metadata不变、冲突拒绝、历史版本标签与最新版本隔离，及原有完整传输回归。
- 本地MinIO RELEASE.2025-09-07T16-13-09Z 拒绝中文标签键和值，ASCII标签/首尾空格/空值通过；不是所有服务对Unicode标签的结论。
- `npm run test:ui`：25通过，含浏览器标签流程、权限错误区别空态及既有16显示组合。
- `STORAGELAB_TEST_CONFIG=<私有回环配置> npm run test:native -- --grep 'production UI'`：真实macOS arm64 Electron生产UI/IPC/S3流程通过，服务端独立读回标签；标签区16显示组合截图/几何检查通过，浅深及920大字截图人工检查。原生文件/确认对话框由隔离harness注入，不是人工系统对话框验收。
- 原生首轮暴露旧测试等待瞬时列桶错误；成功打开已知桶会清理该错误，改为等待实际对象。测试harness的动态import从Playwright evaluate移到原模块作用域，避免VM导入限制。
- Windows/Linux、安装包标签流程、其他云账号尚未联调；未发布。历史发布验收文档和安装包仍对应本功能前的源版本。

后续同轮提供商集成后的完整回归为Node87通过/1原条件跳过、真实MinIO集成2通过、浏览器42通过、Electron原生3通过；最后R2修复另补跑提供商UI17及原生1通过。整体验证和云能力差异见[云存储接入](cloud-providers.md#本轮验证结果)。
