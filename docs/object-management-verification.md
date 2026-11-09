# 对象管理与续传验收（2026-10-28）

## 范围与独立复核

同桶复制、受控重命名、元数据编辑、显式上传重启恢复。设计和执行清单在docs/superpowers内。基础功能归档ed935a6；对象管理ab00e9e；续传f03ea5d。原源码目录实施，未改其他产品，未访问146生产桶或自动发布。

对象管理复核修复AWS身份与自定义端点能力误判、WebsiteRedirectLocation复制遗漏；续传复核修复批量文件准备提前释放连接锁、Windows合成Unix权限误判、配置删除后无法放弃本机记录。每项补失败回归再修复，独立复审无剩余阻断发现。

## 最终功能回归

- `npm test`：128总计，127通过，1既有Tauri条件跳过，0失败。
- `STORAGELAB_TEST_CONFIG=<私有回环配置> npm run test:integration`：6/6通过。包含真实MinIO跨service/store重启，保留part1、不重复发送、重新授权同内容新路径，最终独立GET正文SHA-256一致。
- `npm run test:ui`：96/96通过；复核修复后续传完整19/19（含新增localOnly显示断言）通过，其他界面不变。浅/深、普通/大字、展开/折叠、1440/920共16显示组合覆盖；浅色1440、深色大字折叠920截图人工检查并保存。
- `STORAGELAB_TEST_CONFIG=<私有回环配置> npm run test:native`：6/6通过，含真实生产main、对象管理、云连接表单、续传、版本恢复及完整传输/预览/标签/分享/取消/16显示组合流程。文件选择和确认经独立测试宿主注入，并非人工系统对话框验收。
- `npm run build`、变更代码Prettier检查与`git diff --check`通过；无额外依赖或SQLite schema变更。

原生第一次完整回归在分享链接处失败：新增测试client包装缺少签名所需middlewareStack。已修正测试包装，完整六项重跑通过；未改产品签名功能。保留失败与重跑日志。

## 压力环境与预检

本机磁盘余量低导致MinIO按容量保护拒绝写入，使用自有1GiB稀疏APFS测试卷隔离。短跑曾因MinIO延迟清理trash占满而失败；保留证据，配置测试服务delete_cleanup_interval为1秒。服务初次清理计时仍约5分钟；观察空间真实回收后再正式运行，不把磁盘满失败隐藏为产品通过。

15秒预检12轮、1次中断恢复通过。正式执行`STORAGELAB_TEST_CONFIG=<私有回环配置> node scripts/storage-soak.mjs --seconds=1200 --idle=60`（可复用入口`npm run test:soak -- --seconds=1200 --idle=60`会先构建），窗口1440×900可见且非最小化；真实生产renderer/IPC/service/MinIO，普通/续传上传交替，每10轮取消后恢复，复制/元数据/保守重命名、下载及非法输入。每轮独立正文SHA-256；无强制GC、页面刷新或进程重启替代静置。正式结果：负载1200.390秒＋静置60.012秒；1079轮、107次确定中断后的重新授权恢复，错误0。五组独立正文摘要核验累计126.445GiB（重复对象，非唯一数据规模）。48次采样窗口均可见且非最小化；主进程working set初始205.4MiB、峰值361.9、静置末303.6；渲染器131.2→峰值235.4→末187.9MiB。没有强制GC/重载/重启，有限时长不能排除所有长期分配问题。

长跑JSON和截图在本地artifacts/object-management-soak，并复制到工作区scratch/2026-10-28-storagelab-management。应用关闭标记不单独当清理证明：独立SDK检查发现1个隔离残留桶，显式清除版本/分片后再次ListBuckets为0；服务PID核验后停止，私有配置/PID、已卸载的自有测试卷镜像删除。新DMG测试挂载也已释放。未触及生产MinIO。

## 安装包

标准`release:plan/build -- --platform=macos --arch=all`和`release:verify`通过，两件DMG的大小/摘要见[本地产物索引](object-management-artifacts.json)。构建时sourceCommit为ab00e9e且sourceDirty=true，包含随后提交f03ea5d的最终生产代码；构建后仅改测试/验收文档，未改生产行为。不伪称清洁提交构建。

本轮arm64 DMG只读挂载后，实际生产app.asar以独立appData启动：品牌/ID/SQLite、真实MinIO浏览、设置持久化重载通过。使用会话凭证和mock-keychain，不将其当真实钥匙串或系统安装替换验收；测试进程已退出、DMG挂载已释放。

本轮没有新Windows/Linux包或目标系统安装验收。Mac x64仅构建/容器完整性，实际x64运行未验证。Developer ID/notarization及正式分发签名未完成；无上传、公开URL或自动更新feed。

## 限制

本轮真实服务仅本地MinIO；9家云预设不是云账号认证。实测MinIO忽略Copy目标和Delete源条件，故重命名复制后保留源、显式提示部分完成。Create/Complete响应不明、UploadPart回执丢失、配置变化时都采取保守拒绝或明确本机放弃；原服务孤儿分片可能需要人工核实。完整SHA-256会增加磁盘读取，未实测5GiB复制/64GiB文件/100连接等极限GUI。下载尚无断点恢复。Windows文件权限分支经单测，真实ACL/原生续传仍待Windows机器验证。
