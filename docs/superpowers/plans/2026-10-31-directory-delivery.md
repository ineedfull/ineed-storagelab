# Directory Delivery Implementation Plan

**Goal:** 原生目录批次传输、SHA-256核验与JSON交付清单。

**Architecture:** 有界预览持有原生文件授权，滑动窗口复用既有队列；独立批次表保存完整结果，renderer仅处理公开快照。

**Tech Stack:** Vue 3、Electron、node:sqlite、现有厂商适配器。

**Spec:** `docs/superpowers/specs/2026-10-31-directory-delivery-design.md`。按用户授权在原仓库实施，保留已有表单文件，不自动提交发布。

## Global Constraints

- 最多1000文件、10000遍历项、32层、2活动批次、每批8在途，token10分钟；历史20批次。
- 原始Key保留；renderer无文件路径授权；旧SQLite2显式迁移至3。
- 本地时间统一入口；双主题/字号/侧栏/宽窄矩阵；Electron only。

## Task 1: 原生目录预览与完整性基础

Files: create `electron/transfers/directory-plan.js`, `electron/transfers/integrity.js`, `tests/directory-plan.test.js`, `tests/directory-integrity.test.js`; modify `electron/transfers/download.js`。

- [x] 编写并运行失败用例：嵌套/空文件映射、symlink/别名拒绝、重复游标不能当完整列表、SHA-256不符拒绝。
- [x] 实现 `planUpload(root,prefix)` / `planDownload(client,bucket,prefix,directory)` 与 `hashFile(path,{identity,signal})` / `hashRemote(client,{bucket,key,size,etag,versionId,signal})`。
- [x] downloadObject增加可选localKey/ifMatch/verifyIntegrity，不改变普通调用返回与默认行为；测试远端Key与本地路径分离及流/磁盘摘要一致。
- [x] Run `node --test tests/directory-plan.test.js tests/directory-integrity.test.js tests/download-paths.test.js`。

## Task 2: 批次持久化与执行

Files: create `electron/transfers/directory-service.js`, `tests/directory-delivery.test.js`; modify `electron/store.js`, `electron/service.js`, `electron/ipc.js`。

- [x] 先写服务失败用例：prepare返回私有token和公开预览，执行后完整结果可导出；取消、摘要失败、重启均不伪报通过。
- [x] 实现schema3独立批次表及get/save/list方法，保留旧结构数据；启动将活动批次标记interrupted。
- [x] 实现prepareDirectory/startDirectory/listDirectoryBatches/cancelDirectory/discardDirectoryPlan/exportDirectory方法；队列窗口补位，完成结果独立保存。
- [x] Run `node --test tests/directory-delivery.test.js tests/store.test.js tests/ipc.test.js`。

## Task 3: 可见工作流与整体验证

Files: create `src/components/DirectoryDelivery.vue`, `tests/ui/directory-delivery.spec.js`; modify `src/components/Workbench.vue`, `src/styles/workbench.css`, `docs/user-guide.md`。

- [x] 浏览器先验证入口、预览冲突、执行/取消/清单反馈，并确认切换上下文清理token。
- [x] 实现固定标题/滚动正文/底栏的目录交付窗口，展示批次结果、文件校验来源及公开URL边界。
- [x] Run `npm test`, `npm run build`, `npx playwright test tests/ui/directory-delivery.spec.js`；使用隔离服务实际流/磁盘验证并更新文档与工作区记录。
- [x] 审查实际差异、兼容性与已有改动保留情况，记录尚未验证的云账号/平台。

## 实际验收

基础276通过/1既有跳过；新增窗口18浏览器用例和真实Electron目录往返1项通过；构建/格式/差异检查通过。独立复核发现并修复终态写库失败丢失会话结果、提交后不能取消核验两处问题，均先失败后回归通过并复核。云账号、其它平台、安装包与新增长压未计入；详见工作区tasks/2026-10-31-storagelab-directory-delivery.md。
