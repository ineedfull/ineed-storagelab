# 桌面品牌与发布流程

2026-10-30已从干净提交35b2148构建并发布五个Electron测试安装包；私有上传回读和公网完整下载校验通过，详见[发布说明](releases/2026-10-30.md)。未发布自动更新feed。

产品StorageLab，副标题“对象存储工具箱”；npm/repository为ineed-storagelab，app ID为com.ineedfull.storagelab。首版只有Electron。`scripts/release-product.json`登记electron目录`.`，与NetTool同版的desktop-release/release-upload脚本和测试以产品描述处理差异；没有跨仓库运行依赖或源码软链接。

## 可复现品牌资源

唯一维护源：`web/ineed-icon-concepts/current/source/storagelab.svg`与`source/small/storagelab.svg`。标准256、圆角58、渐变#07CFE5→#3159DA（55%）→#BD35EF，白色i+立方体对象；小尺寸单独32母版。不是Store购物袋图标。

```sh
npm ci
npm run generate:icons
# 品牌源不在默认相邻路径时：
npm run generate:icons -- --brand-root=/绝对路径/ineed-icon-concepts/current
# 仅需同步本产品品牌导出和追加索引时：
npm run generate:icons -- --export-brand
```

生成要求锁定的@resvg/resvg-js 2.6.2 CPU渲染器以及macOS iconutil。标准PNG48/64/128/256/512/1024，小图16/24/32，产品build/icon.png为512；ICO含16至256的PNG frames；ICNS通过标准iconset生成。`build/icon-provenance.json`记源/导出/产品SHA-256，`public/icon{,-small}.svg`为来源副本。普通命令不写品牌仓库；export-brand只处理storagelab和追加注册，不运行全量exporter/网站同步。渲染器版本变化可能改变PNG字节，更新时审阅provenance和图像，不把复制出来的SVG作为新设计源。

## 本机开发宿主与打包

`npm run dev:electron`使用独立品牌开发.app缓存，修改副本plist/icon并ad-hoc签名，绝不修改node_modules Electron.app。缓存键包括Electron版本、架构和图标哈希。

```sh
npm run test:release
npm run release:plan -- --platform=macos --arch=all
npm run release:plan -- --platform=windows
npm run release:plan -- --platform=linux
npm run package:mac:dir
# 对应目标系统执行以下命令；不会上传：
npm run package:desktop:mac
npm run package:win
npm run package:linux
# 也可精确选择：
npm run release:build -- --platform=macos --arch=arm64 --runtime=electron
npm run release:verify -- --dir=/绝对路径/release/desktop/构建ID
```

矩阵：macOS arm64/x64各DMG，Windows x64当前用户NSIS EXE，Linux x64 DEB/AppImage。mac:dir仅是本地arm64测试.app。包内包含dist、electron、src/domain、生产依赖，renderer没有SDK访问或Node能力。应用asar内主程序用Node SQLite，不依赖本地外部源码。

release成功集合位于release/desktop/buildId，schema2清单记录版本/源码、矩阵、大小和SHA-256；统一名`ineed-storagelab-版本-electron-系统-架构.扩展名`（Windows-setup.exe、DEB amd64）。构建锁和暂存目录避免混包；缺失/重复/额外文件、格式头、大小、摘要和安全路径均校验。完整性不是安装/运行/签名验收。失败保留诊断，修复原因后新建集合，不拼接半套产物。

## 发布必须单独授权

`npm run release:upload -- --dir=...`仅在明确授权的发布任务执行。脚本先验清单，再按独立产品前缀上传私有ineed-downloads/ineed-storagelab/版本/buildId，回读摘要/大小，同键不同字节拒绝并保存收据；凭证用外部安全配置。不要把密钥写入仓库、清单或日志。首次实现没有运行此命令，没有访问146、写公开目录或发布网站。

macOS identity:null表示跳过正式签名，未做Developer ID/notarization。初次.app构建/自动化启动不等于DMG安装、Gatekeeper、升级、人工系统文件选择器、Windows/Linux/macOSx64验收。正式分发前应在各目标系统构建并安装启动，检查图标/数据保留/原生能力、完成对应签名策略，再处理私有上传与公开下载。没有自动发布或自动更新feed。

## 发布前实际验收

最新应用包、真实钥匙串、同版替换、跨平台构建和运行结果见[发布前验收](release-acceptance.md)。首次Linux DEB构建暴露homepage必填项，package.json现使用与关于页一致的https://www.ineedfull.com；使用标准package:linux入口，不依赖一次性的extraMetadata覆盖。

远端npm10安装不能使用 `--replace-registry-host=always`：该选项会误写锁定的electron/node-gyp GitHub依赖地址。需要换registry时使用 `--replace-registry-host=never`，保留Git提交和锁文件完整性；网络慢时可用校验过的内容缓存续装，不改锁定版本。构建缓存变量 `INEED_ELECTRON_DIST` 仅用于构建，运行测试前清理该变量，避免测试环境影响命令参数断言。
