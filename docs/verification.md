# 首版验证与范围

最新发布收尾见[2026-10-30发布说明](releases/2026-10-30.md)：Node218通过/1既有跳过、浏览器201、Electron13，新旧MinIO各6通过；最终五包完整性/资源及公网下载通过。真实macOS arm64安装副本、Linux Xvfb和Windows Wine验收分别记录，不能替代未执行的目标平台验收。

最新整体功能与压力回归见[2026-10-29验证报告](functional-verification-2026-10-29.md)：基础217通过/1既有跳过、完整浏览器197、真实MinIO6、Electron完整11＋队列边界专项1通过；正式20分钟四并发负载＋3分钟静置完成39220次成功传输、242次续传恢复、97次故障重试，摘要与数据库检查通过，内存有回收。真实云账号与其他平台边界见报告。

最新完整功能回归见[2026-10-28 整体功能验证](functional-verification-2026-10-28.md)：基础144通过/1既有跳过、浏览器167、真实MinIO6＋STS/已知桶专项1、最终Electron原生10通过；包含近期任务文件、下载位置与全部窗口整理。以下记录保留各历史阶段含义。

2026-10-28对象管理与续传最终验收见[本轮记录](object-management-verification.md)；增量功能与此前回归另见[对象标签](object-tags.md)、[云存储接入](cloud-providers.md)和[对象版本与恢复](object-versions.md)。版本功能完成后的整体验证为Node100通过/1原条件跳过、真实MinIO4、浏览器60及Electron原生4通过；以下首版历史与旧安装包证据保持原阶段含义。

日期2026-10-27，版本1.0.0。所有服务测试用隔离本地回环MinIO、独立SQLite/临时目录；未使用146生产MinIO或生产桶进行服务测试。以下首版阶段记录保留当时的锁屏及测试限制；后续解锁后的真实包钥匙串、同版重装与其他平台结果见[发布前验收](release-acceptance.md)。系统picker人工验收仍需单独记录。

## 功能和提供商证据

| 范围                                              | 实际证据                                                                                               | 边界                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 基础领域、IPC、SQLite/vault、时间、安全路径、队列 | npm test，任务1/2/3报告；任务4最终60通过/1仅Tauri原条件跳过                                            | 跳过不算Tauri实现                                |
| 本地MinIO                                         | Task2真实对象/分页/特殊Key/分片/预览/签名/传输/取消/重启隔离集成；Task3原生完整流程                    | 回环服务不等于全部厂商认证                       |
| 临时凭证                                          | Task2实际MinIO STS会话令牌集成                                                                         | 临时令牌会过期；未验证云厂商STS                  |
| 403列桶/指定桶                                    | 原生真实MinIO对象请求+测试专用ListBuckets403代理；手填已知桶成功                                       | 403来源明确为故障注入，不称服务端真实授权策略403 |
| 删除部分错误、断网、能力缺失、安全路径            | Node定向/SDK故障测试及浏览器fixture                                                                    | 部分异常并非提供商原生返回                       |
| 通用S3                                            | AWS SDK V4与region/path-style/sessionToken配置                                                         | 未对AWS S3/阿里OSS/腾讯COS/华为OBS等逐家实机验收 |
| 安全凭证                                          | Task3真实safeStorage加密/重开/私下字节比对、数据库无明文/public snapshot无密钥；无安全后端明确会话模式 | 不跨机迁移密钥，不支持明文降级                   |

Task3最终原生2项（真实生产启动/主流程）通过；包括自上传sample.txt预览、下载字节对比、签名GET200、受控删除、96MiB实时上传取消、设置持久化/About。文件选择/确认由原生测试harness注入，不是系统对话框人工操作。Task3浏览器完整23项及后续连接上下文4项回归通过。真实原生16显示组合：浅/深×普通/大字×展开/折叠×1440×900/920×620；窄窗对象表头及两整行可见，system、长表单滚动和键盘焦点另测。Task4仅替换品牌图像和配置，不重复未修改的昂贵全流程。

## 本轮命令与产物

Host Node26.10.0/npm11.19.1，Electron43.1.0；实际嵌入Node与打包启动记录见本地`artifacts/task-4/packaged-result.json`。`npm test`61项：60通过/1跳过；`npm run test:release`19项：18通过/1仅Tauri条件跳过。发布上传测试为模拟客户端，断言篡改/错误目录在网络调用前拒绝；没有上传。三平台release:plan输出electron-only四个构建job/五个安装产物，无构建或远端接触。

`npm run package:mac:dir`成功，Electron-builder26.0.12、arm64、StorageLab.app、独立appID/name/icon。签名明确null、未正式签名。打包依赖可加载/实际生产main启动由下述smoke证明。首轮构建捕获Vue相对静态img导入解析失败，改用绑定相对public URL后通过；保留原始日志于Task4报告。发布工具链产生DEP0190警告，不当成应用错误或“零警告”。

品牌标准256与小尺寸32实际PNG目视检查：系列渐变、白色i+存储立方体清晰；既有165源/导出哈希全部不变。安装图标来自专用源与provenance；无其他产品整体重生成。

打包启动自动化与最终格式/界面风险检查结果追加于本文件末尾。详细命令/失败/修复/提交记录位于控制器工作区Task4报告。未建立正式分发包集合、DMG安装、升级、macOSx64/Windows/Linux运行或正式签名结论。

## 新工具清单逐项映射

| 清单项目                            | 证据/决定                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1目标、输入/输出、离线与首个工作流  | user-guide连接→桶→对象→传输/分享/删除；离线配置/历史，远端操作需网络；首屏可操作                                  |
| 1原生/平台/目标/规模/失败取消       | spec、architecture、user-guide；回环S3、100/100/200、Electron首版；浏览器仅外观                                   |
| 1身份/目录/键/图标                  | package、release-product、main独立com.ineedfull.storagelab；provenance/storagelab源                               |
| 1技术与版本/格式                    | Vue3/Vite/Electron43.1.0、Node>=22.16、npm锁；无Rust/Tauri；desktop-packaging五产物                               |
| 2可复现工程/分层/接口/可读性        | package命令、architecture完整调用链、spec桥表与错误/取消语义                                                      |
| 2IPC/来源/退出/上限                 | ipc/vault/store/queue测试，main安全窗口及有界退出，Task1/2报告                                                    |
| 2版本/迁移/备份/回滚/隔离           | schema1、架构迁移说明、store原子回滚/重开/会话清理测试；无跨机导入功能                                            |
| 2品牌                               | current专用标准/小图、generate:icons、build provenance；本机.app身份                                              |
| 3主题/字号/设置恢复/日期            | styles/domain/datetime + Task3真实16矩阵/system/设置失败回滚，epoch0/无效/旧记录测试                              |
| 3侧栏/任务/设置/关于/状态/键盘/窄窗 | Task3生产UI原生与浏览器证据；Task4品牌窄窗定向检查                                                                |
| 3浏览器诚实边界                     | native:false/NATIVE_REQUIRED；测试fixture不进入生产                                                               |
| 4真实测试/构建/取消/重启            | Node、集成、Task3原生/Task4打包；无lint配置，使用Prettier适用文件检查                                             |
| 4UI矩阵/运行时                      | Electron共享单工作台；真实16矩阵，只有Electron，Tauri不适用                                                       |
| 4发布配置/脚本/测试                 | desktop-packaging、原样共享脚本/描述、三平台只读计划/安全测试                                                     |
| 4打包启动/目标系统                  | 本机arm64.app自动化；DMG安装/升级与其他平台显式待验，未笼统声称跨平台已验收                                       |
| 4下载/图片存储                      | 本轮不提供公开下载；仅配置未来独立私有前缀，上传/公开需另授权                                                     |
| 4文档/工作区登记                    | README/spec/architecture/user-guide/verification/desktop-packaging；工作区repositories/索引/任务/状态由控制器更新 |

## 首版阶段 Packaged production smoke (2026-10-27)

本节保留首版Task4当时的证据和未验收项；后续实际补验以[发布前验收](release-acceptance.md)为准。

Actual `release/mac-arm64/StorageLab.app`: plist StorageLab/com.ineedfull.storagelab; Mach-O arm64; Electron43.1.0, Node24.18.0, SQLite3.53.1. The local ignored harness `artifacts/task-4/packaged-smoke.mjs` launches this executable with a Node inspector startup breakpoint and sets appData to mkdtemp BEFORE production main runs. No asar modification or production test hook. Run with `STORAGELAB_TEST_CONFIG=<private loopback config> node artifacts/task-4/packaged-smoke.mjs`; credentials are never logged.

The first launch without test keychain flags stalled in Security::KeychainCore::ItemImpl::getContent → SecurityServer::ClientSession::decrypt → mach_msg. CDP had no body and screenshots timed out. A native process sample confirms a locked-session keychain wait; this is retained as a failed attempt. Only owned processes and test data/buckets were cleaned up. A second run explicitly used `--use-mock-keychain` with session credentials: app.isPackaged=true, actual app.asar, bootstrap/name/version/isolated userData, final 32px icon loading, real local MinIO object listing, persisted dark/large/collapsed settings after reload, and production UI bucket browsing all passed. `artifacts/task-4/packaged-result.json` has secret-free assertions; `packaged-native.png` was visually inspected. Unlocked packaged OS keychain access remains UNVERIFIED; mock-keychain is not real safeStorage evidence. Task3 actual safeStorage evidence remains separate.

Shared release scripts/tests (four files) are byte-identical to NetTool. Dedicated brand commit `70952fe`, branch codex/storagelab-icon. All165 pre-existing source/export hashes unchanged. No full unchanged native matrix rerun; final narrow browser branding risk check/build and detailed evidence are in Task4 report. No DMG installation, upgrade, signing, other-platform execution, upload or publication is claimed.

Final reproducibility gate: Chrome screenshot rendering initially produced changing PNG hashes at some sizes, so the final generator uses pinned @resvg/resvg-js2.6.2 CPU rendering with system fonts disabled. Export followed by a second ordinary generation produced byte-identical provenance (cmp passed); all11 brand source/export and5 product artifact hashes verified. Final brand follow-up commit7707cf9 contains only StorageLab exports/manifest provenance/README. Product .app was rebuilt with these final deterministic icons, then the short instrumented packaged smoke passed again; final logs/result/screenshot and original keychain stack are durable under artifacts/task-4/. Targeted browser `npx playwright test --grep "geometry dark true false 920"`:1passed; final icon fits dark/large/expanded920 layout and was visually checked. Original wrong hyphenated grep selected no tests and is not counted as a pass.

## OSS / OBS 原生接入（2026-10-28）

完整Node175通过/1既有Tauri跳过、浏览器188、真实MinIO6、Electron11及修复后的原生SDK专项1通过。OSS13与OBS11含实际SDK回环协议、上传协调器、分页/版本/续传及异常Key/XML目标保护。独立复核通过；接入方法、限制和真实云账号/安装包/其他平台边界见[native-providers.md](native-providers.md)。不自动改已有连接，旧aliyun须明确迁移并保存。
