# 第三方许可资料维护

[返回第三方声明](../../THIRD_PARTY_NOTICES.md) · [贡献指南](../../CONTRIBUTING.md)

## 重新生成

先按开发指南完成 `npm ci`。有 Tauri 的产品还需对应锁文件的 Cargo 缓存；本脚本不联网下载、不构建或运行桌面，也不修改依赖。**此文档维护脚本需要 Python 3.11+**（标准库 tomllib），这不是应用运行时要求。在仓库根目录执行：

```sh
python3 scripts/generate-third-party-notices.py
python3 scripts/generate-third-party-notices.py --check
```

如果系统 `python3` 较旧，显式使用已安装的 Python 3.11+。默认读取标准 `~/.cargo` 缓存；可通过 `CARGO_HOME` 指向已有缓存，不改写 HOME 等系统变量。生成结果因安装平台/缓存覆盖不同而可能变化，提交前审查新增或丢失的证据。

脚本输出 `third-party-inventory.json` 和 `third-party-license-texts.txt`。`--check` 只比较当前本地证据与现有文件，缺失或过期返回非零；它不表示全部许可义务已满足。缺少缓存时仍能生成清单，但未知项会进入 reviewRequired，不能将其作为通过许可审核的依据。

## 来源与字段

- npm 遍历根 `package-lock.json` 的第三方安装位置，排除自有 workspace 链接，保留同包不同版本/位置。读取已安装 package.json 时核对版本；不输出 resolved 下载地址、机器绝对路径或认证配置。
- Rust 遍历 `apps/tauri/src-tauri/Cargo.lock`，排除应用自身；本地 vendor 按原 Cargo.toml 读取，保留相对源码路径。注册表 `.crate` 缓存与锁文件 SHA-256 一致后才读取其元数据和原文，不解压写入文件系统。无可用缓存的条目保持未知。
- 标准 LICENSE/LICENCE/COPYING/NOTICE/COPYRIGHT 文件及 licenses 目录被收集；vendored Cargo 的显式 license-file 也会读取。README、源文件头、原生二进制内部声明以及所有嵌套子目录并未完整自动分析，需要人工补核。
- `licenseFiles[].sha256` 是来源文件原始字节的摘要；原文集按 UTF-8 解码并统一 LF 换行，所以原文集某段的重新编码摘要不一定等于来源摘要。锁文件摘要在 `lockfiles` 中记录。
- `developmentOnly`/`optional` 来自 npm 锁元数据，不代表已经确定安装包实际是否包含该组件。Rust 清单覆盖锁文件而非单个平台/feature 的最终链接图。
- 原许可表达式保持原样，不自动修正历史数组、斜线写法或选择双许可。缺少许可证元数据和缺少原文分别标记，不将未缓存的包判定为无许可。

## 发布前的复核

1. 按 `reviewRequired` 找到具体包/版本/安装位置，先区分本地证据缺失与上游确实缺少声明。
2. 从匹配版本的可信发布源码补齐许可原文、版权和 NOTICE；双许可选择与义务另作记录，不只依赖字段名。
3. 对 MPL/GPL/LGPL 等条件性义务，核对实际包含文件、修改与源码提供要求；保留 vendor 原始许可和改动归属。
4. 对实际目标平台的安装包复核 Electron/Chromium、Rust 以及其它原生组件声明，确保声明随分发物可取得。此步骤尚未自动接入打包脚本。
5. 人工确认新增素材、字体、图标和示例代码的来源；不要将本项目 Apache-2.0 覆盖到第三方文件。

本轮只维护本地文档、许可元数据与生成入口，未更改安装包内容、依赖版本或自动发布流程。后续公开前的 Git 历史与凭证审查仍需另行完成。
