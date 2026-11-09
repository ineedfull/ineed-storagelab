# StorageLab 审查问题修复（2026-10-30）

对应[全仓审查](2026-10-30-full-review.md)的 SL-1～SL-5。基于 `codex/storagelab-initial` / `1758a5cb327ccf94b3dfa55d5097b63d5bad1ff3` 修改，保留前轮页签 UI 改动；未提交或发布。

## 修复行为

| 编号 | 修复 | 回归依据 |
| --- | --- | --- |
| SL-1 | 打开 SQLite 和执行恢复前取得 Electron 单实例锁；重复启动退出并唤回原窗口，启动尚未完成时保留唤醒请求 | 实际两个 Electron 进程共享同一隔离 appData：重复实例退出、最小化窗口恢复、运行任务仍为 running；退出后正常重启才恢复为 interrupted |
| SL-2 | 四家原生 GET 等待响应头仍有时限；正文改为 socket 空闲超时，保留取消/销毁和流式背压。监听清理幂等，防止旧正文的 close 影响复用 socket | 四家实际 SDK/签名及回环 HTTP：持续传输超过时限且逐字节一致、无响应头/正文停滞有界失败、取消/销毁清理半成品。合法5秒设置对照见下表 |
| SL-3 | 任务刷新按请求序号接受最新响应；过时错误不写全局反馈，dispose 失效待处理刷新 | 成功、取消、删除快照倒序、旧错误和 dispose 竞态 |
| SL-4 | 按 opaque 游标聚合完整桶列表；最多100页/10000桶，重复/非法/缺失游标、超限和后续失败明确拒绝整次列桶 | 实际 S3/OSS/OBS/COS 两页线上报文；TOS官方接口单次全量且无额外分页参数；公共层边界测试 |
| SL-5 | 上级按原始斜杠位置移除一层，空段也有效，保留点路径语义 | 实际 Vue 页面点击 `/`、`data//`、`/a/`、`data/../`、`a/b/`、`///` |

列桶回归额外发现 OBS 官方 SDK 用 `BucketName` 返回桶名，已映射为公共 `Name`；并将 `ContinuationToken`/`MaxBuckets` 转换为 OBS `Marker`/`MaxKeys`，统一 NextMarker/IsTruncated。OSS/COS 同步保留截断标记以识别异常回包。

没有移除非 GET 的原有请求时限。OSS urllib 的 streaming 返回会清除内部响应等待定时器；TOS 自定义 HTTP adapter 不执行 Axios 的默认绝对时限；OBS 使用受控 third_http_lib，SDK默认 socket超时分支不会进入。四家收到真实 IncomingMessage 后均由相同空闲监控负责，未引入消费正文的 data 监听或全文件缓存。无 socket 的测试注入流继续保持原有有界 deadline。

## 失败回归与验证

先执行失败回归再修复：任务/桶公共层11项中10项按预期失败；原生持续下载20项中四家长下载均在约400ms错误失败，其余16项对照通过；原始目录6项中3项失败；真实重复启动测试得到 still-running；OBS实际分页先暴露桶名缺失。修复后对应测试通过。socket复用的重复清理也先复现旧响应清除新超时，再修复并验证。

正式5秒超时对照：回环服务每100ms发送1KiB，共64KiB，五种实际适配器通过 `downloadObject` 下载。COS/OBS仅将DNS/transport定向回环，签名/协议映射仍使用真实代码。

| 数据面 | 结果 | 耗时(ms) | 进度次数 |
| --- | --- | --- | --- |
| S3 | success | 6560 | 64 |
| OSS | success | 6560 | 64 |
| TOS | success | 6559 | 64 |
| COS | success | 6559 | 64 |
| OBS | success | 6558 | 64 |

在产品目录执行：

- `npm test`：258项，257通过、1项既有 Tauri packaging 跳过，0失败；新增39项基础回归。
- `npm run build`：通过。
- `npm run test:native -- startup.spec.js single-instance.spec.js`：真实macOS arm64 Electron生产入口2项通过，含单实例/正常重启与品牌/隔离SQLite/safeStorage现有启动回归。
- `npm run test:ui`：207项通过（2.2分钟），含六项原始前缀导航，以及浅深/普通大字/展开折叠/宽窄窗口矩阵；抽查浅色普通展开宽窗、深色大字折叠窄窗截图，未见新增布局问题。
- 修改代码的 Prettier 检查、`git diff --check`：通过。

本轮只使用隔离目录、生成的测试凭证和回环 HTTP，无真实云桶或146操作。并未重跑完整 MinIO 业务/20分钟压力、安装包、Windows/Linux/Intel Mac原生验收；此前结果是历史记录。本轮修复不涉及发布签名，依赖审查通告仍按原报告单列，未自动升级或降级SDK。

原始日志：工作区 `scratch/2026-10-30-storagelab-review-fixes/`，包含 Node、浏览器、原生、构建和5秒下载对照。当前架构、用户指南与原生SDK维护说明已同步；应用ID、数据目录和schema2不变。
