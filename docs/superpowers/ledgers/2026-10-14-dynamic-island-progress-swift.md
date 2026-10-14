# SDD ledger — plan: docs/superpowers/plans/2026-10-14-dynamic-island-progress-swift.md

Spec: docs/superpowers/specs/2026-10-14-dynamic-island-progress-design.md
Executor: inline (Native), per human partner's choice.
Scope this run: Task 1–6 (Swift rendering layer). Phase 1 (TS, Task 1–9) is complete — see
.superpowers/sdd/2026-10-14-dynamic-island-progress-ts/progress.md (63→65 TS tests green).

## Global Constraints (from plan; apply to every task)

- 交流语言：中文。
- 本进程是 **server**：启动无条件 `unlink` stale socket → bind → listen。
- NDJSON，每行一个 JSON 对象，UTF-8；必须容忍半包/粘包。
- 入站类型：`hello(version)`、`progress(percent 0..1, mode estimated|precise, message?)`、`done(reason, ok)`、`bye`。
- `percent` clamp 到 `[0,1]`；非有限值丢弃不崩。
- 客户端断开后**不退出**，回 accept。
- 无主窗口 / 无 Dock 图标 / 不抢焦点（`setActivationPolicy(.accessory)`）。
- 绝不修改 `~/.dsh/profiles/desktop/cordis.patch.yml`。
- 除 DynamicNotchKit 外不引入原生依赖。
- 构建必须走 SwiftPM（裸 `swiftc` 在沙箱内 plugin-server 会被杀）。
- `--disable-sandbox` 必需；缓存重定向到仓库内。

## Human partner's binding decisions (post-approval)

- 提交策略：**直接提交到 master**（与阶段一一致；本地个人仓库、无远端）。已明确授权。
- 真实启动验证已授权：可拉取 DynamicNotchKit、构建、真实启动 helper 在刘海区短暂显示药丸，
  验证完毕由我终止进程。

## Pre-flight scan — shared interfaces

| 产出任务 → 消费任务 | 产出 | 消费 | 结论 |
|---|---|---|---|
| Task 2 → Task 3 | `LineBuffer.append(_:String)->[String]`、`decodeMessage(String)->InboundMessage?`、`InboundMessage` | SocketServer 分帧与解码 | 一致；但见下方 R1（需要字节级重载，否则跨 read 的 UTF-8 断字会被替换字符污染）。 |
| Task 2 → Task 4 | `InboundMessage`、`ProgressMode` | `ProgressBuffer.apply(_:)` | 一致（字段名逐个核对过）。 |
| Task 2 → Task 5 | `InboundMessage` | main 的 `onMessage` 投递 | 一致。 |
| Task 3 → Task 5 | `SocketServer.init(socketPath:onMessage:onError:)`、`start()`、`stop()` | main 装配 | 一致。 |
| Task 4 → Task 5 | `ProgressBuffer.percent/mode/message/isVisible/phase`、`Phase` | `ProgressPill`/`ProgressDetail`/`NotchController` | 一致；见下方 R2（`Phase` 必须 Equatable，`@Published` 的 actor 约束会影响测试可写性）。 |

## Pre-flight scan — plan self-consistency

- 计划声明的测试数逐个核对：Task 1 = 1 冒烟；Task 2 = 15；Task 3 = 7；Task 4 = 9 → 合计 32，
  与 Task 6 Step 5 的「Swift 侧 32/32」一致。
- 计划 Task 6 Step 5 写「TS 侧 63/63」，但阶段一 ledger 收尾为 **65/65**（追加修复后又加了两条）。
  数字陈旧，以实际 `npm test` 输出为准。
- 依赖 URL `https://github.com/MrKai77/DynamicNotchKit`：本会话 HTTP 200 可达；
  且 `/private/tmp/dnkbuild/.build/checkouts/DynamicNotchKit` 已有 1.1.0 的**成功构建**记录。
- 工具链：`swift --version` → 6.4 (swiftlang-6.4.0.34.1)，target arm64-apple-macosx26.0；
  `xcode-select -p` → `/Applications/Xcode.app/Contents/Developer`（**用户已完成 sudo 切换**，
  计划里"仍需切换"的说法已过期）；`libSwiftUIMacros.dylib` 存在于 MacOSX.platform 插件目录。
- Task 6 Step 1 要给 `NotchController` 加空闲超时，但**没有任何测试步骤**。空闲超时是真实行为，
  无测试即违反 TDD，且它是「插件意外死亡后岛永久停留」的唯一防线 → 见 R3。

## Rulings

<!-- Task <N>: Ruling: <finding> — <decision and why> — <cost if wrong> -->

Task 1: Ruling: 计划把入口写成 `Sources/DynamicIslandBridge/main.swift` **且**用 `@main`。Swift 不允许
在含顶层代码入口的 `main.swift` 里再用 `@main`（`'main' attribute cannot be used in a module that
contains top-level code`），且 `main.swift` 形态的 executable target 无法被 `swift test` 干净导入。
改为 `Sources/DynamicIslandBridge/Main.swift`（保留 `@main enum DynamicIslandBridgeMain`）。—
代价若错：文件名与计划不符，但计划未在任何命令里引用该文件名，无连锁影响。

Task 1: Ruling: 本机 `NSTemporaryDirectory()` 长 48 字符，计划 Task 3 的测试目录
`island-<UUID>`(7+36) + `/island.sock`(12) 使 `sun_path` 达到 **104 字节**，恰好顶满
`sockaddr_un.sun_path`（char[104]，需留 NUL），bind 会失败或路径被截断。测试目录缩短为
`isl-<UUID 前 8 位>`；同时 `SocketServer.start()` 主动校验路径长度并抛出可读错误，
而不是把 `EINVAL` 当成谜题。— 代价若错：极长路径下的报错信息不同，行为不变。

Task 1: Ruling: 计划 Task 3 的回调签名未标 `@Sendable`，但 `DispatchSourceProtocol.eventHandler`
在 Swift 6 语言模式下要求 `@Sendable` 闭包，而 `XCTestExpectation` 在 SDK 里**没有** Sendable 标注
（已核 `XCTestExpectation.h` 与 swiftinterface）。决定：生产代码用 Swift 6 语言模式 +
显式 `@Sendable` + `InboundMessage: Sendable`；**测试 target** 通过
`swiftSettings: [.swiftLanguageMode(.v5)]` 降级，使计划里的测试代码原样可编译。
— 代价若错：测试 target 不做严格并发检查，但生产 target 仍然做。

Task 1: Ruling: 计划的冒烟测试断言是 `XCTAssertTrue(true)` —— 一个永不失败的断言，它只证明
测试 target 能被链接，却把这个事实伪装成一条测试。改为断言 `bridgeVersion == "0.1.0"`，
同时钉住版本常量。— 代价若错：改版本号时需同步改这一行。

## Task log

Task 1: complete (commits 2e95647..766aed9, tests: swift test --disable-sandbox --package-path swift/DynamicIslandBridge → XCTest: Executed 1 test, with 0 failures)
Note: `swift test` 会先打 XCTest 汇总（权威，本包全是 XCTest）再打 swift-testing 汇总（0 tests）；
task-done 脚本抓的是最后一行，抓错了。后续一律以 XCTest 那行为准。
`swift run ... --version` → `DynamicIslandBridge 0.1.0`，EXIT=0。
`swift build` 拉取 DynamicNotchKit 1.1.0 并编译通过（7.35s），无宏错误。
遗留：`~/.cache/org.swift.swiftpm` 与 `~/Library/org.swift.swiftpm` 不可写 → SwiftPM 打 3 行
permission warning。功能无影响，但污染输出；Task 6 在 build-helper.sh 里用
`--cache-path/--config-path/--security-path` 收敛。

Task 2: Ruling: 计划只给 `LineBuffer.append(_ chunk: String) -> [String]`，但 socket 给的是**字节**。
跨 read 边界的多字节 UTF-8 标量若先各自解码成 String 再切行，会被替换成 U+FFFD 且**无任何报错**
（中文 message 直接变乱码）。改为双重重载：`append(String)`（计划签名，保持兼容）+
`append(Data)`（真实路径：先按 0x0A 字节切行，再整行解码）。— 代价若错：多一个重载，无行为回归。

Task 2: Ruling: 计划未给协议层设缓冲区边界。新增 `LineBuffer.maxPendingBytes = 1 MiB`，超限丢弃
缓冲并在下一个换行重新同步——对端永不发换行时缓冲会无界增长。— 代价若错：超长帧被丢弃；
但正常帧 < 1 KiB，触发即说明对端已坏。

Task 2: 诚实记录 — `maxPendingBytes` 守卫是**先写实现后补测试**（违反 RED 先行）。补救方式：
补测试后做**变异验证**（把 `pending.count > Self.maxPendingBytes` 改成 `if false`），
观察到 `testPendingBufferIsBounded` 失败（真实打印出 1 MiB 的 'A' 作为返回值），再还原守卫并复跑
27/27 绿。这证明该测试确实能捕获它声称的缺陷，但不构成原始 RED→GREEN 证据。

Task 2: 计划 15 条协议测试之外新增 11 条（分帧 2、多字节 1、有界 1、解析 7），覆盖：
`true` 经 NSNumber 桥接成 1.0 的假 100%、字符串数字、未知 type、缺 `ok`/`version`/
`message`、无尾换行的残留帧、首尾空白。全部在写实现**之前**写好并观察到编译失败（RED）。

Task 2: complete (commits 766aed9..97b9935, tests: swift test → XCTest: Executed 27 tests, with 0 failures)
27 = 1 冒烟 + 26 协议；计划预期 16 = 1 + 15，差额见上方 Ruling。

Task 3: Ruling: **计划的分帧测试是坏的，不是实现坏的**。`testReassemblesFrameSplitAcrossWrites`
用两次 `sendRaw()` 发半个帧，而 `sendRaw` 每次都新建并关闭一条连接——两半落在**两条连接**上，
按单连接分帧语义前半段必须被丢弃，该测试永远不可能通过。改为同一个 fd 上分两次 `write`
（新增 `connectClient()`/`send()` 两个 helper），并补一条在 UTF-8 标量中间切断的
`testReassemblesSplitMultibyteFrame`。— 代价若错：无，原测试测的是它自己造出来的幻觉。

Task 3: Ruling: 计划测试的 `sockaddr_un` 用 `strncpy`，截断时不保证 NUL 结尾。改为 `strlcpy`。
生产代码同样用 `strlcpy`。— 代价若错：无。

Task 3: Ruling: `start()` 对超长路径主动抛 `SocketServerError.socketPathTooLong`（错误文本含
`sun_path`），而不是把 `EINVAL` 留给用户猜。新增 2 条测试（超长路径、bind 到不存在的目录）。
— 代价若错：错误分类不同，行为不变。

Task 3: 诚实记录 — 新增的 `testStopRemovesSocketFile`、`testStopBeforeStartIsSafe`、
`testSecondConnectionReplacesAStillOpenFirst`、`testClientDisconnectingWithoutSendingDoesNotKillServer`、
`testReassemblesSplitMultibyteFrame` 与计划外 2 条一起，都是在实现**之前**写好并观察到
`cannot find type 'SocketServer' in scope` 的（RED），属真实 RED→GREEN。

Task 3: 变异验证（补证，非 RED 替代）——把 `unlink(socketPath)` 守卫整段删掉后重跑，
`testRemovesStaleSocketBeforeBinding` 失败并给出真实 errno：
`bind failed: Address already in use (errno 48)`；还原后 41/41 绿。
这证明「stale socket 恢复」（Review Focus #5）确实被测试咬住，而不是恰好通过。

Task 3: complete (commits 97b9935..0adb863, tests: swift test → XCTest: Executed 41 tests, with 0 failures)
41 = 1 冒烟 + 26 协议 + 14 socket。无编译警告（已消除测试 helper 里的 Sendable 与
`withCString` 未使用结果警告，并把与全局 `write` 同名的 helper 改名为 `send`）。

Task 4: Ruling: 计划要求 `@Published` 属性加 `@MainActor` 约束，但计划给的测试代码没有
`@MainActor` 标注。`@MainActor` 类的同步 init 无法从 nonisolated 同步上下文调用——这在
Swift 5 语言模式下同样是**错误**而非警告，所以测试类必须标 `@MainActor`（XCTest 本就在主线程
跑测试方法）。— 代价若错：无；若把 buffer 改成非 MainActor，socket 队列写、SwiftUI 读就是
真实数据竞争。

Task 4: Ruling: 计划说 `apply(.done)` 时 `message = reason`，未区分 ok。按字面实现（`ok` 真假
都写 reason），保持与计划零偏差。— 代价若错：成功时状态行短暂显示 "completed"（1.2s 停留窗口内
hover 才可见），无功能影响。

Task 4: 计划 9 条测试之外新增 2 条：`testProgressAfterDoneReturnsToRunning`（新 turn 落在
dispaly 停留窗口内时必须回到 running，这是 Task 5 里 `hideTask` 竞态的输入端）、
`testModeTracksLatestProgress`。两条均在实现之前写好并观察到 `cannot find type 'ProgressBuffer'`
（RED）。

Task 4: 变异验证（补证）——把 `if ok { self.percent = 1 }` 改成无条件 `self.percent = 1`
（即"把中断显示成完成"这一 spec §4.4 明令禁止的行为），`testDoneNotOkDoesNotClaimFull` 失败，
失败数 0→1；还原后 52/52 绿。spec 的头号安全不变式确实被测试咬住。

Task 4: complete (commits 0adb863..2d5e303, tests: swift test → XCTest: Executed 52 tests, with 0 failures)
52 = 1 冒烟 + 26 协议 + 14 socket + 11 buffer。无编译警告。
注：`@MainActor` + `ObservableObject` 在 Swift 6 语言模式下编译通过，无需额外注解。

Task 5: Ruling: **计划对本任务没有任何测试步骤**（只有 Step 4 build + Step 5 手工看），
而计划自己把 `hideTask` 竞态标为「最容易漏且症状隐蔽」。裸看代码无法验证竞态，所以把决策层
抽成纯类型 `NotchPresenter`（`visibilityChanged` / `hoverChanged` / `phaseChanged` /
`lingerElapsed` → `[NotchEffect]`），并写 15 条测试先把这些规则钉住；
`NotchController` 只剩下执行 effect 的部分。— 代价若错：多一层间接与一个文件。

Task 5: Ruling: 竞态的真实触发路径与计划描述不同。计划说「若在 1.2s 窗口内
`buffer.isVisible` 由 false 变回 true」——但 `ProgressBuffer` 在 `done` 时**保持** `isVisible == true`，
所以新 turn 到达时 `isVisible` 根本没变过，触发竞态的是 **`phase` 变回 `.running`**。
测试 `testNewTurnInsideLingerWindowCancelsThePendingHide` 走的就是 phase 路径；
`visibilityChanged(to: true)` 的 cancel 分支仍保留作纵深防御。
— 代价若错：按计划字面实现会写出一个永不触发的守卫，竞态原样存在。

Task 5: Ruling: `hoverBehavior: [.increaseShadow]`（计划已定），实现里额外把
`expand/compact/hide` 全部串行化到一个 `AsyncStream` 消费者里 —— 库的三个方法各自
`await` 0.4s 动画，且内部转换跑在 detached Task 里靠 `guard state == .hidden` 兜底，
并发调用必然互相打架。计划只要求「防抖 + 串行化」，这是串行化的落点。
— 代价若错：hover 快速进出时命令排队，视觉上会慢一拍（可接受，且比状态错乱好）。

Task 5: Ruling: 计划的 `main.swift` 取 `argv` 最后一个参数作 socket 路径。保留该语义，
但要求「最后一个参数」不能是别的 flag —— Task 6 会引入 `--idle-timeout-ms`，届时
`helper --idle-timeout-ms 5000` 会把 "5000" 当路径。已在 Task 6 用 `BridgeOptions` 解析器修正，
本任务尚未引入额外 flag。— 代价若错：见 Task 6。

Task 5: 实证（真实进程 + 真实窗口服务器，脚本探针非测试套件）：
- `CGWindowListCopyWindowInfo`：`owner=DynamicIslandBridge layer=1000 alpha=1.0 onscreen=yes
  x=367 y=0 w=735 h=478` —— 正是 `initializeWindow()` 的 half-screen 顶部居中几何。
- `NSRunningApplication.activationPolicy == .accessory`，`isActive=false` → 无 Dock 图标、不抢焦点
  （spec 成功判据 #6 达成）。
- 本机实测 `auxiliaryTopLeftArea=(0,924,646,32)`、`auxiliaryTopRightArea=(825,924,645,32)`
  → **有刘海**，走的是 compact 药丸路径，与 spec §2 的实测几何一致（刘海 179×32pt）。
- 生命周期（每次以窗口是否存在为判据）：空闲 → `MATCHED=0`；progress → `MATCHED=1`；
  `done(ok:true)` 后 0.3s → 仍 `MATCHED=1`（linger 生效）；2.8s 后 → `MATCHED=0`（收起）；
  `bye` 后 1.0s → `MATCHED=0`。
- **竞态实证**：progress → done → 0.4s 内再 progress → 3.4s 后仍 `MATCHED=1`
  （若 cancel 缺失，1.2s 时就会被上一轮的 hide 吃掉）。这是本计划点名的最隐蔽缺陷，
  在真实进程上证明已修复。
- 全程 helper stderr 只有一行 `island: listening on ...`，无崩溃、无错误。

Task 5: 诚实记录 — **hover 展开与药丸文字无法物理验证**。`screencapture` 全屏与区域截图
均报 `could not create image from display` / `could not create image from rect`，
是 TCC 屏幕录制权限拒绝（非 DSH 沙箱拒绝，报错来自 screencapture 自身）。
因此「鼠标悬停展开 / 移开收起」只有代码审查 + `NotchPresenterTests` 的
`testHoverExpands` / `testHoverExitCompactsOnNotchedScreen` / `testHoverExitIsIgnoredOnNotchlessScreen`
作为证据，**未经物理验证**；药丸文字是否被 NotchShape 裁切同样未目视确认，
只有几何推算（内容区 32pt − 4pt 上 − 8pt 下 = 20pt，11pt 字号行高约 13pt）作为依据。

Task 5: 编译期发现 — `public enum` 不会隐式获得 `Sendable`（隐式推断只给非 public 类型），
`NotchEffect` 跨进 `AsyncStream` 时报 `sending 'effect' risks causing data races`。
显式加 `Sendable` 修复。— 代价若错：无。

Task 5: 诚实记录 — **无刘海降级路径（Review Focus 第 3 条）未经物理验证**。本机有刘海，
无法物理触发 floating 路径。证据只有：`NotchPresenterTests` 的
`testBecomingVisibleExpandsOnNotchlessScreen` 与 `testHoverExitIsIgnoredOnNotchlessScreen`
（断言 `hasNotch == false` 时产出 `.expand` 而非 `.compact`）、
`NotchController.screenHasNotch()` 复刻了 DynamicNotchKit `NSScreen.hasNotch` 的判定条件
（两个 `auxiliaryTop*Area` 均非 nil，已逐行核对库源码）、以及 README 中记录的差异。
判定：**逻辑正确，未经物理验证**。

Task 5: complete (commits 2d5e303..ce2163e, tests: swift test → XCTest: Executed 67 tests, with 0 failures)
67 = 52 + 15 presenter；`swift build` 无警告。

Task 6: Ruling: 计划的 Step 1（空闲超时）**没有测试步骤**，Step 4 的验证命令是
`npm test && bash scripts/verify-teardown.sh DynamicIslandBridge`。后者是**同义反复**：
`verify-teardown.sh` 跑的是 `test/helper.test.ts`（spawn 的是 Node 写的假 helper），
再 `pgrep -f DynamicIslandBridge` 找不到真二进制是必然的；而且实测 `pgrep -f` 会匹配到
**调用它的那个 shell 自己**（命令行里就含该字符串，已实测 `pgrep -f definitely-not-running-xyz`
返回了当前 bash 的 pid）。所以新增 `scripts/e2e-real-helper.mjs`，用三条互不重叠的证据替代：
① 从 helper 自己打到 stderr 的启动行解析 pid，dispose 后 `process.kill(pid, 0)` 判存活；
② 断言 socket 文件**已被删除**（SIGKILL 路径删不掉它，恰好区分优雅退出与超时升级）；
③ 用 `scripts/probe-island-window.swift` 查 `CGWindowList`，断言窗口真的出现/消失。
— 代价若错：多一个需要真机 + 显示的验证脚本，CI 里需跳过。

Task 6: Ruling: 空闲超时的**决策**放进 `NotchPresenter.idleElapsed()` 做单元测试
（运行中→hide+reset；未显示→空；linger 未决→空），**触发**用 E2E 验证。
为了让触发可测，新增 `--idle-timeout-ms` 参数（默认 120000，与 `src/index.ts` 一致）。
引入该 flag 暴露出计划 Task 5 留下的隐患：`helper --idle-timeout-ms 5000` 会把 `5000`
当成 socket 路径。因此把「取最后一个参数」改为「取最后一个**位置**参数」，
抽成 `BridgeOptions.parse()` 并写 9 条测试。— 代价若错：多一个 CLI 解析器。

Task 6: Ruling: 计划的 `main.swift` 直接把 socket 路径当作最后一个 argv，
未处理「目录不存在」。新增 `ensureParentDirectory()`（0700，已存在则收紧权限），
使 helper 独立运行时也能 bind，而不必先由插件创建目录。
— 代价若错：helper 会创建一个它原本可以不创建的目录（与插件同一路径，幂等）。

Task 6: **E2E 抓到一个 Critical 缺陷**（修复前 4 项失败）：
`_ = installSignalHandlers(...)` 丢弃了返回的 `[DispatchSourceSignal]`——
**释放的 dispatch source 会被取消**，而默认处置已被换成 `SIG_IGN`，
于是 SIGTERM 被彻底忽略：进程不退（dispose 卡满 graceMs=3007ms 后升级 SIGKILL），
socket 文件残留，孤儿检查拿不到 pid。
修复：改为存入文件级 `@MainActor private var signalSources`，生命周期随进程。
修复后 dispose() 在 **3ms** 内返回，socket 被删除，pid 消失。
这个缺陷单靠读代码很难发现（`_ =` 看起来只是「不求返回值」），
只有真机 E2E 能暴露。— 代价若错：无。

Task 6: **E2E 抓到第二个缺陷（测试侧）**：假 ctx 的 logger 只取第一个参数，
而真宿主按 printf 风格转发（`src/index.ts:118: log.warn('island helper: %s', line)`），
于是解析到的是字面量 `island helper: %s`，启动行永远匹配不上。
修复：`(...a) => a.map(String).join(' ')`。— 代价若错：E2E 会误报「helper 没起来」。

Task 6: 实证（`node scripts/e2e-real-helper.mjs`，全部 ✔）：
真 `bin/DynamicIslandBridge`（release）启动并报出 pid → 插件 connect 成功 →
注入 `turn/start` → **窗口出现**（事件→状态机→socket→helper→窗口服务器全链路）→
dispose 3ms 返回 → socket 文件已删除 → pid 不存在（无孤儿）→ 窗口消失；
另起一相：`--idle-timeout-ms 3000` 的实例，progress 后窗口出现，静默 5s 后自动收起。
**这同时补上了 Task 5 只用手工 nc 验证、缺「插件侧驱动」的一段。**

Task 6: 全量回归 —— `npm test` **65/65**；`npm run typecheck` 退出码 0；
`swift test` **80/80**（12 buffer + 14 socket + 18 presenter + 26 protocol + 9 options + 1 冒烟，
分组计数之和 80）；`swift build` 与 `swift test` 均无警告。
注：计划 Task 6 Step 5 写的「TS 侧 63/63」是陈旧数字（阶段一收尾为 65）。

Task 6: complete (commits ce2163e..fcdae9a, tests: swift test → XCTest: Executed 80 tests, with 0 failures;
另 npm test → 65/65，typecheck → 0，node scripts/e2e-real-helper.mjs → 全 ✔)


## Final whole-branch review（2e95647..fcdae9a，独立 subagent，全新上下文）

复审结论：**1 项都没有 Critical**；3 项 Important；一批 Minor。
复审人自述只读合规（未改工作树），自行跑了 `swift test` 复核 80/80，
并逐条到 DynamicNotchKit 1.1.0 源码核对库行为声明，未发现我的 Ruling 有误。
（工具限制：`subagent` 不暴露 model 参数，无法按技能要求显式指定「最强可用模型」；
本次用的是会话默认模型。这是一处未满足的技能要求，如实记录。）

### Important 的处理（全部进入并只有一轮 fix pass）

Final: fixed ①收起复位排在 hide 之后导致新一轮被抹掉 —
先写 RED（`testCollapseRetractsTheBufferBeforeHiding` 等 5 条新测试 + `retract()` 2 条，
观察到 `has no member 'retractBuffer'` / `'retract'`），再实现
（`[.retractBuffer, .hide]` + `ProgressBuffer.retract()` 不清零百分比以免药丸退出时闪 0%）。
**并用区分性实验证明**：同一脚本、同一时序下，修复版 `MATCHED=1`，
把顺序改回 `[.hide, .retractBuffer]` 的变异体 `MATCHED=0`。
该场景已固化为 E2E 的 `phaseNewTurnDuringHide`，连跑 3 次稳定通过。
suite 96/96。

Final: fixed ②`hasNotch` 只在 init 采样一次 — RED（`hasNotch` is a 'let' constant /
`no member 'screenCapabilityChanged'`），再实现 `var hasNotch` +
`screenCapabilityChanged(to:)`（可见时按新屏能力重新表达），
controller 在每次可见性决策前与屏幕参数变化时重读。suite 96/96。

Final: fixed ③`ProgressDetail` 硬编码 `.white`，而 floating 面板在浅色模式下背景是
`.popover` 材质，白字不可见——恰是无刘海用户唯一能看到的视图 —
RED（`cannot find 'DetailPalette' in scope`），再实现 `DetailPalette`
（跟随库自身约定 `notchStyle.isNotch ? .white : .primary`）+ 可观察的 `NotchAppearance`
（因为库在屏幕变化时会重建窗口，捕获一次的 Bool 会过期）。suite 96/96。

Final: 例外说明 — `NotchAppearance` 本身是纯数据持有者（无行为），不单独写测试；
其真正的逻辑（配色决策）由 `DetailPaletteTests` 6 条覆盖，接线由 E2E 覆盖。
这是本轮唯一「生产代码没有对应失败测试」的地方，明确记录。

### 顺带修的 2 项 Minor（明确例外，理由：它们直接损害验证证据本身）

Final: fixed E2E 在窗口检查被跳过时仍打印「渲染与清理都正确」——这与本项目两次
ledger 反复强调的「同义反复的验证」是同一类问题。改为计数 `skipped`，
有跳过即不报成功并 exit 1。无测试（它是测试脚手架自身的输出）。

Final: fixed 根 README 无刘海一行写「悬停展开、移开收起」，与实现（刻意忽略移出）
矛盾。改为「移开不会收起」并说明理由与代价。无测试（文档）。

### 其余 Minor：deferred（未修，按技能规定 Minor 不进入 fix pass）

Final: minor (deferred): `done(ok:false)` 未触发 `expand()`（spec §5.3 一行与它自己的
解耦段落矛盾；计划也是照段落实现的，影响小——药丸有警告三角，无刘海机型本就展开）。
Final: minor (deferred): `"message": null` 会整帧丢弃（`Protocol.swift`），版本不匹配的对端会丢全部更新。
Final: minor (deferred): `stop()` 之后再 `start()` 会留下无人监听的 socket 文件（`didBind` 已被重置）。
Final: minor (deferred): `SocketServerTests` 里两处 `XCTAssertNoThrow(server.stop())` 包住的是非 throwing 调用，断言永不失败（真正起作用的是「不崩即过」）。
Final: minor (deferred): `testSecondConnectionReplacesAStillOpenFirst` 没有断言旧连接确实被关闭。
Final: minor (deferred): `Options.swift`/Swift README 说空闲超时「与插件 idleTimeoutMs 一致」，实际只有默认值一致，插件并不传该值。
Final: minor (deferred): `Main.swift` 会把任意调用者给定的 socket 目录 chmod 0700。
Final: minor (deferred): 每条消息一个 `Task { @MainActor }`，入队顺序在语言层面无保证。
Final: minor (deferred): LineBuffer 溢出会连带丢弃同一 chunk 里已经完整的合法帧。
Final: minor (deferred): `chmod` 未检查返回值；没有 socket 文件权限为 0600 的测试。
Final: minor (deferred): fd 未设 `O_NONBLOCK`，`readFromClient` 里的 EAGAIN 分支实际是死代码。
Final: minor (deferred): `--flag=value` 形式被静默忽略。
Final: minor (deferred): `expand(on:)` 默认参数 `NSScreen.screens[0]` 在屏幕列表为空时会 trap。

### 复审的 "Declined to judge" 逐条裁决

Final: Ruling: spec §5.3「收到带 message 的 progress 就 expand()」这一行 — 与同节自己的
「显示态与进度解耦」段落直接矛盾。以段落 + 计划为准，实现不因 message 展开。
— 代价若错：用户看不到消息文本，除非 hover。
Final: Ruling: 像素级渲染与无刘海物理路径 — 前者被 TCC 挡（已如实披露），后者本机无此硬件。
本轮的替代证据：窗口服务器探针 + 264 条断言（TS 65 + Swift 96 + E2E 全绿）+ 区分性变异实验。
— 代价若错：颜色/裁切类问题可能漏到用户那里；已按库自身约定消除已知的一处。
Final: Ruling: 半屏面板的点击穿透 — 复审人用库维护者的 issue #48 结论解决了：从未给窗口
赋 `ignoresMouseEvents = false` 的 borderless 窗口会放行点击，而本进程从未赋过该值。
判定为非问题。— 代价若错：药丸区域可能吞掉点击（复审判定为不会）。
Final: Ruling: `from: "1.0.0"` 而非锁到 1.1.0 — `Package.resolved` 已提交并锁在实际解析到的 1.1.0。
— 代价若错：全新环境重新解析时可能拉到更新的 minor 版本。

### 最终状态

Fix pass 之后全量回归：TS `npm test` **65/65**、`npm run typecheck` exit 0、
Swift `swift test` **96/96**（无编译警告）、`node scripts/e2e-real-helper.mjs` 全 ✔（含 4 个相位：
真链路渲染 / 卸载无孤儿 / 空闲超时 / 收起动画期间来新一轮）。
提交 `a5bdc4d`。工作树干净。

## 阶段二（Swift 侧）结论

Task 1–6 全部完成，7 次提交（766aed9、97b9935、0adb863、2d5e303、ce2163e、fcdae9a、a5bdc4d）。
- 计划声明的 32 条测试 → 实际 96 条（多出的部分覆盖了计划完全没有测试的三个危险区：
  NotchController 的决策、空闲超时、CLI 解析）。
- 计划缺陷 4 处、E2E 抓到的真实缺陷 2 处（其中 1 处是 Critical：SIGTERM 被彻底忽略）、
  复审 Important 3 处 —— 全部有 Ruling 或 fix 记录。
- 未物理验证的部分已在各 Task 与 Final 段落明确标注：hover 展开/收起、无刘海降级路径、
  药丸文字是否被 NotchShape 裁切（TCC 拒绝屏幕录制）。

Swift 侧不再是「计划已写未执行」——`docs/superpowers/plans/...-swift.md` 的 6 个任务全部落地。
