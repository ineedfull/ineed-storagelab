# StorageLab 可读性审查与整理（2026-11-02）

## 范围与结果

沿目录交付界面、预览授权、批次刷新/取消/导出、原生调度和结果持久化阅读。本轮改造目录交付界面状态；原生传输算法与厂商SDK数据面没有重写。

| 阅读障碍或问题 | 处理与边界 |
| --- | --- |
| 页面内混合预览、批次、轮询、详情与原生调用 | 提取 `src/composables/useDirectoryDelivery.js`；`DirectoryDelivery.vue`保留呈现/交互绑定 |
| plan/batch/detail/page不容易看出各自归属 | 使用 previewPlan、selectedBatch、selectedEntry、pageIndex；具名previewDirectory/startTransfer/refreshBatches动作 |
| 多个按钮重复busy/异常收尾，模板内反复筛选统计和嵌套三元表达式 | `runTransferAction`统一动作收尾，computed汇总/摘要依据与具名核验标签集中管理 |
| 轮询与原生传输的寿命容易混淆 | 注释说明窗口只拥有轮询和预览授权；关闭撤销预览，活动传输仍归原生服务 |

## 已复现并修复的缺陷

P2：两次目录刷新倒序结束，较旧请求失败时，公共调用包装提前写入错误，绕过刷新修订号检查。现在轮询在自身catch中同时检查窗口寿命和刷新修订号，再发布错误；成功快照也继续使用相同保护。已有结果在刷新失败时保留。

`tests/ui/directory-delivery.spec.js`先复现失败，再验证修复。另保留预览/传输/跳过核验/详情/清单、关闭撤权及历史淘汰回归。

旧S3连接身份、迁移入口、旧MinIO删除MD5处理、schema迁移均仍有兼容用途，不能因名称含legacy或“旧版”直接删除。确认的重复页面控制流已合并；没有更改raw Key、私有路径/凭证边界、schema3或普通任务续传规则。

## 验证

根目录 `npm test` 277通过/1既有跳过，`npm run build`、显式文件Prettier检查与 `git diff --check` 通过。本项目没有lint脚本。

`npm run test:ui -- tests/ui/directory-delivery.spec.js` 20通过，含4业务/竞态用例和16显示组合（浅深、普通/大字、展开/折叠、1440/920）；截图已检查。这是浏览器fixture；Node测试使用隔离文件/存储替身，不算真实云服务或Electron原生目录选择验收。

未访问146发布桶，未重新运行长时压力、安装包或其他平台；未提交、打包或发布。阅读入口：[架构与维护路径](../architecture.md)。
