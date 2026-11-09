# 首批云提供商接入历史验收

以下为首批 S3 接入时的记录，后续功能与当前验证以 [当前接入说明](cloud-providers.md) 和 [原生接入说明](native-providers.md) 为准。

### 本轮验证结果

2026-10-28，macOS arm64，Node 26.10.0 / Electron 43.1.0：

- `npm test`：87通过、1项原条件跳过，0失败；含6项提供商领域/原生保护/SDK序列化测试及8项对象标签测试。
- `STORAGELAB_TEST_CONFIG=<私有回环配置> npm run test:integration`：真实隔离MinIO集成2通过，包含原有传输与新增标签/版本隔离。
- `npm run test:ui`：42通过，含提供商表单16显示组合、标签流程和既有工作台回归。
- `STORAGELAB_TEST_CONFIG=<私有回环配置> npm run test:native`：3通过；生产启动、9家身份的生产表单/SQLite/回环S3，以及真实上传下载/分享/取消/删除/标签独立读回和16显示组合。文件/确认对话框由隔离harness注入。
- 最后独立复核发现R2合法签名别名`us-east-1`重编辑后助手无法应用：先新增回归并确认失败，再将助手初始化固定为`auto`，保持已存签名区域至显式应用。修复后`npm run test:ui -- tests/ui/providers.spec.js`17通过，`STORAGELAB_TEST_CONFIG=<私有回环配置> npm run test:native -- tests/native/providers.spec.js`1通过，构建通过；复审无遗留发现。
- 改动JS/Vue/CSS的Prettier及`git diff --check`通过。本轮没有重新制作安装包，也不据macOS开发宿主结果宣称Windows/Linux或安装包云服务验收。

测试仅使用本地回环实例；测试桶在退出后清理，服务随后停止，私有测试配置移除。上述为提供商接入阶段的历史验收；随后完成的[对象版本与恢复](object-versions.md)及其增量验收单独记录，R2明确不支持该能力。重启续传、复制/重命名、元数据改写和桶管理仍待后续独立实现。
