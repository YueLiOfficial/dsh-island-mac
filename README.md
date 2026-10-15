# dsh-island-mac

在 macOS 的**刘海 / 灵动岛**区域实时显示 DSH 任务的进度。

任务开始时它自动出现，结束时自动收起——**你不需要为了看到它而做任何事**。

```
            ╭──────────╮
   🐳  ⟢     │   42%    │     ← 刘海两侧：鲸鱼标识 + 完成百分比
            ╰──────────╯

   鼠标悬停时展开：
   ┌────────────────────────────────┐
   │ 任务进度                  42%  │
   │ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░  │
   │ 当前任务   运行测试             │
   └────────────────────────────────┘
```

## 特性

- **自动出现、自动收起**——不需要手动开关，也不占用 Dock 或菜单栏
- **两路进度来源**：DSH 的待办清单（自动精确）+ 步骤估算，无需模型配合
- **悬停显示当前任务**：从待办项或正在调用的工具推导出中文标签
- **绝不谎称完成**：显示值上限 90%，**100% 只在回合真正结束时出现**
- **失败可见**：异常结束（中断、报错）显示失败标记而不是 100%
- **无刘海机型可用**：降级为悬停浮层（行为差异见下）

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | macOS 13.0 或更高（实测于 macOS 26 / Apple Silicon） |
| 架构 | Apple Silicon 与 Intel 均可（辅助进程是 universal 二进制） |
| DSH | 需能加载 bundle 插件（自带 `dsh.bundle.patch`） |

## 安装

插件是一个 **dsh bundle**，安装走应用内的**插件管理器**（Plugin Manager → 添加插件）。
那个输入框接受包名、`.tgz` 压缩包路径或**本地绝对路径**。

### 方式一：从压缩包安装（推荐）

1. 下载本仓库的 Release 附件 `dsh-island-mac-<版本>.tgz`
2. 插件管理器 → 添加插件 → 填入该文件的绝对路径

包里已经带好编译后的 JS 与 universal 原生辅助进程，**不需要**额外构建。

### 方式二：从源码安装

```sh
git clone git@github.com:YueLiOfficial/dsh-island-mac.git
cd dsh-island-mac

npm install          # 或 bash scripts/install-deps.sh
npm run build        # 编译 lib/ + 构建原生辅助进程
```

然后在插件管理器里填入**本仓库根目录的绝对路径**。

⚠️ 从源码构建**需要完整 Xcode.app**（不是 Command Line Tools）——辅助进程依赖
DynamicNotchKit，而它是 SwiftUI 包，编译需要只随 Xcode 分发的 `SwiftUIMacros` 宏插件。
只用压缩包安装则没有这个要求。

### 装完确认一下

`apply()` 成功执行时做的第一件事就是写一个标记文件：

```sh
cat "$HOME/Library/Application Support/dsh-island/plugin-applied.json"
```

文件不存在 ⇒ 问题在**加载层**，不必去怀疑 socket 或渲染。
这是排查「插件没反应」最便宜的一步。

## 使用方法

**不需要任何操作。** 发一条消息、开始一个任务，灵动岛就会自己出现。

### 进度是怎么算出来的

| 阶段 | 来源 | 显示上限 |
|---|---|---|
| 估算 | 回合开始为 5%，每个步骤结束后递推 | 90% |
| 精确（自动） | DSH 的待办清单比例 | 90% |
| 精确（显式） | 模型调用 `report_progress` 工具 | 100% |

**关于 90% 与 100%**——这两个数字有严格区分，值得记一下：

| 显示 | 含义 |
|---|---|
| **90%** | 待办清单已勾完，**但回合还没结束**（可能仍在收尾）。不要派下一个任务。 |
| **100%** | 回合真的结束了，灵动岛随即收起。**这才是可以派下一个任务的时刻。** |

也就是说，闪烁的百分比**不是**"要不要继续等"的信号，**灵动岛收起**才是。

### 悬停看当前任务

把鼠标停在灵动岛上，面板会展开并显示一行「当前任务」，内容按以下优先级取：

1. 待办清单里**正在进行**的那一项（模型自己写的任务名，最准确）
2. 否则取当前正在调用的工具，例如：

| 工具 | 显示 |
|---|---|
| Bash（带描述） | `运行测试` |
| Bash（只有命令） | `执行命令：pnpm test` |
| 读/写/改文件 | `查看文件：src/a.ts` |
| 搜索 | `搜索内容：TODO` |
| 联网 | `搜索网页：…` / `抓取网页：…` |

多个待办同时标记为进行中时，取第一个。

### 什么时候会消失

- **正常结束**：显示 100% 后停留约 1.2 秒，然后收起
- **异常结束**（中断 / 报错）：显示失败标记，停留后收起——**不会**显示 100%
- **长时间无事件**：默认 120 秒没有任何更新就收起（可配置）
- **停在 5% 不动**：这通常是正常的。回合刚开始时是 5%，而估算只在**步骤结束**时推进。
  等待你输入、或模型长时间思考期间，5% 就是预期显示。

## 配置

在 profile 的 `cordis.patch.yml` 里通过 `config` 传入。

⚠️ **patch 是整行替换 `config` 而非深度合并**——覆盖任一项时必须把所有想保留的键一并写出。

| 键 | 默认值 | 说明 |
|---|---|---|
| `socketPath` | `~/Library/Application Support/dsh-island/island.sock` | 目录会被设为 `0700` |
| `helperPath` | `<包目录>/bin/DynamicIslandBridge` | 原生辅助进程 |
| `connectTimeoutMs` | `10000` | 等待辅助进程就绪的时长 |
| `idleTimeoutMs` | `120000` | 无更新多久后自动收起 |
| `graceMs` | `3000` | SIGTERM 后等多久升级为 SIGKILL |

## ⚠️ 无刘海机型的行为差异

在**没有**刘海的 Mac 上，DynamicNotchKit 会改用浮动面板样式，而该样式下"收起"等于隐藏窗口。
因此：

| 机型 | 行为 |
|---|---|
| 有刘海（MacBook Pro 14/16 等） | 刘海旁常驻百分比药丸，悬停展开，移开收起 |
| **无刘海** | **无法常驻药丸**，鼠标移入才展开；**移开不会收起**，一直显示到任务结束 |

「移开不收」是刻意的：否则鼠标一移开进度条就消失，反而更难用。这是上游库的固有限制。

## 故障排查

### 灵动岛不动，或悬停只显示「等待中」

按顺序查，每步排除一层：

```sh
# 1. 查看插件是否加载
cat "$HOME/Library/Application Support/dsh-island/plugin-applied.json"

# 2. 查看辅助进程是否启动
lsof -c DynamicIslandBridge | grep island
```

### 界面完全不动，但进程还在

已知故障：辅助进程**启动即死**。macOS 会因代码签名无效在 exec 时直接杀掉它
（每次约 16 毫秒），而构建时完全看不出来——症状就是"进程还在、但界面永远不动"。

```sh
# 判定（期望输出 valid on disk）
codesign --verify --verbose=2 "<包目录>/bin/DynamicIslandBridge"

# 修复
codesign --force --sign - --timestamp=none "<包目录>/bin/DynamicIslandBridge"
```

自己从源码构建的话，`scripts/build-helper.sh` 已经内置这一步，**不要删掉它**。

### 有残留的辅助进程霸占 socket

辅助进程是单客户端的：残留进程持着 socket 时，插件会连到它而新进程不断启动失败。
残留进程的 pid 通常比当前 DSH 进程更小。

```sh
lsof -t -c DynamicIslandBridge | xargs -r kill
```

清掉后插件会在下一次事件时自动拉起新的辅助进程，**不需要重启 DSH**。

## 卸载

在插件管理器里禁用或移除该 bundle。插件会把辅助进程一起停掉，不留残留进程。

## 开发

架构说明、构建细节、验证阶梯、通信协议等面向贡献者的内容记录在维护者本地的
`docs/DEVELOPMENT.md`（该目录不随仓库分发）。

```sh
npm test           # Node 原生跑 TypeScript，无需构建
npm run typecheck
npm run build      # 编译 lib/ + 构建并签名 universal 辅助进程
```

## 许可证与致谢

- 本插件基于 MIT 许可证，见 [LICENSE](LICENSE)
- 灵动岛渲染依赖 [DynamicNotchKit](https://github.com/MoonShotApp/DynamicNotchKit)（MIT）
- 第三方组件与商标说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

> 包内包含 DeepSeek 的鲸鱼标识，仅为标识任务来源；本项目与 DeepSeek 官方无隶属关系。
