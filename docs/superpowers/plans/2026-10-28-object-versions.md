# Object Versions Implementation Plan

**Goal:** 完成单对象版本查询、指定版本下载、受控恢复与保留信息展示。

**Architecture:** 独立S3版本模块与Vue版本窗口；复用原生上下文/锁、队列和安全下载。串行在原共享源码目录实施，保留对象标签/提供商既有未提交改动。

**Tech Stack:** 现有Vue、Electron、AWS SDK v3、node:test、Playwright；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-28-object-versions-design.md`

## Constraints

- schema1/appID/凭证策略不变；Key原样；仅隔离回环测试，不访问146。
- 列表200/页；单次Copy≤5GiB，仅enabled桶/不可变VersionId；默认拒绝覆盖本地文件。
- 权限失败不等于空历史；缺失保留头不等于无保留；不可承诺目标原子CAS。

## Tasks

- [x] 1. Node失败测试：IPC、精确Key/双标记分页、HEAD/保留、源编码/条件复制、只读/取消/null/大小/未知状态、队列versionId及重试；实现版本协议与service/下载链路，跑定向测试。
- [x] 2. UI失败测试：手输已删除Key、列表/选择/分页/错误、下载/恢复反馈及旧响应隔离；实现独立composable/窗口、工具栏和详情入口；跑16显示组合并人工看图。
- [x] 3. 回环MinIO及真实Electron生产UI：版本下载/恢复/删除标记与独立内容读回，清理全部版本；跑全量Node/集成/UI/原生与构建/格式。
- [x] 4. 独立审查并修复发现；更新用户/维护/工作区任务文档，记录准确验收和剩余边界。不自动打包/发布。
