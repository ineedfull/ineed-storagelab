# 云对象存储接入与 SDK 选择

StorageLab 新建连接提供 12 个选项，包括四家原生接入；内部仍识别三个旧版厂商身份以兼容已保存连接和任务。厂商预设只描述地址和客户端能力，不代表账号权限、真实云端或安装包已经验收。原生适配、迁移及保护见 [原生接入说明](native-providers.md)。

## 提供商与实现

| 提供商              | 当前实现                                               | Endpoint 示例 / 注意事项                                                |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| MinIO / 通用 S3     | 官方 AWS SDK v3，S3 协议                               | 手动填写服务地址；MinIO 默认 Path style                                 |
| Amazon S3           | 官方 AWS SDK v3，S3 协议                               | `https://s3.eu-west-1.amazonaws.com`；中国区使用 `.amazonaws.com.cn`    |
| 阿里云 OSS          | 官方 `ali-oss@6.23.0`，原生 OSS V4                     | `https://oss-cn-shanghai.aliyuncs.com`；旧 `aliyun` 仍使用 `s3.oss-...` |
| 华为云 OBS          | 官方 `esdk-obs-nodejs@3.26.2`，原生 OBS                | `https://obs.cn-north-4.myhuaweicloud.com`；仅虚拟主机寻址              |
| 腾讯云 COS          | 官方 `cos-nodejs-sdk-v5@3.0.0` 签名/XML，受控原生 HTTP | `https://cos.ap-guangzhou.myqcloud.com`；桶名含 `-APPID`；禁 Path style |
| 火山引擎 TOS        | 官方 `@volcengine/tos-sdk@2.9.1`，原生 TOS4            | `https://tos-cn-beijing.volces.com`；旧 `tos` 使用 `tos-s3-...`         |
| 七牛云 Kodo         | 官方 AWS SDK v3，保留 S3 接入                          | `https://s3.cn-east-1.qiniucs.com`；S3 空间名可能不同于原生空间名       |
| Cloudflare R2       | 官方 AWS SDK v3，厂商文档推荐的 S3 数据接口            | `https://<AccountID>.r2.cloudflarestorage.com`；签名区域 `auto`         |
| Backblaze B2        | 官方 AWS SDK v3，B2 S3 兼容数据接口                    | `https://s3.us-west-004.backblazeb2.com`；keyID / applicationKey        |
| DigitalOcean Spaces | 官方 AWS SDK v3，厂商文档推荐的 S3 数据接口            | `https://sgp1.digitaloceanspaces.com`；JS 示例签名区域 `us-east-1`      |
| Wasabi              | 官方 AWS SDK v3，厂商文档推荐的 S3 数据接口            | `https://s3.us-east-1.wasabisys.com`；地域匹配桶                        |

旧 `aliyun`、`cos`、`tos` 不再出现在新建连接的 Select 中。编辑已保存的旧连接时，仅显示该连接当前的旧版身份，供明确迁移与取消。新增身份为 `oss`、`obs`、`cos-native`、`tos-native`。连接中的桶名独立填写，Endpoint 不填对象路径或签名参数。自定义域名按服务 API 基础地址处理，不推测桶绑定 CNAME。

## 为什么部分厂商保留 S3

AWS 已经使用官方 SDK。R2、Spaces 和 Wasabi 的官方文档直接提供 AWS SDK 对象读写方案；它们的账号、计费等管理接口 SDK 不能替代对象数据接口。保留这条路径符合厂商推荐。

B2 同时有原生 API 和 S3 兼容 API。常见 npm `backblaze-b2@1.7.1` 属于社区维护，并非 Backblaze 官方 Node SDK；本轮继续通过官方 AWS SDK 访问其 S3 数据接口，没有把社区包标成官方实现。

七牛有官方 `qiniu@7.15.2` SDK。核验发现，原生私有下载签名需要空间绑定资源域名，现有 S3 Endpoint 不能直接替代；原生空间名和 S3 空间名也可能不同。当前 Node SDK 高层接口无法直接覆盖本工具既有的版本身份、标签、远端分片核验和安全重启续传契约。七牛原生 REST 有列举已上传分片等接口，此处限制是适配模型和 SDK 覆盖，不能据此认定云服务没有能力。因此本轮保留完整 S3 工作流；后续原生接入需独立设计资源域名、能力矩阵和迁移方式。

## 配置与兼容

选择提供商后，显式应用配置助手才会生成 Endpoint、签名区域和寻址方式；不会自动改写已有配置或发起请求。服务地域只用于配置助手，实际连接读取保存的 Endpoint 与区域。R2 账户 ID 为 32 位十六进制；特殊辖区、内网或代理地址需按厂商文档手填。

编辑连接不回填密钥。地址改变但凭证留空时，仍沿用原凭证，表单会提示；更换账号需填写新凭证。保存使用系统加密或明确的会话模式，不增加明文降级。

迁移旧版只改变当前草稿，保存后才生效。取消不修改真实连接；未完成任务与旧协议续传记录不会自动迁移。SQLite 仍为 schema2，应用 ID 和已有本地文件关联保持兼容。

## 能力与保护

工作台统一提供浏览、分页、属性、预览、上传/分片/下载、任务、分享、删除、标签、版本、复制与元数据编辑；具体操作受提供商能力和账号权限限制。列桶 403 时仍可打开已知桶。

- R2、B2、旧阿里云 S3 明确禁用对象标签；其他提供商按适配能力和实际响应判断。R2 不开放本工具版本管理。
- 新云提供商默认不执行未经验证的原子不覆盖上传；需核对目标并明确允许覆盖。未知条件不得静默删除；重命名无法保证条件删除时保留源对象并提示。
- 原生适配器不重试结果不明的写请求。发生网络错误应先刷新核实；不能据错误认定远端没有写入。
- TLS 证书和主机名校验保持开启。临时 Token 属于厂商自己的权限与有效期；生成签名不代表链接已经实际可用。
- 不提供 IAM、计费、CDN、桶策略或跨云同步。未接入的 Azure Blob、GCS、BOS、US3、KS3 不会显示为已支持。

## 验证和维护

`src/domain/providers.js` 集中维护身份、预设和能力保护，`connection.js` 在 UI 与原生复用校验。`electron/providers/client.js` 选择厂商适配器；共用服务、传输队列与界面，不复制多套工作台。

本轮只使用生成凭证和本地协议服务，真实官方 SDK 的签名/请求/解析、Electron 原生加载与原有 MinIO 链路分别验收。未访问用户云桶或146；真实厂商账号、云策略、安装包、Windows/Linux 仍需单独验收。最新数字见 [原生接入说明](native-providers.md)，首批 S3 的旧数字归档在 [历史记录](cloud-providers-history-2026-10-28.md)。

## 官方依据

- [OSS Node.js SDK](https://github.com/ali-sdk/ali-oss)、[OBS Node.js SDK](https://github.com/huaweicloud/huaweicloud-sdk-nodejs-obs)。
- [COS Node.js SDK](https://github.com/tencentyun/cos-nodejs-sdk-v5)、[TOS Node.js SDK](https://github.com/volcengine/ve-tos-nodejs-sdk)。锁定版本源码同时用于核验重试和签名行为。
- [七牛 Node.js SDK](https://developer.qiniu.com/kodo/1289/nodejs)、[S3 服务域名](https://developer.qiniu.com/kodo/4088/s3-access-domainname)；本轮读取 `qiniu@7.15.2` 类型和私有下载签名实现。
- [R2 S3 兼容表](https://developers.cloudflare.com/r2/api/s3/api/)。
- [B2 S3 兼容 API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)。
- [Spaces 官方 AWS SDK 示例](https://docs.digitalocean.com/products/spaces/how-to/use-aws-sdks/)。
- [Wasabi AWS SDK for JavaScript](https://docs.wasabi.com/docs/how-do-i-use-aws-sdk-for-javascript-with-wasabi)。

调研原文与 SDK 检查保留在工具工作区 `scratch/2026-10-28-storagelab-native-expansion/`，不含真实账号凭证。
