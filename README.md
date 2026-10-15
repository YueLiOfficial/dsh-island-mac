# dsh-dynamic-island-progress

在 macOS 灵动岛 / 刘海区域显示当前 DSH 任务的完成百分比。

插件监听 DSH 的会话事件推导进度，通过 Unix socket 把进度推给一个原生 Swift 辅助进程，
由它渲染灵动岛。辅助进程没有主窗口、没有 Dock 图标，随插件生命周期启动和终止。

## 架构

```
┌──────────────────────────────────────────────┐
│ DSH 进程                                      │
│   插件 (TypeScript)                           │
│     index.ts     装配 / 单个 ctx.effect 生命周期 │
│     progress.ts  进度状态机                    │
│     events.ts    session/event 规约            │
│     transport.ts Unix socket 客户端            │
│     helper.ts    子进程 spawn / dispose        │
│     tool.ts      report_progress 工具          │
│     instructions.ts  systemPrompt 注入         │
└─────────────┬────────────────────────────────┘
              │ NDJSON over Unix socket
              │ 插件 = client    辅助进程 = server
              ▼
┌──────────────────────────────────────────────┐
│ Swift 辅助进程（DynamicNotchKit）              │
│   bind + listen，收到进度即更新灵动岛           │
└──────────────────────────────────────────────┘
```

**为什么辅助进程是 server**：它是容易重启的一方。让稳定的插件做重连方，
失败处理比反过来简单——客户端断开后 server 只需回到 `accept`，不必退出。

## 安装

### 装给别人用（正常路径）

插件是一个 **dsh bundle**，所以安装走应用内的**插件管理器**（Plugin Manager → 添加插件），
**不需要手改任何 profile 文件**。那个输入框接受包名、Git 地址、`.tgz` 压缩包，
或**本地绝对路径**；发布流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

### 从本仓库开发

```sh
# 1) 安装依赖（npm cache 会重定向到工作区内，因为 ~/.npm 可能不可写）
bash scripts/install-deps.sh

# 2) 构建（需要完整 Xcode，见下）：编译 lib/ + universal helper
bash scripts/build-bundle.sh

# 3a) 推荐：把仓库根目录的 .tgz 填进插件管理器 → 添加插件
node /path/to/pnpm.mjs pack      # 或直接 npm run build && npx pnpm pack

# 3b) 或把本仓库的绝对路径填进去（**必须先 npm run build**，
#     本地目录安装不会跑 prepack，缺 lib/ 会 failed to import）
```

⚠️ **不要**手工往 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加插件行 —— 那条路
不可能生效（profile 层的插件行按包名从 profile 的 `node_modules` 解析，而包还没被安装），
而且 `desktop` profile 由桌面应用独占管理，CLI 会直接拒绝操作它。
完整解释见 [scripts/mount-patch.md](scripts/mount-patch.md)。

**装完先看这一个文件**，它是排查「插件没反应」最便宜的一步：

```sh
cat "$HOME/Library/Application Support/dsh-island/plugin-applied.json"
```

`apply()` 的第一件事就是写它。文件不存在 ⇒ 问题在加载层，不必怀疑 socket / helper / 渲染。

### 关于 Xcode

Swift 辅助进程依赖 DynamicNotchKit，而它是 SwiftUI 包——编译需要 `SwiftUIMacros`
宏插件，该插件**只随完整 Xcode.app 分发**，Command Line Tools 里没有。

```sh
# 确认 Xcode 已就位
ls -d /Applications/Xcode.app && \
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

`xcode-select --install` **不能**装 Xcode，它只装 Command Line Tools。

### 没有 Xcode 时的行为

辅助进程二进制不存在时，插件**仍会正常加载**，只是不会显示灵动岛，日志中会给出明确原因：

```
island: helper not reachable at <socket> (binary: <path>).
Progress will not be displayed. Build it with the Swift layer, or set helperPath.
```

这是刻意的降级设计：缺一个可选的 UI 组件不该影响 DSH 其余功能。

## 进度语义

| 阶段 | 来源 | 上限 |
|---|---|---|
| 估算 | `turn/start` 起 5%，`step/end` 递推 | **硬上限 90%** |
| 精确 | `todo/write` 的加权比例；或 `report_progress` 工具 | 100% |

- **估算永不越过 90%**：把 90→100 留给真实终态，使估算层在结构上无法"谎称完成"。
- **显示值单调不减**。唯一例外是正常完成时跳到 100%。
- **状态机单向**：进入精确模式后不再回落到估算，避免双数据源抖动。
- **异常终态不显示 100%**：`aborted` / `error` / `interrupted` / `max-tokens` / `blocked`
  显示当前值加失败标记，而不是 100%。把中断显示成完成是明确误导。

### 两种精确来源

1. **`todo/write`（自动）** —— 事件携带整表替换的待办列表，因此比例天然可信。
   公式为 `(completed + 0.5 × in_progress) / total`，而不是 `completed / total`：
   后者的全部信息是"尚无一项完成"，无法区分"刚开始"与"马上做完第一项"，
   会在模型满负荷工作时显示 0%。一旦有项完成，两个公式结果一致。

2. **`report_progress`（显式）** —— 工具由 `systemPrompt` 段落引导，
   仅在你确知更准的完成度、或单个长步骤会让进度停滞时才应调用。

## ⚠️ 无刘海机型的行为差异

DynamicNotchKit 在无刘海的 Mac 上使用 `.floating` 样式，而该库的 compact 路径在
floating 样式下会直接隐藏窗口（源码 `_compact()` 中的
`if effectiveStyle(for: screen).isFloating { await hide(); return }`）。

因此：

| 机型 | 行为 |
|---|---|
| 有刘海（如 MacBook Pro 14/16） | 刘海中常驻百分比药丸，hover 展开详情，移开收起 |
| **无刘海** | **无法常驻药丸**，降级为 hover 展开的浮层；**移开不会收起**，浮层保持展开直到任务结束收起 |

无刘海机型上「移开不收」是刻意的：库的 floating 样式下 `compact()` 等于隐藏窗口，
所以插件在无刘海屏上**忽略** hover 移出事件（见 `NotchPresenter.hoverChanged`）。
代价是一个常驻的浮层，好过一个鼠标移开就消失的进度条。

这是 DynamicNotchKit 的固有限制，不是本插件的缺陷。

## 配置

在 profile 的 `cordis.patch.yml` 中通过 `config` 传入。**注意 patch 是整行替换
`config` 而非深度合并**——覆盖任一项时必须把所有想保留的键一并写出。

| 键 | 默认值 | 说明 |
|---|---|---|
| `socketPath` | `~/Library/Application Support/dsh-island/island.sock` | 目录会被设为 `0700` |
| `helperPath` | `<包目录>/bin/DynamicIslandBridge` | 辅助进程可执行文件 |
| `connectTimeoutMs` | `10000` | 等待辅助进程 bind 并连接的时长 |
| `idleTimeoutMs` | `120000` | 无进度更新多久后自动收起灵动岛 |
| `graceMs` | `3000` | SIGTERM 后等多久升级为 SIGKILL |

## 通信协议

NDJSON：每行一个 JSON 对象，UTF-8。插件 → 辅助进程方向：

| type | 字段 | 含义 |
|---|---|---|
| `hello` | `version` | 连接建立后的握手 |
| `progress` | `percent`（0..1）、`mode`、`message?` | 更新进度 |
| `done` | `reason`、`ok` | 终态；`ok:false` 表示异常结束 |
| `bye` | — | 收起并等待下一次连接 |

接收端必须容忍半包与粘包：帧可能被拆到多次 `read`，也可能一次到达多帧。

## 验证阶梯

| # | 动作 | 通过判据 |
|---|---|---|
| 1 | `npm test` | 全部测试通过 |
| 2 | `npm run typecheck` | `tsc` 退出码 0 |
| 3 | 构建辅助进程 | 产出可执行文件 |
| 4 | `swift test --disable-sandbox --package-path swift/DynamicIslandBridge` | Swift 侧 80 条全绿 |
| 5 | `node scripts/e2e-real-helper.mjs` | 真插件源码驱动真二进制：窗口出现、优雅退出、无孤儿、空闲超时生效 |
| 6 | 手工运行辅助进程 | `lsof -U \| grep island.sock` 显示监听 |
| 7 | 推一条消息 | 见下 |
| 8 | `dsh --profile desktop --dump-config \| grep -i dynamic-island` | 出现该层 |
| 9 | 检查 fiber 状态 | **不是 `PENDING`**（inject 服务缺失会静默 PENDING） |
| 10 | 跑一个真实任务 | 岛在 turn 开始出现、step 递增、结束收起 |
| 11 | **卸载插件** | `pgrep -f DynamicIslandBridge` 无输出 |

第 7 步：

```sh
echo '{"type":"progress","percent":0.42,"mode":"precise"}' | nc -U \
  "$HOME/Library/Application Support/dsh-island/island.sock"
```

第 11 步是唯一能证明清理逻辑正确的测试：

```sh
bash scripts/verify-teardown.sh
```

⚠️ **不要**用 `bash scripts/verify-teardown.sh DynamicIslandBridge` 当作第 11 步。那条命令跑的是
**假 helper**（Node 写的 `fake-helper.mjs`），断言 `pgrep` 找不到真二进制属于同义反复；
更糟的是 `pgrep -f` 会匹配到调用它的那个 shell 自己（命令行里就含这个字符串），
结论随调用方式而变。真正的第 11 步是第 5 步的 `scripts/e2e-real-helper.mjs`：
它从 helper 自己打印的启动行里解析 pid，用 `kill(pid, 0)` 判定存活，
并断言 socket 文件**已被删除**——SIGKILL 路径不可能删除它，所以这一条恰好把
「优雅 SIGTERM」与「超时升级为 SIGKILL」区分开。

## 开发

```sh
npm test          # node --test，Node 24 原生跑 .ts，无需构建
npm run typecheck # 仅类型检查（noEmit）
```

开发时可以用 Node 写的假辅助进程替代 Swift 版本（真 Unix socket server，
同样遵循 NDJSON 契约）：

```sh
node scripts/fake-helper.mjs /tmp/island-dev.sock
```

它的诊断输出走 **stderr**（不是 stdout）：插件 spawn 辅助进程时刻意把 stdout 设为
`ignore`——未被排空的 stdout 管道会在写满后阻塞辅助进程，导致进度静默冻结。
所以任何写到 stdout 的内容都会被丢弃。

然后用 `--patch` overlay 把 `config.socketPath` 指到该路径即可端到端联调。

## 许可证

插件本体未指定许可证。DynamicNotchKit 为 MIT。
