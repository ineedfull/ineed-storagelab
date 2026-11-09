# Native OSS / OBS Implementation Plan

> 执行方式：本会话按superpowers:executing-plans顺序实施，保留原目录未提交工作；用户已授权先OSS、OBS，不重复请求范围确认，不自动提交。

**Goal:** 官方SDK实现OSS与OBS，兼容已有S3连接与现有功能。
**Architecture:** provider factory选择SDK适配器；内部命令/响应作为过渡协议复用当前队列、文件授权及版本工作流；签名链接由实际SDK生成。
**Tech Stack:** Vue/Electron/SQLite，ali-oss6.23.0，esdk-obs-nodejs3.26.2。
**Spec:** ../specs/2026-10-28-native-oss-obs-design.md

## Global Constraints

- 官方SDK仅在主进程加载。关闭SDK隐式重试，保持TLS校验。
- 新增oss/obs，保留旧aliyun S3配置和续传；不静默更换Endpoint或协议。
- 原始Key、opaque分页标记、版本ID和条件写入不丢弃；未知能力保守拒绝。
- 测试隔离，不访问用户云桶或146，不上传发布。

## Task 1：官方SDK适配器

Files: 新增electron/providers/client.js、oss.js、obs.js；修改package.json/package-lock.json、electron/service.js与electron/s3/operations.js/errors.js；新增tests/native-providers.test.js。

Interfaces: `createProviderClient(connection, credentials, settings, options)`返回`send(command,{abortSignal})`、`signGet({bucket,key,expiresIn})`、`destroy()`与现有上传协调器所需config。OSS/OBS工厂分别暴露相同接口；测试可注入sdkFactory，生产不提供renderer入口。

- [x] 先写测试：native provider路由、SDK流映射/版本/标签/分片响应、取消和HTTP错误，不把模拟对象存在当断言。
- [x] `node --test tests/native-providers.test.js`确认缺失适配器失败。
- [x] 锁定依赖，实现每厂商映射；SDK签名启用原生，异步请求挂取消钩子，dispose销毁自有agent/请求。
- [x] 同命令通过；以真实SDK与回环HTTP fixture另验证native Authorization/Token、原始特殊Key、分页、流和取消，拒绝静默S3回退。

## Task 2：提供商及旧连接显式迁移

Files: src/domain/providers.js、connection.js、src/components/ConnectionDialog.vue；tests/providers.test.js、tests/ui/providers.spec.js及新增tests/ui/native-providers.spec.js。

Interfaces: PROVIDERS增加oss/obs，`buildProviderConfig('oss',{location:'cn-shanghai'})`返回`https://oss-cn-shanghai.aliyuncs.com`；obs返回`https://obs.cn-north-4.myhuaweicloud.com`。原aliyun预设保留，标签/S3限制不变。

- [x] 写失败用例：原生两预设/验证、旧aliyun配置不变；连接迁移只转换标准S3域名，自定义域名需核对；未保存不改变既有连接。
- [x] 运行Node定向与浏览器定向，保留失败输出。
- [x] 实现两provider规则、原生连接提示和显式迁移动作；OBS path style在UI与原生校验均阻止，OSS拒绝S3专用域名。
- [x] 验证旧S3标签保护仍存在，原生标签可用；浅深/普通大字/展开折叠/宽窄的16显示组合通过。

## Task 3：完整回归与交接

Files: 新增tests/integration/native-provider-fixture.js或同等回环测试工具；按需新增tests/native/native-providers.spec.js；docs/native-providers.md、README.md、docs/cloud-providers.md、工作区任务与STATUS。

- [x] `npm test`、`npm run test:ui`、`npm run build`通过，修改文件Prettier与git diff --check通过。
- [x] 私有回环MinIO配置执行`npm run test:integration`与`npm run test:native`，既有6项存储与桌面流程不回退。
- [x] 原生厂商SDK协议fixture核对上传/下载、签名链接、版本/标签和取消；核验生产依赖树及当前macOS arm64 Electron主进程真实SDK加载；安装包与其他平台单列未验收。
- [x] 记录真实SDK本地测试与云账号未验收边界，清理测试服务、文件与私有配置，保留日志/截图。
