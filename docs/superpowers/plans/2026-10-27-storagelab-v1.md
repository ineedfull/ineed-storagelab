# StorageLab v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver a usable branded StorageLab Electron workbench for MinIO and generic S3 with secure connections, bounded transfers, controlled mutation and verifiable native workflows.

**Architecture:** Vue UI uses a restricted runtime bridge; Electron native services own encrypted credentials, SQLite, S3 clients and transfer resources. Pure domain modules hold validation and presentation contracts. Each layer is independently testable and production browser preview cannot perform native operations.

**Tech Stack:** Node >=22.16, npm lockfile, Vue3/Vite, Electron, AWS SDKv3, node:sqlite, lucide-vue-next, node:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-storagelab-v1.md`

## Global Constraints

- 显示名称 StorageLab；副标题“对象存储工具箱”；包/仓库 `ineed-storagelab`，应用 ID `com.ineedfull.storagelab`。
- 首版 Vue 3 + Vite + Electron，Node >=22.16，npm 锁文件；不提供Tauri，不自动发布，不访问146生产测试。
- renderer 不得获得任意文件系统或长期凭证读取接口。S3 Key 原样保存。readOnly 必须原生强制。
- SQLite schema1，凭证safeStorage安全后端加密或明确会话模式，无明文降级；测试使用隔离数据。
- 最多100连接、100排队任务、200条最近任务；列表单页200对象；整体并发1–4/default2、超时5–120/default30秒。
- 本地日期显示统一 YYYY-MM-DD HH:mm:ss.SSS，无效/缺失--、epoch0有效；存储仍ISO/epoch。
- UI 使用单token文件，浅深/系统、普通大字、展开折叠、1440×900和920×620均覆盖；macOS开发宿主品牌独立。
- 源码只在本仓库原目录；其他工具源码不修改；共享发布基础设施按工作区要求复制同版副本。

## File map and contracts

`src/domain/{connection,settings,datetime,errors}.js` is pure shared validation/presentation. `electron/{store,vault,ipc,main}.js` and `electron/preload.cjs` own persistence/trusted bridge. `electron/s3/{client,objects}.js` owns protocol. `electron/transfers/{queue,upload,download,paths}.js` owns file grants/state/resources. `electron/service.js` composes the methods table from spec. `src/runtime/bridge.js` unwraps envelopes into errors, browser native:false. `src/components/{AppShell,ConnectionDialog,ObjectBrowser,ObjectDetails,TaskCenter,SettingsDialog,AboutDialog,BaseDialog}.vue`, composables and CSS implement focused UI responsibilities. Additional focused files within these responsibilities are allowed, document public contracts. Tests parallel source responsibilities; scripts handle dev branding, icon generation and standard releases.

### Task 1: Secure connections, persistence and desktop foundation

**Files:** package.json/lock, index.html/vite config, src/domain/*.js, src/runtime/bridge.js, electron/{store,vault,ipc,main}.js, electron/preload.cjs, tests/{connections,store,vault,ipc,datetime}.test.js, minimal renderer entry; README architecture section.

**Interfaces:** Read spec first. Produce `createStore({directory,vault})` exposing public connections/settings/jobs and transactional saves, close; `createVault({safeStorage})`; native trusted IPC registration with injected invoke dispatcher; runtime invoke/onChange envelope contract exactly as spec. S3 methods may report NOT_READY in this independently testable foundation but Task2 must replace all of them. `bootstrap` app metadata real. Export validators usable in main and UI. Main creates sandboxed trusted window, rejects navigation/new windows, independent data identity and exit hooks. Service composition remains Task2.

- [ ] Write failing meaningful tests for invalid endpoint/userinfo, settings ranges, epoch0/missing/invalid, vault unavailable/basic_text/session, encrypted save/reopen/edit retain/delete rollback/restart interrupted and unknown/untrusted IPC. Example:
```js
assert.equal(formatDateTime(null), '--');
assert.notEqual(formatDateTime(0), '--');
assert.throws(() => validateConnection({ endpoint: 'https://a:b@example.com' }));
```
- [ ] Run focused node:test before implementation and record expected failure (RED).
- [ ] Implement domain, SQLite schema1 transactions and credential abstraction. Public snapshots omit credentials; do not leak raw SQL/SDK errors. Add bounded history, restart interruption, active profile locking hooks. Add Vite/Vue/Electron and pinned lockfile, minimal native/browser renderer truthful about runtime. Use installed series versions when available: Vue3.5.40,Vite8.1.5,Electron43.1.0,Playwright1.58.2,lucide0.468.0.
- [ ] Run all foundation tests and build, inspect diff/self-review, document callable APIs for Task2/3.
- [ ] Commit explicit task files; detailed report with RED/GREEN, commands, outcomes, contracts and concerns. No subagents.

### Task 2: S3 operations and reliable streaming transfer engine

**Files:** electron/s3/*.js, electron/transfers/*.js, electron/service.js, main composition, tests/{s3,transfers,service,download-paths}.test.js, tests/integration/*.test.js, integration fixture scripts, package dependencies/commands and docs/protocol.md.

**Interfaces:** Consume Task1 store/vault exports (read its API docs) and exact method/payload/value table in spec. Produce `createService({store,dialog,clipboard,shell,app,clientFactory?,fileAccess?})` or documented equivalent exposing `invoke(method,payload)`, event subscription and `dispose()`. Tests inject native pickers/confirmations, renderer never supplies disk paths. Main wires actual Electron dependencies. Runtime/renderer consumes only spec bridge. Expose isolated integration setup reusable by native UI tests. Controller will provide local MinIO path when available; support env STORAGELAB_TEST_ENDPOINT with test-only credentials and bucket, no production default.

- [ ] Write failing tests covering list denied then known bucket succeeds, raw special keys, MaxKeys/cursors, size-limited preview incl excessive body after HEAD, errors taxonomy/redaction, share no hostname replacement, readOnly denial, delete confirmation cancel/HTTP200 partial errors/version unknown.
```js
const result = await service.invoke('deleteObjects', { connectionId, bucket, keys: ['a','b'] });
assert.deepEqual(result.errors.map(e => e.key), ['b']);
```
- [ ] Write failing transfer tests for bounded concurrency, cancel queued/running, multipart abort/cleanup, progress/final commit race, retry/no grants after restart, active profile editing, queue/history caps, remote success/history failure, streaming truncated download, overwrite/no-overwrite race, traversal/reserved/case collisions/symlink safety. Tests must inspect actual temporary files/state where relevant, not only mock call counts.
- [ ] Run focused suites RED, implement SDK clients/list/head/preview/share/delete and bounded queue/uploads/downloads following exact spec. Install/pin AWS dependencies. SDK connection/socket timeouts, attempts3, checksumWHEN_REQUIRED. Preserve raw keys. Default no overwrite is enforced or explicitly refused when service cannot offer it. Native confirmation displays delete/version truth. Per-job stable profile/credentials and resources owned/cleaned by queue.
- [ ] Add real local S3 integration harness: create isolated bucket; upload multipart payload larger8MiB and Chinese/special keys, list/paginate/head/preview, download compare SHA256 independently, signed GET fetch, cancel/remove multipart, selected delete, close/reopen store. Controller-provided actual MinIO is preferred. Distinguish fixture vs real provider evidence.
- [ ] Run Node suites + integration, build, self-review and document service APIs/cancel/limits and actual provider boundary. Commit task changes; detailed RED/GREEN/report, no subagents.

### Task 3: Complete interactive Vue workbench and native acceptance

**Files:** src/components/*.vue, src/composables/*.js, src/styles/{tokens,workbench}.css, src/main.js, src/runtime/bridge.js (preserve contract), tests/ui/*, playwright.config.js, scripts/dev-electron.mjs, product public icon interim from brand source if available, docs/ui.md and README commands.

**Interfaces:** Consume exact spec bridge and Task2 documented service composition; no direct renderer filesystem/SDK/SQLite use. UI service factory in tests is an explicitly test-only fixture; native tests exercise same production UI with native service and isolated store/pickers. `dev:electron` uses branded copied/ad-hoc-signed macOS app (reference NetTool scripts/dev-electron.mjs); no mutation of node_modules Electron.app. Task4 may refine final generated icons but Task3 must provide functioning brand resources.

- [ ] Write failing Playwright tests for connection create/edit/retain-secret/errors, denied ListBuckets manual known bucket, raw prefix navigation/nextpage/current-page filter, object property/preview stale-result discard, upload/download queue/cancel/retry, partial deletion, sharing, settings draft cancel/failure, browser native disabled. Test meaningful resulting state/DOM; no implementation-only assertions.
```js
await page.getByRole('button', {name:'新建连接', exact:true}).click();
await expect(page.getByRole('dialog')).toBeVisible();
await page.keyboard.press('Escape');
await expect(page.getByRole('button', {name:'新建连接', exact:true})).toBeFocused();
```
- [ ] Implement focused Vue components and domain-driven actions, readable Chinese UI, connection group/bucket navigation, stable-width paged object table, raw key/full-copy, collapsible details, preview, share/delete/overwrite controls, task center states/progress/rate/export. Keep background transfers and selection when opening settings/about; show all errors and permission/capability truth. No modal native file grants through renderer paths.
- [ ] Implement theme/system/large/sidebar persistence, series tokens/time entry, accessible dialogs/trapped focus/Escape/return focus, aligned forms/errors/scrolling, true version/runtime/data directory/company website. Browser preview labels disabled native operations. Add branded dev host and launch command, initial1440×900/min920×620.
- [ ] Run UI suite, 16-combination geometry/screenshots and system theme; manually inspect representative screenshots. Run real Electron + isolated local storage full workflow via Playwright Electron: create profile, browse, upload, preview, download and compare, share fetch, controlled delete, task cancel, persisted reload. Native file pickers may be dependency injected by harness; report this separately from OS dialog manual acceptance. Record native app name/title/icon identity and no console/unhandled error. Test settings/about keyboard/scroll.
- [ ] Run affected Node tests/build/lint if configured, self-review, commit; report actual native and browser evidence with limits, no subagents.

### Task 4: Final branding, reproducible packaging and product documentation

**Files:** build icons, public icon, scripts/generate-icons.mjs, scripts/{desktop-release,release-upload}.mjs and *.test.mjs, scripts/release-product.json (match existing loader), package.json builder config, README/docs/{architecture,user-guide,verification,desktop-packaging}.md. External limited ownership: web/ineed-icon-concepts/current source/storagelab.svg,source/small/storagelab.svg,exports for ONLY this product, additive manifest/tokens registration; no unrelated regeneration. Workspace registration is controller-owned.

**Interfaces:** Follow series TOOL-PACKAGING.md; same-version shared release scripts from NetTool, configured `product:StorageLab,slug:ineed-storagelab,identifiers.electron:com.ineedfull.storagelab,runtimeDirectories.electron:'.'`. Only Electron. Preserve dev host working API. Icon源 is current, no product-local divergent new source.

- [ ] Read brand current README/manifest/tokens/exporter and produce standard256/small white i+storage symbol with series gradient. Generate png/ico/icns reproducibly, record source/provenance/hash and update only new product brand entries. Inspect small and standard renders.
- [ ] Configure uniform DMGarm64/x64, NSISx64, DEB/AppImagex64, exact StorageLab identity, release:plan/build/verify/upload/test:release and wrappers. Copy shared scripts/tests as deliberate maintained infrastructure; descriptor handles differences. Test plan/validation/upload safety without network or publication.
```js
assert.equal(plan.product, 'StorageLab');
assert.ok(plan.artifacts.every(a => a.runtime === 'electron'));
```
- [ ] Verify all platform plans and package:mac:dir; launch built macOS arm64 app with isolated data and exercise bootstrap/settings/local S3 browse. Check appID/name/icons/dependencies; configure signing truthfully. Do not claim Windows/Linux or macOSx64 native acceptance or official signing. Do not upload.
- [ ] Complete docs: feature walkthrough/commands/architecture with UI→bridge→service→S3/store→tests path, provider-tested vs configured matrix, exact limits/security/version/ETag semantics, failure/recovery/troubleshooting, data migration and release procedures, native/browser/package evidence with commands and no secrets. All first-tool checklist items mapped to evidence or explicit scope.
- [ ] Run full Node + release suites, lint/format if configured, build; reuse unchanged passing native/UI evidence unless branding/package changes create concrete need. Self-review/commit/report, no subagents.
