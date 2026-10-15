# v0.2.0 发布说明

包名：**`dsh-island-mac`**
产物：`dsh-island-mac-0.2.0.tgz`（含编译后的 `lib/` 与 universal helper）

> 命名经过：原名 `dsh-dynamic-island-progress` → 简化为 `dsh-dynamic-island`
> → 该名在 npm 上**已被他人占用**（`yaoyaoyu` 的 `0.3.5`，一个 DSH Web GUI 插件）
> → 最终定为 **`dsh-island-mac`**（已确认可用）。本地仓库目录名始终保持
> `dsh-dynamic-island`，未变。

## 本次发布包含什么

### 新功能

**1. 悬停显示当前正在进行的任务**

鼠标停在灵动岛上时，展开面板底部多出一行「当前任务」。标签来源按优先级：

| 优先级 | 来源 | 例 |
|---|---|---|
| 1 | `todo/write` 里第一个 `in_progress` 项的 `content` | `修签名 bug` |
| 2 | 最近一次 `tool/call` 的工具名 + 关键参数 | `运行测试`、`查看文件：src/a.ts`、`搜索内容：TODO` |
| 3 | 本 build 不认识的工具 | `正在使用 <工具名>` |

`tool/call` **只更新标签，不碰百分比**：一次调用说明"在做什么"，不说明"做到哪儿了"。
标签按码点截断到 80（不切断 emoji）；缺省 `task` 不清空上一条，`turn/start` 与 `bye` 会清空。

**2. 100% 现在只有一个含义**

待办比例送入显示前封顶 90%（`src/events.ts`）。语义变成：

| 显示 | 含义 |
|---|---|
| **90%** | 清单已勾完，但回合还活着（可能仍在收尾）。**不要派下一个任务。** |
| **100%** | 只可能来自 `turn/end` completed。**这才是可以派下一个任务的时刻。** |

`todoRatio` 本身仍如实返回 `1.0`——它是对清单的观察，与显示值是两回事。

### 修复

**1. helper 启动即死（严重）**

SwiftPM 产出的二进制只带 `linker-signed` 的 CodeDirectory，macOS 26 的 taskgated 在 exec 时
拒绝它：每次 spawn 在 ~16ms 内 `SIGKILL (Code Signature Invalid)`。**构建时完全看不出来**，
要到下一次重启 helper 才暴露，症状是「进程还在但界面不动」。

`scripts/build-helper.sh` 现在在安装后显式 `codesign --force --sign -`，并保留原有的 `--version`
自检兜底。**不要删掉这一步。**

**2. 孤儿 helper 会阻止恢复**

helper 是单客户端的。残留进程持着 socket 时，插件会连到它而自己的子进程不断启动失败。
README 的「故障排查」记录了判定与恢复步骤（按 pid 大小识别孤儿 → `lsof -t -c
DynamicIslandBridge | xargs -r kill` → 插件会在下一次事件自动重拉 helper）。

**3. 打包校验脚本的硬编码包名**

`scripts/verify-packed-tarball.sh` 里有一条断言写死了旧包名，改名后**正确的包也会判失败**。
现已改为从 `package.json` 读取，并把 `dependencies` 与 `dsh.profile.bundles` 两项
拆成独立断言——只在前者登记而缺后者时，包能装上但**层不会被应用**，且不报任何错。

## 改名迁移（重要）

| 变化 | 旧 | 新 |
|---|---|---|
| npm 包名 | `dsh-dynamic-island-progress` | `dsh-island-mac` |
| bundle 层 id | `dynamic-island-progress` | `dynamic-island` |
| tarball | `dsh-dynamic-island-progress-0.1.0.tgz` | `dsh-island-mac-0.2.0.tgz` |

**已安装的用户必须重新挂载**，否则下次启动 DSH 时插件会按新名字解析失败而**静默消失**：

1. 插件管理器 → **移除** `dsh-dynamic-island-progress`
2. 插件管理器 → **添加**，填本地绝对路径或新 `.tgz`
3. 校验：

```sh
bash scripts/verify-rename-mount.sh
```

`cordis.patch.yml` 不用手改：包里的 `dsh.bundle.patch` 在登记为 bundle 时自动作为一层应用。

## 验证状态

| 项目 | 结果 |
|---|---|
| `npm test` | 85 / 85 通过 |
| `npm run typecheck` | 退出码 0 |
| Swift 测试 | 109 / 109 通过 |
| 打包内容校验 | `cordis.patch.yml`、`bin/`、`main → lib/index.js` 齐全 |
| helper 架构 | universal（x86_64 + arm64），两个 slice `minos` 均为 13.0 |
| 包内 helper 可运行 | 通过（真实打包产物，签名有效） |
| helper 自包含 | 通过（不依赖同目录 `.bundle`） |
| 端到端安装进一次性 profile | **未执行**——需要写 `~/.dsh/profiles/`，当前沙箱不允许 |

最后一项是本次发布**唯一未验证**的环节。它由 `bash scripts/verify-packed-tarball.sh --boot`
覆盖（打包 → 装进一次性 profile → 启动 headless → 确认模块真的加载），在正常终端里跑一次即可补齐。

## 环境

- dsh 运行时：`0.2.0-rc.2`
- 包版本：`0.2.0`
- macOS：声明下限 13.0；实测只在 macOS 26 / Apple Silicon 上跑过
- 仅支持 macOS（`os: ["darwin"]`）

## 关于两个版本号

**包版本与 helper 自报版本是两套独立命名空间，刻意不同步：**

| 版本号 | 当前值 | 位置 |
|---|---|---|
| npm 包版本 | `0.2.0` | `package.json` |
| helper 自报版本 | `0.1.0` | `Main.swift` 的 `bridgeVersion` |

helper 的版本只用于 `--version` 自检（构建脚本用它确认二进制能启动），
线上协议里**不携带**它，也不参与任何兼容性判断（协议版本是 `PROTOCOL_VERSION = 1`）。
改它需要重建 + 重签二进制并同步 Swift 测试，没有实际收益，所以本次未动。
