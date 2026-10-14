# DSH 灵动岛进度插件 — 设计规格

日期：2026-10-14
状态：待评审

## 1. 目标与成功判据

在 macOS 刘海/灵动岛区域实时显示当前 DSH 任务的完成百分比。

**成功判据**

1. 任务开始时岛出现，任务结束时收起，空闲时完全不可见。
2. 显示值单调不减，估算阶段绝不声称 100%。
3. 任务代码可通过 `report_progress` 工具上报精确值，且上报后不再被估算值拉低。
4. 有刘海与无刘海机型都能正常显示。
5. **插件卸载后无孤儿进程**（`pgrep -f DynamicIslandBridge` 无输出）。
6. 辅助进程在用户视角中不可见（无 Dock 图标、无菜单栏、不抢焦点）。

**非目标（YAGNI）**

- 多会话并发显示。同一时刻只跟踪**一个**会话（最近活动的）。
- 历史进度回放、进度持久化。
- Windows/Linux 支持。

## 2. 已实测的环境事实

这些是本次勘察实测结果，不是假设，直接约束实现。

| 事项 | 实测值 |
|---|---|
| 机型 | Apple M5，macOS 26.6.2 (25G83)，arm64 |
| 屏幕 | 内置 Liquid Retina，frame 1470×956pt |
| 刘海几何 | `safeAreaInsets.top = 32`，`auxTopLeft = 646`，`auxTopRight = 645` → **刘海 179×32pt** |
| `$DSH_HOME` | `/Users/yueli/.dsh` |
| profile | `desktop`，Web GUI `http://127.0.0.1:19387` |
| Xcode | **缺失**，只有 `/Library/Developer/CommandLineTools` |
| Swift | 6.4 (swiftlang-6.4.0.34.1)，目标 arm64-apple-macosx26.0 |

### 2.1 三个已验证的工具链坑（必须处理）

**坑 1 — SwiftUIMacros 缺失（阻断性）**

`SwiftUIMacros` 宏插件只随 Xcode.app 分发。CLT 的 `usr/lib/swift/host/plugins/` 只有 `libObservationMacros.dylib` 和 `libSwiftMacros.dylib`。全盘搜索确认系统内不存在 `SwiftUIMacros`。

实测证据：

| 测试 | 结果 |
|---|---|
| `swiftc -sdk MacOSX27.0.sdk` + AppKit | ✅ 编译链接运行 |
| SwiftUI，无宏 | ✅ 编译 |
| SwiftUI + `@State` | ❌ `plugin for module 'SwiftUIMacros' not found` |
| DynamicNotchKit 1.1.0 / 1.0.0 / 0.1.0 | ❌ **全部**使用 `@State`/`@ObservedObject` |

降级无法解决。**必须安装完整 Xcode。**

注意：`xcode-select --install` **不能**安装 Xcode，它只装 Command Line Tools（本机已有）。必须从 App Store 或 developer.apple.com 获取 Xcode.app。

**坑 2 — `swift build` 被沙箱挡住**

在 DSH agent 沙箱内，SwiftPM 通过 `sandbox-exec` 编译 `Package.swift` manifest，被拒绝：

```
error: Invalid manifest ... sandbox-exec: sandbox_apply: Operation not permitted
```

解法：`swift build --disable-sandbox`，并把 `HOME` 重定向到工作区内（否则 SwiftPM 缓存写入 `~/Library/org.swift.swiftpm` 也被拒）。

**注意**：此坑是 DSH agent 沙箱特有的。用户在自己的终端里正常构建不会遇到，但构建脚本保留该参数无副作用。

**坑 3 — 工具链与默认 SDK 版本不匹配**

编译器 6.4.0.34.1 vs SDK 6.4.0.31.4，直接调用 `swiftc` 会失败：

```
error: failed to build module 'Swift'; this SDK is not supported by the compiler
```

解法：显式指定匹配的 SDK，例如 `-sdk /Library/Developer/CommandLineTools/SDKs/MacOSX27.0.sdk`。SwiftPM 会自动选对，只有裸 `swiftc` 需要注意。装 Xcode 后此坑应自行消失，但脚本中保留显式 SDK 更稳。

## 3. 架构

```
┌──────────────────────────────────────────────┐
│ DSH 进程                                      │
│  ┌────────────────────────────────────────┐  │
│  │ 插件 (TypeScript)                       │  │
│  │  index.ts    装配 / ctx.effect 生命周期  │  │
│  │  progress.ts 状态机                     │  │
│  │  bridge.ts   socket client + spawn     │  │
│  │  tools.ts    report_progress           │  │
│  └────────────┬───────────────────────────┘  │
│               │ ctx.on('session/event')       │
└───────────────┼──────────────────────────────┘
                │ NDJSON over Unix socket
                │ (plugin = client, helper = server)
                ▼
┌──────────────────────────────────────────────┐
│ Swift 辅助进程 (server)                       │
│  bind + listen on island.sock                │
│  accept → 解析 NDJSON → 更新 DynamicNotch     │
│  客户端断开 → 回 accept，不退出                │
└──────────────────────────────────────────────┘
```

**角色分工**（按需求方指定）：

- **Swift helper = server**：bind + listen。helper 是易重启的一方。
- **插件 = client**：connect + 推送进度。
- socket 路径：`~/Library/Application Support/dsh-island/island.sock`，目录权限 `0700`。
- helper 启动时先 `unlink` stale socket，再 bind。
- 插件写失败 → 关闭连接 → 重新 spawn → 重新 connect。进度消息本身即心跳，不做独立心跳。

## 4. 进度模型（状态机）

### 4.1 事件锚点

**关键事实**：`turn/start`、`step/end`、`turn/end` 等**不是 Cordis 事件名**。知识库
`site/develop/framework/events.md:107-109` 明确：

> `turn/*`、`step/*`、`tool/call`、`tool/result` 和 `compaction/*` 是持久化的会话事件类型，不是同名 Cordis 事件。需要观察它们时，监听 `session/event` 并检查 `event.type`。

因此采用**单个** `session/event` 订阅并分发 `event.type`。

| 事件 | payload | 用途 |
|---|---|---|
| `turn/start` | `{ turn }` | 显示 5%，进入 `estimated` |
| `step/end` | `{ turn, step }` | 单调递推估算 |
| `todo/write` | `{ todos: TodoItem[] }` | **真实分子分母**，进入 `precise` |
| `turn/end` | `{ turn, reason }` | 终态 |
| `report_progress` | 工具参数 | 进入 `precise` |

`todo/write` 是唯一自带精确比例的锚点：`TodoItem.status ∈ pending|in_progress|completed`，
事件携带**整表替换**（last-write-wins，可安全重放），故比例计算天然可信。
凡走 todo 的任务自动获得精确进度，无需模型配合。

**todo 比例公式：`(completed + 0.5 × in_progress) / total`**（不是 `completed / total`）。

理由：`completed/total` 的全部信息是"尚无一项完成"，无法区分"刚开始"与"马上做完第一项"。
在 0 completed / 5 in_progress / 10 total 这种状态下，`c/t` 给出 0.00 而加权版给出 0.25 —— 前者在模型正密集工作时显示 0%，观感是"卡住了"。一旦有项完成两者趋于一致
（3/4 与 (3+0)/4 相同），所以加权只影响早期阶段，风险面很小。

已知代价：模型可能同时把多项标记 `in_progress` 却只专注一项，此时加权版会高估。
这是可接受偏差（`c/t` 的低估更常见也更糟）；若高估明显，把 `0.5` 调小即可。

**`todo/write` 不在核心 `dsh-session` 类型里** —— 它由 `tool-todo` 包做声明合并添加。
因此读取它必须做**运行时形状校验**，不能假设静态类型存在。（实测：
`@deepseek-ai/dsh-session@0.2.1-alpha.2` 的 `SessionEventMap` 中无 `todo/write` 键。）

**必须避免的两个近似名陷阱**：

- `tools/result`（复数，Cordis）vs `tool/result`（单数，持久化）
- `goal/changed`（Cordis）vs `goal/change`（持久化）

切换 `event.type` 时**禁止** `assertNever` —— `SessionEventMap` 是可声明合并扩展的
（`session.md:296`），别的插件可能追加类型。

### 4.2 估算公式

`step` **不是从 1 连续递增**的：单步子代理委派会让编号跳跃（本会话观察到 4、6、7、9、10）。
因此不做 `step / N` 线性假设，改用**有界渐近爬升**，只利用 step 的单调性：

```
estimate(step) = min(90, 5 + 85 * step / (step + 6))
```

取值：step=1→17%，5→44%，10→58%，20→70%，渐近 90%。

**永不越过 90%**，把 90→100 留给 `turn/end`。这样估算层在结构上就无法声称完成，
100% 只可能来自真实终态。

单调性由状态机保证（`next = max(current, estimate)`），不依赖公式。公式可替换。

### 4.3 状态机

```
idle ──turn/start──▶ estimated ──report_progress / todo/write──▶ precise
                          │                                        │
                          └──────────── turn/end ─────────────────┘
                                           ▼
                                         done
                                           │
                        ┌──────────────────┴──────────────────┐
                        ▼                                     ▼
              reason=completed                     reason ∈ {aborted, error,
              显示 100% → 收起                      interrupted, max-tokens}
                        │                            显示当前值+失败标记 → 收起
                        └──────────────┬──────────────────────┘
                                       ▼
                                      idle
```

`done` 之后的分支细节见 §4.4。

**不变式**（实现为断言 + 单元测试）

1. `estimated → precise` 单向，`precise` 永不回落到 `estimated`。
2. 显示值单调不减。唯一例外是 `turn/end` 直接跳 100。
3. `precise` 值不被 heuristic 拉低。
4. 空闲超时（默认 120s 无事件）→ 收起 → `idle`。

### 4.4 异常终态

`turn/end` 的 `reason` 来自可扩展的 `TurnEndReasonMap`：
`completed | aborted | blocked | error | max-tokens | interrupted | forked`。

- `completed` → 100%，收起。
- `aborted` / `error` / `interrupted` / `max-tokens` → **不显示 100%**，
  显示当前值 + 失败标记后收起。

把中断显示成 100% 是明确误导，必须区分。

### 4.5 `report_progress` 如何被 agent 发现（否则它是死代码）

**问题**：注册一个工具**不会**让模型知道该在何时调用它。工具 schema 只声明"有这么一个函数、参数是什么"，不包含"在你的任务里什么时候该用它"。若只注册工具而不注入指令，`report_progress` 会表现为死代码——测试全绿、工具对模型可见，但 `estimated` 永不转 `precise`，实际只有启发式在工作，精确模式**永不触发**。这是本设计最可能的静默失效模式。

**机制**（已核实，`site/reference/subsystems/system-prompt.md`）：

```ts
section(section: PromptSection): () => void
```

- `PromptSection = { name, order, text, interpolate?, complete? }`；按 `order` 升序排列。
- 返回**就是** Cordis effect disposer，随插件卸载自动注销。
- 插件需在 `inject` 中声明 `'systemPrompt'`，否则该服务为 `undefined` 且插件静默停在 `PENDING`。

**为什么用 `section` 而不是 `context`**：`ctx.systemPrompt.context()` 注册的是**动态 runtime context**，会作为 user-role 快照写入保留的模型历史。静态行为指导属于 system prompt；更重要的是，把当前进度值持续喂给 agent 会让它观察到自身造成的数值变化，可能触发反复上报的自我反馈循环。**本插件只用 `section`，不使用 `context`。**

**注入内容必须包含**：

1. 存在一个进度指示器，会**自动**在任务开始时出现、结束时收起 —— agent 无需任何仪式性调用。
2. 系统会**自动估算**进度（基于步骤与待办列表），多数任务无需干预。
3. 调用 `report_progress` 的两个**可选**时机：agent 自己知道比估算更准的完成度；任务进入长时间单步、进度条会停滞。
4. `percent` 是 **0..1 小数**（不是 0..100）。
5. 不要每一步都上报 —— 那会与 `todo/write` 的自动精确比例重复，并制造噪声。

**实现细节**：`order` 用 `900`（落在核心段落之后，`name` 带插件前缀避免同名冲突）。
知识库未枚举 `PromptSectionOrderName` 的成员，但 `order` 就是普通 `number`，
第三方插件可直接给值（`getSectionOrder()` 仅用于解析仓库自有段落的集中分配，非强制）。

## 5. Swift 辅助进程

### 5.1 依赖与形态

- DynamicNotchKit（MIT），SPM 依赖，需 macOS 13+。
- 无主窗口：`NSApplication.shared.setActivationPolicy(.accessory)` —— 运行时设置，
  **不需要 Info.plist 的 LSUIElement**（SwiftPM 可执行文件没有 .app bundle，
  走运行时 API 更可靠）。
- 窗口用库内置的 `DynamicNotchPanel`（`.borderless + .nonactivatingPanel`），不抢焦点。

### 5.2 显示形态：常驻百分比药丸 + hover 展开

按需求：**compact 态常驻显示百分比**，hover 时展开显示进度条与消息。

```swift
DynamicNotch(style: .auto, expanded: {
    VStack { ProgressView(value: p); Text("\(Int(p*100))%"); Text(message) }
}, compactLeading: {
    EmptyView()          // 或任务图标
}, compactTrailing: {
    Text("\(Int(p*100))%")   // 常驻药丸
})
```

**hover 展开需自行实现**：已核实库的 `.onHover` 只做 `keepVisible` /
`hapticFeedback` / `increaseShadow`（`DynamicNotchHoverBehavior.swift`），
**不会自动展开**。故 helper 自己监听 hover → `await notch.expand()`，
移出 → `await notch.compact()`。库的 `keepVisible` 会防止 hover 期间被收起，正好配合。

**无刘海机型差异（必须接受）**：`style: .auto` 在无刘海屏切 `.floating`，而
`_compact()` 内 `if effectiveStyle(for: screen).isFloating { await hide(); return }`
—— **floating 不支持 compact，调用 `compact()` 等于隐藏窗口**。

因此无刘海机型上「常驻药丸」不可行，降级为：**hover 触发的展开浮层**，
非 hover 时收起。这是 DynamicNotchKit 的固有限制，代价已确认可接受。

### 5.3 协议（NDJSON，每行一个 JSON 对象）

| type | 字段 | 行为 |
|---|---|---|
| `progress` | `percent: number (0..1)`, `mode: 'estimated'\|'precise'`, `message?: string` | 更新药丸数值；首次显示走 `compact()`；仅在收到 `message` 时 `expand()` |
| `done` | `reason: string`, `ok: boolean` | `ok: true` → 药丸短暂显示 100% 后 `hide()`；`ok: false` → `expand()` 显示失败标记，停留 ~1.2s 后 `hide()` |
| `bye` | — | `hide()`，回 accept 等待 |

`percent` 上限保护：接收端 clamp 到 `0...1`，非有限值丢弃并记日志。

**显示态与进度解耦**：`progress` 默认维护药丸（compact），**不**因为进度更新就展开。
展开只由两个条件触发——hover，或 `done` 且 `ok: false` 的失败提示。
失败时需要 `expand()` 是因为 floating 样式下 compact 等于隐藏（§5.2），
仅靠药丸无法在无刘海机型上传达失败。

### 5.4 Server 侧

```swift
// 1) 若 socketPath 已存在 → unlink（清 stale）
// 2) socket(AF_UNIX) + bind + listen，目录 0700
// 3) accept 循环；连接断开 → 回 accept，不退出
```

单客户端语义：同时只服务一个连接。新连接到来时替换旧连接（容忍插件重启）。

## 6. 插件侧进程管理

### 6.1 启动顺序

1. 确保 `~/Library/Application Support/dsh-island/` 存在，权限 `0700`
   （知识库防御规范要求私有目录，避免可预测路径的符号链接竞态）。
2. `spawn` helper：`detached: true`（POSIX 独立进程组）、
   `stdio: ['ignore', 'pipe', 'pipe']`、**擦洗过的**环境变量
   （丢弃匹配 `*KEY*` / `*SECRET*` / `*TOKEN*` / `*PASSWORD*` 的键）。
3. 轮询 `connect` 直到成功或超时（默认 10s）—— helper 需要几百毫秒 bind。
4. 转发 helper stderr 到 `ctx.logger`，便于定位崩溃。

   API 形态注意：`ctx.logger` 是**可调用**的服务（`context.md:136-143`，
   `logger: LoggerService`，"调用 `ctx.logger(name)` 可获取具名 logger"），
   **不是**日志对象。正确写法 `const log = ctx.logger('dynamic-island-progress')`
   然后 `log.info(...)`，或防御性写法 `ctx.logger?.(name)?.info?.(...)`。
   写成 `ctx.logger.info(...)` 是错的。

### 6.2 清理：唯一 `ctx.effect`，必须 await 退出

**两条知识库硬约束**

`site/develop/framework/index.md:66`：

> 插件卸载时，处置器按注册顺序的逆序开始调用，但**多个异步处置器会并发执行**，
> 不保证逐个完成。存在顺序依赖的清理步骤必须放进**同一个** `ctx.effect()` 返回的
> 处置器中，由该处置器负责串行等待。

`extra/defensive-patterns.md:21`：

> 清理流程只发出终止或中止信号便返回，而不等待工作真正停止，就会留下孤儿进程。
> 清理逻辑应采用异步流程，并**等待子进程退出**（发出终止信号后等待 `done`），
> 还应在终止进程前关闭监听器注册表和通知注册表，使迟到的完成事件保持静默。

**因此**：全部 teardown 放在**一个** async disposer 内，顺序为

```
1. 关闭连接、清空计时器、标记状态机为 disposed（迟到事件静默）
2. SIGTERM
3. 等待 'close' 事件
4. 超时（默认 3s）升级 SIGKILL，再次 await 'close'
5. 才允许返回
```

拆成两个 effect（一个 kill、一个 await）会在并发 disposer 下产生孤儿进程。

## 7. 文件布局

```
dynamic-island-progress/
├── package.json              dsh.bundle 声明
├── cordis.patch.yml          挂载层
├── tsconfig.json
├── src/
│   ├── index.ts              apply(ctx, config)：装配
│   ├── progress.ts           状态机
│   ├── bridge.ts             socket client + 进程生命周期
│   └── tools.ts              report_progress
├── swift/DynamicIslandBridge/
│   ├── Package.swift         DynamicNotchKit 依赖
│   └── Sources/DynamicIslandBridge/
│       ├── main.swift        入口 + accessory 策略
│       ├── SocketServer.swift  bind/listen/accept
│       ├── Protocol.swift    NDJSON 解码
│       └── NotchController.swift  DynamicNotch 驱动 + hover
├── scripts/
│   ├── build-helper.sh       带三个坑的规避
│   └── verify-teardown.sh    孤儿进程验证
└── test/
    └── progress.test.ts      状态机不变式
```

## 8. 插件骨架要点

**绝对不能 `export default`。** 知识库事故复盘 0001
（`extra/postmortem/0001-acp-default-export-drops-inject.md:39-54`）记录了这个静默故障：
`Loader.unwrapExports` 执行 `exports.default ?? exports`，一旦存在 default export，
模块被折叠成裸函数，`inject`/`name`/`Config` **全部丢失**，插件带空 inject 启动后崩溃。
且 `ctx.plugin(obj)` 手工挂载永远复现不了，只有真实 Loader 才暴露。

```ts
export const name = 'dynamic-island-progress'
export const inject = ['tools']
export interface Config { /* ... */ }
export const Config: Schema<Config> = Schema.object({ /* ... */ })
export function apply(ctx: Context, config: Config) { /* ... */ }
// 没有 export default
```

**patch 语义**：patch 是**整行替换 `config`，不是深度合并**
（`publish.md:132`）。config 全给默认值，用户通常无需改动。

## 9. 安装、构建、验证

### 9.1 前置（用户手动，需 sudo，我无法代做）

1. 从 App Store 或 developer.apple.com 安装完整 Xcode。
2. `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
3. `sudo xcodebuild -license accept`
4. 验证宏可用：
   `echo 'import SwiftUI; struct V: View { @State var x = 0; var body: some View { Text("\(x)") } }' > /tmp/t.swift && xcrun swiftc -parse-as-library -c /tmp/t.swift -o /tmp/t.o && echo MACROS_OK`

### 9.2 构建 helper

```sh
# 规避坑 2 与坑 3；装完 Xcode 后这些参数无害
export CLANG_MODULE_CACHE_PATH="$PWD/.swift-cache"
export SWIFT_MODULECACHE_PATH="$PWD/.swift-cache"
swift build -c release --disable-sandbox --package-path swift/DynamicIslandBridge
```

### 9.3 验证阶梯

| # | 动作 | 通过判据 |
|---|---|---|
| 1 | 构建 helper | 产出可执行文件 |
| 2 | 手工跑 helper | `lsof -U \| grep island.sock` 显示监听 |
| 3 | 推一条消息 | `echo '{"type":"progress","percent":0.42,"mode":"precise"}' \| nc -U <sock>` → 刘海出现 42% |
| 4 | helper 重启容忍 | kill helper 后插件自动重连并恢复显示 |
| 5 | `dsh --profile desktop --dump-config` | 输出含 `# == dsh-dynamic-island-progress` 层 |
| 6 | 挂载后查 fiber 状态 | **不是 `PENDING`**（inject 缺失会静默 PENDING，是"插件没反应"头号原因） |
| 7 | 跑真实任务 | 岛在 turn 开始出现、step 递增、结束收起 |
| 8 | **卸载插件** | `pgrep -f DynamicIslandBridge` **无输出** |

第 8 步是唯一能证明第 6.2 节正确性的测试，做成可重复脚本。

### 9.4 挂载

需写 `~/.dsh/profiles/desktop/cordis.patch.yml`，**在 agent 沙箱之外**。
该文件已含用户既有模型与 UI 配置，**不得覆盖** —— 只能 append 一个 insert 行，
且操作前备份。

## 10. 测试策略

**单元测试（纯逻辑，无需 Xcode）**

- 状态机不变式 1–4，逐一断言。
- 估算公式边界：step=0、1、极大值；永不 > 90。
- 单调性：注入乱序 / 回退的 step 序列，显示值仍单调。
- `precise` 后注入更低的 heuristic 值 → 显示值不变。
- `turn/end` 各 `reason` 分支：`completed` → 100；`aborted`/`error` → 非 100。
- NDJSON 解码：畸形 JSON、`percent` 越界 / `NaN` → 丢弃不崩。

**集成测试**

- 假 helper（真 Unix socket server）验证 connect 重试、写失败重连。
- **孤儿进程测试**：注册 `ctx.effect` → 触发 dispose → 断言进程组内无残留。

**不做**：UI 像素级测试（收益低、维护贵）。渲染层靠第 9.3 节手工验证阶梯。

## 11. 已知风险与未决项

| 风险 | 说明 | 缓解 |
|---|---|---|
| Xcode 安装 | 7–15GB，需 sudo，纯手动 | 前置检查脚本：无 Xcode 时明确报错并指路 |
| floating 不支持 compact | 无刘海机型无法常驻药丸 | 已接受，降级为 hover 浮层 |
| stale socket 竞态 | 应用崩溃后残留 socket | helper 启动无条件 unlink 后 bind |
| 应用整体被杀 | helper（detached）可能残留 | 孤儿风险已知；`pgrep` 验证脚本提供手动清理 |
| `step` 编号跳变 | 单步子代理导致 | 只用单调性，不做线性假设 |
| KB 为 commit 快照 | 可能与安装版本 API 不一致 | 以实际安装包为准；已用真实 Loader 路径验证 |
| **工具成为死代码** | 注册工具不会让模型知道何时用它；无指令注入时 `precise` 永不触发，只有启发式在工作 | 通过 `ctx.systemPrompt.section()` 注入使用时机指导（计划 Task 8） |
| **单调性与精确比例冲突** | 若模型先把全部待办标记完成（推到 100%）再追加新待办，本 turn 内百分比会卡在 100% | 保留单调度（回退比高估更伤可读性）；`turn/start` 会重置；触发条件窄，已接受 |
| 依赖 `latest` tag 不可信 | `dsh-tools` / `dsh-session` 的 `latest` 是陈旧占位版 `0.0.1-rc.1` | 计划 Task 1 加了版本核实步骤，锁定 `0.2.1-alpha.2` |

## 12. 与原始需求的偏差记录

1. **`ctx.on('turn/start', ...)` 不成立** —— 必须走 `ctx.on('session/event')` 分发。
   这是规格层面的必要修正（§4.1）。
2. **DynamicNotchKit 需完整 Xcode** —— 原计划隐含假设工具链完备，
   实测发现 `SwiftUIMacros` 缺失（§2.1 坑 1）。
3. **无刘海机型无法常驻药丸** —— 库限制，已降级（§5.2）。
4. **中断不显示 100%** —— 原需求只说「完成锁定 100 并收起」，
   未区分异常终态；实现必须区分（§4.4）。
