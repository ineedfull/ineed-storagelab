# Native Provider Expansion Implementation Plan

Spec: ../specs/2026-10-28-native-provider-expansion-design.md
Goal: migrate suitable remaining providers to official native SDKs and refresh visible provider Select.

## Global Constraints

- SDK only main process, no cloud/146 test requests; no automatic commits or publication.
- Legacy identities/upload IDs/checkpoints remain compatible until explicit saved migration.
- Preserve raw keys, opaque markers, versions and conditions; reject unsupported fields, never drop protections.
- TLS verification, retry0, actual request/stream cancel/deadline and cleanup required.

## Task 1: COS native adapter

Own electron/providers/cos.js and tests/cos-native.test.js. Export createCosClient; native official cos-nodejs-sdk-v5, per-bucket scopes, all existing internal commands/signing. Failing tests first; actual SDK local wire and coordinator uploads, XML and raw paths.

## Task 2: TOS native adapter

Own electron/providers/tos.js and tests/tos-native.test.js. Export createTosClient; native official @volcengine/tos-sdk, same contract and checks. Failing tests first; actual native authorization/Token/Key, stream lifecycle and coordinator tests.

## Task 3: provider domain, integration, feasibility and visible Select

Factory routes new IDs, provider configs and generalized explicit migration preserve old IDs. Domain/ConnectionDialog/tests update, native choices and 16 combinations. Research Kodo plus S3-only providers with official evidence; migrate only viable official data SDK. Correct current visible stale app after no-active-task/session check. No arbitrary data migration.

## Task 4: review, regressions, docs and cleanup

Independent review and scoped fixes; npm test/test:ui/build, isolated MinIO integration/native, format/dependency/diff. Update native-providers/cloud docs/workspace task STATUS and honest evidence. Clean generated fixtures, preserve reports/screenshots and dirty work.

## Task 5: 用户追加的旧版入口收口

移除三个厂商旧 S3 的新建选择，内部与已保存旧连接兼容保留；回归以预置旧连接测试编辑/迁移/取消，不能通过新建表单创建已移除的选项。检查12项新建菜单与对应原生SDK链路，独立复核改动并刷新实际窗口。
