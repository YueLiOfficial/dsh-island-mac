# SDD ledger — plan: docs/superpowers/plans/2026-10-14-dynamic-island-progress-ts.md

Spec: docs/superpowers/specs/2026-10-14-dynamic-island-progress-design.md
Executor: inline (Native), per human partner's choice.
Scope this run: Task 1–9 (TypeScript side). Swift rendering layer is a SEPARATE plan, not yet written.

## Global Constraints (from plan; apply to every task)

- 禁止 `export default`（Loader.unwrapExports 会丢弃 inject/name/Config）。
- socket: `~/Library/Application Support/dsh-island/island.sock`，目录 0700。
- helper = server (bind+listen)；plugin = client (connect+push)。
- NDJSON，每行一个 JSON 对象，UTF-8。
- 估算上限硬性 90%；100% 只可能来自 turn/end 或 report_progress(1.0)。
- 显示值单调不减；状态机 estimated→precise 单向。
- 异常终态不显示 100%。
- 进程清理：单个 ctx.effect 的 async disposer，SIGTERM → await close → 超时 SIGKILL → 再 await close。
- spawn 子进程必须擦洗 env（*KEY*/*SECRET*/*TOKEN*/*PASSWORD*）。
- 绝不修改 ~/.dsh/profiles/desktop/cordis.patch.yml。
- 交流语言：中文。

## Human partner's binding decisions (post-approval)

- todo 加权公式 `(completed + 0.5*in_progress)/total` 采用。
- 保留单调度，**不放开下降生效**。理由（用户原话）：允许一个来源的下降会让"单调"承诺失去意义，代价是窄触发条件的 UI 撒谎，可接受。
- Task 4 与 Task 8 是两处静默失效高发区（事件类型分发错误、工具成为死代码）——
  这两处的测试必须真正跑通，而不是只过断言。
- Task 7 完成后单独安排一次进程生命周期整体复审。

## Pre-flight scan — shared interfaces

逐对检查「后置任务消费前置任务产出」的接口：

| 产出任务 → 消费任务 | 产出 | 消费 | 结论 |
|---|---|---|---|
| Task 2 → Task 3 | `estimatePercent(step): number`（0..90 百分比） | `onStep` 需要 0..1 小数 | **一致但易错**：单位不同，Task 3 实现要点已明确要求 `/100`。计划已自带警告，无需 ruling。 |
| Task 3 → Task 4 | `ProgressMachine`、`ProgressSnapshot` | `reduceSessionEvent(m, event)` | 字段名一致（state/percent/mode/message/turn/ok）。 |
| Task 3 → Task 6 | `ProgressMachine.reportPrecise/snapshot` | `createProgressService(m, onPublish)` | 一致。 |
| Task 3/5/6 → Task 7 | 全部 | `apply(ctx, config)` 装配 | 一致。 |
| Task 6 → Task 7 | `buildReportProgressTool`、`createProgressService` | 装配步骤 3 | 一致。 |
| Task 6 → Task 8 | `REPORT_PROGRESS_TOOL_NAME` | `buildProgressInstruction()` 文本断言 | 一致。 |

无冲突。所有跨任务类型名与字段名在产出/消费两侧拼写一致。

## Pre-flight scan — plan self-consistency

- `Expected: N passed` 与真实 `test(` 数量：已用脚本逐个核对，全部一致（Task 1 的 smoke 未标 N，合理）。
- 依赖版本已逐个 HTTP 200 核实：cordis@4.0.4、dsh-tools@0.2.1-alpha.2、dsh-session@0.2.1-alpha.2、schemastery@3.18.4。
- `@deepseek-ai/dsh-session@0.2.1-alpha.2` 的 `SessionEventMap` **不含** `todo/write`（由 tool-todo 声明合并添加）→ Task 4 必须运行时校验，计划已写明。

## Environment facts (verified this session)

- Node v24.21.0，原生 `node --test x.test.ts` 已验证可跑 `.ts`。
- pnpm 绝对路径：/Users/yueli/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs
- `~/.npm` 沙箱外不可写 → 所有 npm/pnpm 调用必须设 `npm_config_cache` 到工作区内。
- Xcode 27.0 已安装（/Applications/Xcode.app），macOS 版 `libSwiftUIMacros.dylib` 存在。
  但 `xcode-select` 仍指向 /Library/Developer/CommandLineTools（未切换）。

## Rulings

<!-- Task <N>: Ruling: <finding> — <decision and why> — <cost if wrong> -->


## Swift 前置核实（本会话实测，供 Swift 计划使用）

- Xcode **27.0** 已装于 /Applications/Xcode.app。
- macOS 版宏插件存在：`/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins/libSwiftUIMacros.dylib`（arm64）。
- **DynamicNotchKit 已实测编译成功**（`swift build --disable-sandbox` + `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`）：
  库模块全程无宏错误，失败仅出在探针 main.swift 的 `DynamicNotchStyle.notch` 歧义（静态属性 vs 枚举 case），与工具链无关。
- 裸 `xcrun swiftc` 报 `swift-plugin-server produced malformed response` 是 **agent 沙箱产物**
  （plugin-server 子进程被杀）；SwiftPM 走 `-load-resolved-plugin` 显式 dylib 路径，不受影响。
  **结论：构建必须走 SwiftPM，不要用裸 swiftc 验证宏。**
- `xcode-select` 仍指向 CommandLineTools。用户需执行（需 sudo，我无法代做）：
  `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
  未切换时可用 `DEVELOPER_DIR` 环境变量绕过。
Task 2: complete (tests: node --test test/estimate.test.ts → 4/4 pass)

Task 1: Ruling: 计划的 `"test": "node --test test/"` 在 Node 24 上不可用 — 该写法把 `test/` 当模块路径解析，报 ERR_MODULE_NOT_FOUND。改为 `node --test 'test/**/*.test.ts'`（已实测发现全部 14 个测试）— 代价若错：测试脚本不发现文件，套件假绿。

Task 1: complete (tests: npm test → 14/14 pass; 另 npm run typecheck → exit 0)
Task 3: complete (tests: node --test test/progress.test.ts → 9/9 pass)

Task 4: Ruling: 计划让 `startTurn` 无条件重置，但计划自带的「事件重放不倒退」测试要求同一 turn 重复 turn/start 保持进度。改为按 turn 幂等（同一 turn 且非 idle 则早返回）— 代价若错：跨 turn 不再重置，新 turn 会沿用旧百分比。

Task 4: Ruling: `onTurnStart` 对不可读 turn 值返回 changed=false 而非调用 startTurn — 原实现会把 NaN 传下去并重置、抹掉真实进度。代价若错：一个畸形 turn/start 被忽略，进度停在旧值（比抹掉更安全）。

Task 4: complete (tests: node --test test/events.test.ts → 13/13 pass；全量 27/27)
Task 5: complete (tests: node --test test/protocol.test.ts → 8/8 pass)
Task 6: complete (tests: node --test test/tool.test.ts → 7/7 pass)

Task 7: Ruling: 计划的 helper 测试调用 `helperArgs: [FAKE]` 未传 socket 路径 — 假 helper 需要 argv[2]，否则立即退出，连接永不建立。改为 `[FAKE, s.sock]` / `[FAKE, marker]` — 代价若错：假 helper 收不到 socket 路径，全部 helper 测试假失败。

Task 7: Ruling: 计划的 `new URL(...).pathname` 取假 helper 路径在本工作区不可用 — 目录名含空格（"Dynamic Island for mac"），pathname 返回百分号编码的 /Dynamic%20Island%20...，spawn 找不到文件。改用 `fileURLToPath(new URL(...))` — 代价若错：任何含空格/特殊字符的安装路径都解析失败。

Task 7: Ruling: 计划让 Task 8 建 src/instructions.ts，但 apply 需要 section 文本，先内联会造成重复。抽出 src/instructions.ts（buildProgressInstruction + SYSTEM_PROMPT_SECTION_ORDER），index.ts 引用它 — 代价若错：无，纯结构。

Task 7: complete (tests: node --test test/helper.test.ts → 6/6 pass; 全量 48/48 pass; 孤儿检查 pgrep → CLEAN)

Task 8: 诚实记录 — 本任务的测试拿到的是**假 RED 降级**：`src/instructions.ts` 在 Task 7 已为解耦重复而抽出，
故 9 个测试写完后未出现 ERR_MODULE_NOT_FOUND。其中 1 个测试确实先失败后通过
（`/仅在/` 断言：初版文本只有英文 "only when"，缺中文"仅在"），另 8 个为一次性通过。
这 8 个属于事后测试，不构成 RED→GREEN 证据；它们仍有回归价值，但不证明实现正确。
Ruling: 保留这 8 个测试作为回归护栏并如实标注，不删除重写 — 代价若错：这 8 条若断言写错，
不会被 RED 阶段暴露（已通过阅读实现逐条核对断言语义缓解）。

Task 8: complete (tests: node --test test/instructions.test.ts → 9/9 pass; 全量 57/57)

Task 9: Ruling: verify-teardown.sh 中 `$MARKER）`（变量后紧跟全角右括号）触发 bash unbound variable — 多字节字符首字节 0xEF 被当作变量名字符。改为 `${MARKER}` 界定 — 代价若错：脚本对含中文/全角字符的输出全部崩溃。

Task 9: complete (tests: bash scripts/verify-teardown.sh → 测试通过 + CLEAN 无孤儿；端到端假 helper 收到 hello v1 / progress 42% precise)

Post-Task-9: Ruling: 独立审计（全新上下文 subagent 逐行核对 DynamicNotchKit 源码）发现——计划里
`hoverBehavior: [.keepVisible]` 会使 `_hide` 在光标停留时每 0.1s 重试，导致任务结束**不会**收起，
违反 spec §5.3。改为 `[.increaseShadow]`。代价若错：任务结束时若光标在岛上，收起被无限延迟。

Post-Task-9: Ruling: `flush()` 中 `if (snapshot.state === 'idle') return` 会静默吞掉收起消息。
当前 `bye` 走直接路径故功能正常，但该守卫是潜在陷阱。改为转发 `bye` 并加注释钉死。
代价若错：未来若把 bye 改走队列，灵动岛将永不收起且无报错。

Post-Task-9: 独立实证（自建探针，非测试套件）——helper 连接后被 SIGKILL：
`sender.alive` 正确变为 false；向已死连接 `send()` 静默返回而非抛异常；
`dispose()` 正常完成；宿主进程未因未处理 'error' 崩溃。EXIT=0。

## 阶段性结论

阶段一（TypeScript 侧，Task 1–9）全部完成：
- 57 个测试全绿；`tsc` 退出码 0；孤儿进程检查 CLEAN。
- 9 次提交，历史线性。
- 计划偏差共 6 条，全部记录在下方 Ruling 中。

阶段二（Swift 侧）计划已写好但**未执行**：
docs/superpowers/plans/2026-10-14-dynamic-island-progress-swift.md（6 任务 / 35 步）。
DynamicNotchKit API 已经独立审计逐行核对，计划里的三处错误已修正。

未决：Task 7 进程生命周期的独立 subagent 复审直到本次会话收尾仍在运行，
未返回结论。已用自建的等价人工核查 + 探针实证替代（见上）。

## Task 7 独立生命周期复审（用户要求，已完成）

全新上下文 subagent + 可复现 harness 完成对抗性复审。结论：**1 Critical / 4 Important / 2 Minor**。

| # | 严重度 | 缺陷 | 状态 |
|---|---|---|---|
| F1 | **Critical** | `ensureSender` 中 `handle = await startHelper(...)`——子进程已存在但 handle 未赋值（最长 10s）。此窗口内卸载 → disposer 对 null 无操作 → **detached 孤儿**，且永不收起。有复现。 | 已修 + 回归测试 |
| F2 | Important | 第二次并发 `dispose()` 立即返回（bool 守卫），不等待停稳；pending SIGKILL 升级会随宿主退出丢失。有复现。 | 已修 + 回归测试 |
| F3 | Important | 最后一次 `waitForExit` 返回值被丢弃，无存活校验。 | 已修（检查并上报） |
| F4 | Important | stdout 被 pipe 但从不排空 → helper 阻塞在 write(2)，进度静默冻结（socket 仍在 → 不重连、无日志）。有机制复现。 | 已修 + 回归测试 |
| F5 | Minor（后果致命） | `spawn` 可同步抛（如 NUL 路径），违反"never rejects"契约；无 `.catch` → 未处理 rejection 杀掉 DSH 会话。有复现。 | 已修 |
| F6 | Minor | 连接超时路径泄漏 `abort` 监听。 | 已修 |
| F7 | Minor | stderr 缓冲无界且尾行不 flush。 | 已修 |

**最重要的非代码发现**：原有两个孤儿测试是**同义反复**——假 helper 在 SIGTERM 后约 2ms 就退出，
测试又 sleep 300ms，因此"只发信号就返回"的实现照样通过。复审用 mutant（仅删除两行
`await waitForExit`）证明了这一点。已替换为：helper 忽略 SIGTERM 700–800ms，
在**每个 dispose() 返回的那一刻**判定存活，**不 sleep**。

Task 7 复审: complete（修复见提交 "fix: close critical orphan window and harden helper lifecycle"；
全量 63/63，typecheck 0，孤儿 CLEAN）

## Task 7 修复的独立验证（已完成）

第二个全新上下文 subagent，自建 harness，**对旧代码与新代码各跑一遍**做区分性验证。
最终结论：**F1–F7 全部 FIXED，无回归**（62 harness PASS）。关键证据：

- F1：旧代码在"dispose 与第二次 ensure 同窗口"下 `spawns recorded: 2 [64422 | 64429]`，
  `survivors at return=["64429"]` → 真实孤儿且其 stderr 后续打出 `BOUND`（确实在渲染）；
  新代码 `spawns recorded: 1`，`survivors=[]`。另测：同 tick 的 ensure+dispose → **0 spawn**。
- F2：旧 `[{call:2,at:0,alive:true},{call:3,at:0,alive:true}]`；新三者 `at:707, alive:false`
  且**三个调用返回同一个 teardown promise**。
- F4：旧 `sender=null in 2681ms`（卡在 write(2)）；新 `sender=connected in 53ms`。
- F6：5 次超时连接共享一个 AbortController → 旧 `after=5`，新 `after=0`。
- F7：无换行洪泛下旧缓冲 `2097152`（线性增长=无界），新 `max=12288`（不随输入增长）。

验证还发现 5 个新问题，已修 4 个（见下方），保留 1 个残余。

Task 7 修复验证: complete (65/65；typecheck 0；孤儿 CLEAN)

## 验证追加修复

- **N2（Medium，真实功能缺陷）**：socket 路径**从未传给 helper**（实测 `helper received argv: []`）。
  原生契约是"从 argv[1] 读 socket 路径，否则用默认值"，所以非默认 `Config.socketPath` 永远无法通信，
  且每次 send 都退休并重启一次子进程（`after send #1: spawns=2 … #3: spawns=4`）。
  修复：supervisor 无条件把 `socketPath` 追加到 argv。
  **我原来的测试之所以漏掉它**：我自己显式传了 `helperArgs: [slow, s.sock]`，恰好掩盖了 `apply()` 的真实形态——
  这是"测试固化了错误形状"的典型。新测试断言**最后一个参数**（node 形态下 argv 是 `[node, script, ...args]`，
  真实 helper 是 `[binary, socket]`，两者 socket 都在末尾）。
- **N1（Low，后果致命）**：抛异常的日志 sink 会逃出 "never rejects" 契约——在流监听器内是
  uncaught exception（exit 43），在 spawn 延续里是 unhandled rejection（exit 42，杀掉会话）。
  修复：`safeSink` 包裹全部 sink 调用；启动路径补 `.catch` 作纵深防御。
- **N3（Low）**：`onStdout` 声明为 `(chunk: string)` 但实际收到 Buffer → 改为 `Buffer`。
- **N4（Low）**：supervisor 共享重启的返回路径漏了 `alive` 检查 → 已补，避免交回已死 sender 静默丢一帧。
- **N5（Low，残余，不修）**：卸载最坏阻塞 `connectTimeoutMs + graceMs`（默认约 13s），
  因为 connect 轮询不可取消。旧代码同样如此，**非回归**；修它需要给 `startHelper` 加 AbortSignal 贯穿，
  收益小于复杂度，记录为已知限制。
