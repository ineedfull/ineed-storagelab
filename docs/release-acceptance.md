# StorageLab 1.0.0 发布前验收

2026-10-30最终五包和公开下载已补验，见[最新发布说明](releases/2026-10-30.md)。下文保留10月27日阶段记录，不代表最新发布状态。

日期：2026-10-27。验收采用隔离应用数据和一次性本地MinIO，未测试生产桶。本文件记录安装包与目标系统边界，首版功能回归另见 [verification.md](verification.md)。

## macOS 应用包与持久化

源提交 `c5c50a2914723bf00846b464e6072460f3113047`，构建时源码干净。标准入口 `npm run package:desktop:mac` 生成集合 `release/desktop/1.0.0-20261027T144713615Z-28d8066a/`；`npm run release:verify -- --dir=<集合>` 两件完整性通过。arm64/x64 DMG只读挂载，核对com.ineedfull.storagelab、1.0.0、Mach-O架构、app.asar。

arm64应用从DMG复制到 `artifacts/release-acceptance/installed/StorageLab.app`。在桌面解锁状态，忽略目录内的 `verify-real-package.mjs` 通过Node inspector启动断点在未修改的生产main之前设置临时appData；不修改asar，不加入生产测试入口，不使用mock-keychain。实际包Electron43.1.0/Node24.18.0/SQLite3.53.1，窗口可见且未最小化。

两个独立进程均通过：真实safeStorage可用；首进程加密保存连接和深色设置、请求真实MinIO；退出并同版替换后，次进程恢复连接/凭证/设置，再次完成真实S3请求。每轮公开bootstrap与SQLite/WAL/SHM均未包含测试AccessKey/SecretKey明文。截图关于信息已目视核对。临时appData和测试桶清理；未替换用户Applications目录，也没有旧正式版本，因此不代表跨版本升级。

重装源与DMG内app.asar摘要均为 `f611acb376229eb2aaccc0a6bc7f9c89d49b7fc9095146d228899ccd2c2f8cd0`。原始首轮测试曾因直接IPC保存后未刷新测试界面而定位超时，修正测试同步后两轮通过；此为测试脚本问题，生产逻辑未因此修改。先前锁屏/keychain等待和mock测试证据保留，不能替代本次真实keychain结果。

证据位于 `artifacts/release-acceptance/`：`real-package-result.json`、`real-package-round-{1,2}.png`、`dmg-inspection.json`、`reinstall-source.json`。重跑：

```sh
STORAGELAB_TEST_CONFIG=/私有回环测试配置.json node artifacts/release-acceptance/verify-real-package.mjs artifacts/release-acceptance/installed/StorageLab.app
```

macOSx64实际尝试执行返回errno86/Bad CPU type；本机没有可用的x64运行环境。DMG内容通过检查，Intel Mac运行、安装与资源表现仍需目标设备。

## 凭证授权提示与签名

StorageLab需要保护对象存储凭证，bootstrap会查询safeStorage可用性，可能触发macOS钥匙串授权。系统提示不是StorageLab登录密码，也不是MinIO帐号密码。未改变此触发时机；不能将关闭加密或明文落盘作为解决方案。

本机 `security find-identity -v -p codesigning` 返回0个有效身份。包未做Developer ID正式签名或公证，当前不提供Gatekeeper首次分发验收结论；ad-hoc或跳过签名不能替代正式签名。Windows正式签名同样未完成。

## 其他平台

Linux标准 `npm run package:linux` 已成功生成DEB/AppImage，集合 `1.0.0-20261027T152120647Z-19c7fae9`。源为c5c50a2加唯一的homepage元数据修正，清单诚实保留sourceDirty=true；未变更依赖或功能代码。Windows x64 NSIS已完成Wine交叉构建，集合 `1.0.0-20261027T152859269Z-0626ce9a`；仍使用c5c50a2+homepage修正并保留sourceDirty=true。标准release:build的宿主门禁未放开，Wine辅助构建单独标记。

Ubuntu24.04/x86_64、Node22.23.3上，完整npm测试73通过/1原Tauri条件跳过。实际Linux包Electron43.1.0/Node24.18.0/SQLite3.53.1在Xvfb下两轮启动通过，没有增加no-sandbox或mock-keychain参数。当前环境的safeStorage backend为basic_text，应用正确报告安全凭证库不可用，拒绝加密保存且未写出半条连接；明确选择session后真实S3访问成功。重启保留连接和深色设置、清除session凭证；未重填时S3返回CREDENTIALS_REQUIRED，明确重填后恢复访问。两轮公开状态/SQLite无测试密钥明文。此为虚拟X11显示，未代表物理桌面、系统钥匙串或系统安装器通过验收。

测试仅连接本机一次性MinIO，经绑定远端127.0.0.1的SSH反向隧道访问；没有使用146的生产MinIO帐号或桶。Linux包内UI/原生service按实际生产组合运行，CDP/Node启动断点仅用于隔离和自动化，不向生产代码添加测试接口。

DEB与AppImage解包后，包名/版本/amd64、ELFx64和StorageLab桌面入口通过，app.asar均为 `8fb131c393b08f299b4b5877f0f96219290f5827af4220ab6ea60aee5dec3a8c`。DEB提取后的可执行程序另跑上述两个进程并通过；截图已目视检查，证据本机 `artifacts/release-acceptance/linux/`。AppImage通过 `APPIMAGE_EXTRACT_AND_RUN=1 ELECTRON_RUN_AS_NODE=1` 实际运行内置Node，SQLite建表/写/读成功；未验证FUSE挂载或系统安装脚本。

## Windows Wine 验收

NSIS按真实格式解包，x64应用、包内app.asar和可执行文件均与打包目录摘要一致。Windows NSIS与Linux DEB/AppImage归档的app.asar均为上述8fb131c3摘要；生产main/vault/store/service与源文件一致，未包含本项目测试fixture、验收脚本或私有连接配置。安装器与应用PE证书表均为0，工具链“signing with signtool”日志不代表已有正式签名。

安装器提取出的真实StorageLab.exe在Wine9.0下实际运行内置Node24.18.0/Electron43.1.0/SQLite3.53.1，SQLite建表、写入和读取通过，退出码0。独立Wineprefix内执行NSIS静默安装、同版覆盖重装、卸载均通过：安装可执行文件字节与原payload一致，生成的SQLite哨兵文件在重装/卸载后字节不变且quick_check=ok，卸载移除主程序。这里使用生成的哨兵文件检验安装器数据保留，不冒称Windows真实业务配置、DPAPI或GUI已经验收。

证据已回收到本机 `artifacts/release-acceptance/windows/`，包括 `windows-inspection.json`、`resource-checks.json`、`wine-runtime.json`、`wine-installer.json`、标准清单与最终完整性日志。测试专用Wine进程已停止。

## 五件产物与剩余验收

具体文件名、大小、SHA-256、源码状态及存放地址见[产物索引](release-acceptance-artifacts.json)。macOS两DMG保留在本仓库release/desktop；Linux/Windows三个文件另保存至146的独立 `/home/miz/ineed-tools-builds/ineed-storagelab/<buildId>/`，复制后再次通过release:verify，未作为MinIO下载对象发布。没有公开下载URL。

| 平台 | 本轮已验证 | 仍需对应条件 |
| --- | --- | --- |
| macOS arm64 | DMG/身份/实际包启动、真实钥匙串跨进程恢复、隔离同版替换 | Developer ID/公证/Gatekeeper首次分发、真实跨版本升级 |
| macOS x64 | DMG/身份/架构/完整性 | Intel Mac运行与安装；本机errno86 |
| Linux x64 | DEB/AppImage构建/资源、DEB提取后Xvfb两轮、会话凭证边界、AppImage免FUSE内置SQLite | 系统dpkg安装脚本、FUSE挂载、物理桌面、安全凭证库 |
| Windows x64 | NSIS Wine构建/资源、真实payload SQLite、Wine安装/同版重装/卸载哨兵保留 | Windows实机GUI/DPAPI/系统文件选择器、Authenticode签名、真实业务数据升级 |

本机与Linux全量基础回归均73通过/1原Tauri条件跳过，收尾发布回归18通过/1原跳过。测试桶最终为0，临时appData、测试服务、SSH隧道和一次性MinIO配置已清理。现有业务代码、依赖锁和钥匙串提示时机未改动。

## 发布边界

本轮构建和验收不执行MinIO上传、公开策略、官网接入或自动更新feed修改。下载地址仅在实际授权上传并回读核对后生成。
