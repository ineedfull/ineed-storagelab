# StorageLab 开发约定

- 独立产品 StorageLab；应用 ID `com.ineedfull.storagelab`。首版 Vue + Electron，源码只在本仓库维护。
- 开始先看 README、package.json、Git 状态和 docs/superpowers/specs/2026-10-27-storagelab-v1.md。保留其他会话改动。
- UI、领域、原生服务分层；renderer 不得获得任意文件系统或长期凭证读取接口。S3 Key 原样保存。
- SQLite schema 版本化，safeStorage 加密凭证；不可用时只允许明确的会话内模式，禁止明文降级。
- 测试使用隔离目录、回环存储服务；不访问146发布桶，不自动发布。
- 修改核心行为先写有意义的失败测试，再实现；运行真实 npm 命令并如实区分浏览器、原生开发宿主、安装包和其他平台。
- 统一时间入口、语义 UI token；浅深/普通大字/展开折叠/窄窗口均检查。详见工作区 docs/TOOL-UI.md、TOOL-DATETIME.md。
- 不得从其他工具复制领域工作台或共享用户数据。共享发布脚本允许按工作区规范同步副本。
