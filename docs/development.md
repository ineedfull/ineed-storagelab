# StorageLab 开发指南

[返回产品首页](../README.md) · [架构与维护路径](architecture.md)

## 安装与启动

需要 Node.js 22.16+ 与 npm 锁文件。在根目录执行：

```sh
npm ci
npm run dev:electron
```

该命令先构建再启动品牌 Electron 宿主。`npm start` 直接启动已构建资源；`npm run dev` 只提供浏览器外观预览，不访问本地数据或真实存储。热开发方式见[工作台说明](ui.md)。产品独立 ID 为 `com.ineedfull.storagelab`，当前仅 Electron。

## 代码入口

```text
src/components/   连接、对象、任务、目录交付与弹窗
src/composables/  工作台状态及操作协调
src/domain/       提供商、连接、时间、容量等纯领域逻辑
src/runtime/      固定 invoke/onChange 桥与浏览器能力边界
electron/         IPC、SQLite/vault、SDK、文件与任务服务
```

调用链为 Vue → `src/runtime/bridge.js` → `window.storageLab` → `electron/preload.cjs` → `electron/ipc.js` 的方法/payload/窗口校验 → dispatcher → SDK/传输/store。原生桥返回 `{ok:true,value}` 或 `{ok:false,error:{code,message}}`；UI 将失败转换为 AppError。变更事件只通知重取公开状态，不推送密钥。

provider factory 接入 AWS S3、OSS、OBS、COS、TOS SDK，能力差异在服务层保护；不要为厂商复制整套工作台。完整边界见[原生提供商](native-providers.md)及架构文档。

## 凭证与数据

SQLite schema3 兼容升级 schema1/2，公开数据与加密凭证分表；系统加密能力不可用时仅允许明确的会话模式，禁止明文降级。会话凭证只在原生内存，退出消失。

任务捕获 connection/credentials 快照并持有幂等锁释放函数，renderer 不能访问任意文件系统或长期凭证。重启将未完成任务改为 interrupted；上传续传通过重新选择文件与内容核验恢复。error/warning 必须是清洗后的可读文本，不暴露原始 SDK/SQL 错误。SQLite、目录批次与本地文件关联的迁移均要兼容已有安装。

## 分层验证

```sh
npm test
npm run build
npm run test:ui
```

本项目没有 lint 脚本。浏览器测试使用隔离测试桥，不代表原生云服务通过验证。真实 MinIO / Electron 需要私有回环配置，按[验证说明](verification.md)准备：

```sh
STORAGELAB_TEST_CONFIG=/path/to/private-loopback-config.json npm run test:integration
STORAGELAB_TEST_CONFIG=/path/to/private-loopback-config.json npm run test:native
```

不得将真实客户桶或公开发布桶用作回归目标。`test:soak` / `test:directory:soak` 是长时间压力入口，应先检查对应脚本与隔离配置。真实云账号、系统凭证后端、安装包与其它操作系统分别记录验收，不能用浏览器结果替代。

## 品牌与发布

产品内图标在 `public/icon.svg` / `icon-small.svg`；先维护系列品牌源，再运行 `npm run generate:icons`，该流程需要 @resvg/resvg-js 和 macOS iconutil。

使用 `release:plan/build/verify`，按目标操作系统构建；`package:mac:dir` 生成本机 arm64 测试应用。`release:upload` 会写远端，仅用于明确发布任务。命令、工具链、签名与各平台状态见[桌面打包](desktop-packaging.md)和[发布前验收](release-acceptance.md)。

界面与主题遵循[工作台规则](ui.md)，时间复用 `src/domain/datetime.js`。首页图片与微信二维码的来源和维护方式见[图片维护](images/readme/README.md)。
