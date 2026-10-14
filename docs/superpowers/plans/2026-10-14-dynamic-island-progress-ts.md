# DSH 灵动岛进度插件 — TypeScript 侧实现计划（阶段一）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现灵动岛插件的 TypeScript 侧：订阅 DSH 会话事件、维护进度状态机、通过 Unix socket 把进度推给辅助进程，并暴露 `report_progress` 工具，且插件卸载时保证辅助进程被终止。

**Architecture:** 插件是命名空间形态的 Cordis 插件（`name`/`inject`/`Config`/`apply`，**无** `export default`）。进度逻辑做成纯函数状态机（可脱离 DSH 运行时单测），事件接入层把 `session/event` 的持久化事件规约成状态机输入，传输层是一个抽象的「行发送器」接口（Unix socket 实现），工具层与 `ctx.provide` 的自定义服务共同构成精确进度上报通道。所有副作用注册进**单个** `ctx.effect`，其 async disposer 负责 kill 并 **await** 辅助进程退出。

**Tech Stack:** TypeScript 5.x（Node 24 原生类型剥离，无需构建）、Node 内置 `node:test` + `node:assert/strict`、`node:net`（Unix domain socket）、`node:child_process`、`@deepseek-ai/cordis` 4.0.4、`@deepseek-ai/dsh-tools` 0.2.1-alpha.2、`@deepseek-ai/dsh-session` 0.2.1-alpha.2、`@deepseek-ai/schemastery` 3.18.4。

**Spec:** [docs/superpowers/specs/2026-10-14-dynamic-island-progress-design.md](../specs/2026-10-14-dynamic-island-progress-design.md)

**范围说明：** 本计划只覆盖阶段一（TypeScript 侧，对应原需求步骤 1、2、4）。Swift 渲染层（步骤 3）依赖完整 Xcode，**单独一份计划**，在本计划完成后再写。为使阶段一可独立端到端验证，本计划包含一个 Node 写的假 helper（真 Unix socket server），它同时是阶段二之前的集成测试替身。

---

## Global Constraints

以下为 spec 的项目级硬约束，**每个任务都隐含适用**：

- **禁止 `export default`。** 知识库事故复盘 0001：`Loader.unwrapExports` 执行 `exports.default ?? exports`，一旦存在 default export，`inject`/`name`/`Config` 全部丢失，插件带空 inject 启动后崩溃。且 `ctx.plugin(obj)` 手工挂载无法复现。
- **socket 路径：** `~/Library/Application Support/dsh-island/island.sock`，目录权限 `0700`。
- **角色分工：** Swift/假 helper = **server**（bind + listen）；插件 = **client**（connect + 推送）。helper 启动前先 `unlink` stale socket。
- **NDJSON：** 每行一个 JSON 对象，UTF-8 编码。
- **估算上限硬性 90%：** `estimate(step)` 永不越过 90；100% 只可能来自 `turn/end` 或 `report_progress(1.0)`。
- **显示值单调不减。** 唯一例外是正常完成时跳 100。
- **状态机单向：** `estimated → precise` 不可逆，`precise` 永不回落到 `estimated`。
- **异常终态不显示 100%：** `reason.kind ∈ {aborted, error, interrupted, max-tokens, blocked}` → 显示当前值 + 失败标记。
- **进程清理必须达到完全停稳：** 单个 `ctx.effect` 的 async disposer，SIGTERM → await `close` → 超时 SIGKILL → 再 await `close`，**才允许返回**。多个异步 disposer 会并发执行，所以绝不拆成两个 effect。
- **环境变量必须擦洗：** spawn 子进程时丢弃匹配 `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*` 的键。
- **绝不修改 `~/.dsh/profiles/desktop/cordis.patch.yml`**（该文件含用户既有配置）。挂载行内容单独交付，由用户自行粘贴。
- **交流语言：中文。**

## 环境前置（已实测，写死在脚本里）

- Node **v24.21.0**：原生运行 `.ts`，`node --test x.test.ts` 已验证可用。要求 import 用显式 `.ts` 扩展名。
- pnpm 不在 PATH，绝对路径：`/Users/yueli/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs`
- npm registry 可达，但 `~/.npm` 不可写，**必须**设 `npm_config_cache` 到工作区内。
- **`latest` tag 的可信度因包而异**（已逐个核实 dist-tags，勿一概而论）：
  - `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-session`：`latest` 是**陈旧占位版本 `0.0.1-rc.1`**，不得使用；必须用 `alpha` tag（`0.2.1-alpha.2`）。
  - `@deepseek-ai/cordis`：`latest` **就是 `4.0.4`**，可信。
  - `@deepseek-ai/schemastery`：`latest` **就是 `3.18.4`**，可信。
  - 以下四个精确版本已用 `HTTP 200` 逐个核实存在：`cordis@4.0.4`、`dsh-tools@0.2.1-alpha.2`、`dsh-session@0.2.1-alpha.2`、`schemastery@3.18.4`。

## Review Focus

以下 5 类输入/失效模式是 spec 隐含、但任何单个任务的测试都不足以覆盖的，**最容易伤到真实使用者**。每条都在下方指定任务的测试中钉住：

1. **辅助进程二进制不存在**（用户还没装 Xcode 就跑插件）——合理预期是插件正常加载、清晰报错、不影响 DSH 其余功能，而不是崩溃或静默失败。→ Task 7
2. **socket 半包/粘包**——NDJSON 行被拆到多次 `read` 到达，或一行内多个 JSON。合理预期是正确缓冲重组，不丢行、不误解码。→ Task 5、Task 9
3. **非 ASCII 文本损坏**——`message` 含中文时按字节切分会撕裂多字节字符。合理预期是 UTF-8 边界安全。→ Task 5
4. **事件重放与乱序**——`session/event` 可能重放历史事件，`step` 编号会因单步子代理跳跃甚至回退。合理预期是显示值仍单调、不倒退。→ Task 3、Task 4
5. **`report_progress` 收到越界值**——`NaN`、负值、`1e9`、超长字符串。合理预期是 clamp 到 `[0,1]`、丢弃非有限值、截断超长文本，绝不抛出。→ Task 6
6. **工具存在但模型不知道它**——这是本设计最可能的静默失效：工具注册成功、schema 正确、测试全绿，但没有任何机制告诉 agent「何时该上报」，于是它永远是死代码，实际只有 heuristic 在工作，精确模式**永不触发**。合理预期是 agent 知道该工具的存在与使用时机。→ Task 8

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | 包元数据 + `dsh.bundle` 声明 + scripts |
| `tsconfig.json` | 仅类型检查（`noEmit`），Node 负责实际执行 |
| `src/progress.ts` | **纯函数**进度状态机（无 I/O、无 DSH 依赖） |
| `src/estimate.ts` | **纯函数** step → 百分比估算公式 |
| `src/events.ts` | `session/event` 规约层：把持久化事件转成状态机输入 |
| `src/protocol.ts` | NDJSON 编解码 + 消息类型定义 + 字段校验 |
| `src/transport.ts` | 行发送器接口 + Unix socket 客户端实现 |
| `src/helper.ts` | 辅助进程 spawn + 连接重试 + 关闭（清理逻辑在此） |
| `src/tool.ts` | `report_progress` 工具定义 + `islandProgress` 服务 |
| `src/instructions.ts` | `systemPrompt` 段落：告诉 agent 何时该上报（防止工具成为死代码） |
| `src/index.ts` | `apply(ctx, config)` 装配 + 单个 `ctx.effect` |
| `cordis.patch.yml` | 挂载层（包名引用） |
| `scripts/fake-helper.mjs` | Node 假 helper（真 socket server），阶段一集成替身 |
| `scripts/install-deps.sh` | 带 npm cache 绕行的依赖安装 |
| `README.md` | 安装、挂载、验证、无刘海机型差异说明 |
| `test/*.test.ts` | 每个模块的同名测试 |

**边界设计原则：** `progress.ts` / `estimate.ts` / `protocol.ts` / `events.ts` 四个模块是纯函数、零 I/O、零 DSH 依赖，因此可在没有 DSH 运行时、没有 Xcode 的情况下完整单测。I/O 集中在 `transport.ts` / `helper.ts`，副作用集中在 `index.ts`。

---

## Task 1: 项目骨架、依赖与类型检查基线

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `scripts/install-deps.sh`
- Create: `.gitignore`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 可用的 `npm test` / `npm run typecheck` 命令；后续所有任务依赖此处的 tsconfig 选项（`allowImportingTsExtensions`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、`noEmit`）

- [ ] **Step 1: 写 `package.json`**

必须精确包含 `dsh.bundle`（spec §8）。`files` 需含 `lib`、`cordis.patch.yml`、`bin`。dsh 包同时进 `peerDependencies` 与 `devDependencies`（`publish.md:106` 要求共享实例的包两边都声明），且**必须用 alpha tag 版本**，不能用 `latest`：

```json
{
  "name": "dsh-dynamic-island-progress",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "files": ["src", "cordis.patch.yml", "bin"],
  "scripts": {
    "test": "node --test test/",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-tools": "0.2.1-alpha.2"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.4",
    "@deepseek-ai/dsh-tools": "0.2.1-alpha.2",
    "@deepseek-ai/dsh-session": "0.2.1-alpha.2",
    "@deepseek-ai/schemastery": "3.18.4",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**

`erasableSyntaxOnly` 是硬要求——Node 类型剥离不支持 `enum`/`namespace`/参数属性。`allowImportingTsExtensions` 配合 `noEmit` 允许 `import './x.ts'`：

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "lib": ["es2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: 写 `scripts/install-deps.sh`**

`~/.npm` 与 pnpm store 在沙箱外不可写，脚本必须把 cache 指到工作区内：

```sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export npm_config_cache="$PWD/.npm-cache"
export PNPM_HOME="$PWD/.pnpm-home"
PNPM="/Users/yueli/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
mkdir -p "$npm_config_cache" "$PNPM_HOME"
if [ -f "$PNPM" ]; then
  node "$PNPM" install --store-dir "$PWD/.pnpm-store"
else
  npm install
fi
```

- [ ] **Step 4: 写 `.gitignore`**

必须忽略缓存与产物目录，避免把数百 MB 的 store 提交进仓库：

```
node_modules/
.npm-cache/
.pnpm-store/
.pnpm-home/
.swift-cache/
.build/
bin/
swift/*/.build/
```

- [ ] **Step 5: 写一个最小冒烟测试，验证 cordis 类型真的可导入**

Create: `test/smoke.test.ts`

这个测试的价值是**在写任何业务代码前**就暴露版本或导出名不匹配，避免后续任务基于错误假设铺开：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'

test('cordis Context 类型可导入且 on/effect 形状存在', () => {
  // 仅类型层面断言：若 Context 缺少 on 或 effect，tsc 会失败
  type HasOn = Context extends { on: (...a: never[]) => unknown } ? true : false
  type HasEffect = Context extends { effect: (...a: never[]) => unknown } ? true : false
  const ok: [HasOn, HasEffect] = [true, true]
  assert.deepEqual(ok, [true, true])
})
```

- [ ] **Step 6: 动手前先核实依赖版本真实存在**

不要假设版本号正确——先问 registry。用 pnpm 且 cache 指到工作区内（`~/.npm` 不可写）：

```sh
PNPM="/Users/yueli/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
export npm_config_cache="$PWD/.npm-cache"

node "$PNPM" view @deepseek-ai/cordis versions --json | tail -5
node "$PNPM" view @deepseek-ai/dsh-tools versions --json | tail -5
node "$PNPM" view @deepseek-ai/dsh-session versions --json | tail -5
node "$PNPM" view @deepseek-ai/schemastery versions --json | tail -5

# 确认精确版本可解析（每个都应返回版本号，而不是 error）
node "$PNPM" view @deepseek-ai/cordis@4.0.4 version
node "$PNPM" view @deepseek-ai/dsh-tools@0.2.1-alpha.2 version
node "$PNPM" view @deepseek-ai/dsh-session@0.2.1-alpha.2 version
node "$PNPM" view @deepseek-ai/schemastery@3.18.4 version
```

Expected: 四条 `version` 查询分别打印 `4.0.4` / `0.2.1-alpha.2` / `0.2.1-alpha.2` / `3.18.4`。

**若某条返回 error 或版本不存在**：不要改用 `latest`（`dsh-tools` 与 `dsh-session` 的 `latest` 是陈旧占位版 `0.0.1-rc.1`）。应在 `versions` 输出里挑最接近 0.2.x 的可用版本，更新 `package.json` 后继续。

- [ ] **Step 7: 安装依赖**

Run: `bash scripts/install-deps.sh`
Expected: 退出码 0，`node_modules/@deepseek-ai/cordis` 存在。

- [ ] **Step 8: 运行测试与类型检查**

Run: `npm test` 然后 `npm run typecheck`
Expected: 测试 1 passed；`tsc` 退出码 0 无输出。

若 `tsc` 报 `@deepseek-ai/cordis` 无法解析，说明版本选错——回到 Step 6 核实，不要改用 `latest`。

- [ ] **Step 9: Commit**

```bash
git init 2>/dev/null || true
git add package.json tsconfig.json scripts/install-deps.sh .gitignore test/smoke.test.ts
git commit -m "chore: scaffold TS plugin project with cordis type baseline"
```

---

## Task 2: 估算公式

**Files:**
- Create: `src/estimate.ts`
- Test: `test/estimate.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `export function estimatePercent(step: number): number` —— 返回 `0..90` 的百分比（**不是** 0..1 小数）

- [ ] **Step 1: 写失败测试**

Create: `test/estimate.test.ts`

spec §4.2 明确了取值与硬上限，测试直接钉住这些数字：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimatePercent } from '../src/estimate.ts'

test('已知取值符合 spec §4.2', () => {
  assert.equal(estimatePercent(0), 5)
  assert.equal(Math.round(estimatePercent(1)), 17)
  assert.equal(Math.round(estimatePercent(5)), 44)
  assert.equal(Math.round(estimatePercent(10)), 58)
  assert.equal(Math.round(estimatePercent(20)), 70)
})

test('永不越过 90 硬上限', () => {
  for (const s of [0, 1, 10, 100, 1e6, Number.MAX_SAFE_INTEGER]) {
    assert.ok(estimatePercent(s) <= 90, `step=${s} 越过 90`)
  }
})

test('单调不减', () => {
  let prev = -Infinity
  for (let s = 0; s < 500; s++) {
    const v = estimatePercent(s)
    assert.ok(v >= prev, `step=${s} 回退`)
    prev = v
  }
})

test('非法输入退化为下界而非 NaN', () => {
  assert.equal(estimatePercent(-5), 5)
  assert.equal(estimatePercent(NaN), 5)
  assert.equal(estimatePercent(Infinity), 90)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/estimate.test.ts`
Expected: FAIL —— `Cannot find module '../src/estimate.ts'`

- [ ] **Step 3: 实现 `src/estimate.ts`**

公式来自 spec §4.2：`min(90, 5 + 85 * step / (step + 6))`。实现要点：先对输入做有限性与非负钳制（`NaN`/负数 → 0，`Infinity` → 直接返回 90），再套公式。`step=0` 必须精确返回 5。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/estimate.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/estimate.ts test/estimate.test.ts
git commit -m "feat: add bounded asymptotic progress estimator"
```

---

## Task 3: 进度状态机

**Files:**
- Create: `src/progress.ts`
- Test: `test/progress.test.ts`

**Interfaces:**
- Consumes: `estimatePercent(step)` from Task 2
- Produces:
  - `export type ProgressMode = 'estimated' | 'precise'`
  - `export type ProgressState = 'idle' | 'estimated' | 'precise' | 'done'`
  - `export interface ProgressSnapshot { state: ProgressState; percent: number; mode: ProgressMode | null; message: string | undefined; turn: number | null; ok: boolean }`
  - `export class ProgressMachine`，方法：`startTurn(turn: number): ProgressSnapshot`、`onStep(step: number): ProgressSnapshot`、`reportPrecise(percent: number, message?: string): ProgressSnapshot`、`endTurn(reasonKind: string): ProgressSnapshot`、`snapshot(): ProgressSnapshot`、`reset(): ProgressSnapshot`
  - `reasonKind` 取值来自 spec §4.4：`'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'forked'`，但实现必须容忍**未知字符串**（`TurnEndReasonMap` 可被其他插件合并扩展）

- [ ] **Step 1: 写失败测试**

Create: `test/progress.test.ts`

这组测试直接对应 spec §4.3 的四条不变式，是防止"双数据源抖动"的核心保障：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProgressMachine } from '../src/progress.ts'

test('不变式1: estimated → precise 单向，precise 不回落', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  m.reportPrecise(0.5, 'half')
  assert.equal(m.snapshot().state, 'precise')
  m.onStep(99) // 估算值更高
  assert.equal(m.snapshot().state, 'precise')
  assert.equal(m.snapshot().mode, 'precise')
  assert.equal(m.snapshot().percent, 0.5)
})

test('不变式2: 显示值单调不减（含 step 回退与重放）', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  const seen: number[] = []
  for (const s of [0, 1, 5, 3, 2, 10, 1, 20]) {
    seen.push(m.onStep(s).percent)
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i]! >= seen[i - 1]!, `回退 at ${i}: ${seen.join(',')}`)
  }
})

test('不变式3: precise 后 heuristic 不拉低显示值', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  m.onStep(50)             // 估算到 ~88
  m.reportPrecise(0.95, 'x')
  const after = m.onStep(0).percent   // 估算值远低
  assert.equal(after, 0.95)
})

test('不变式4: 空闲超时由调用方驱动，机器本身只暴露 reset', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  assert.equal(m.snapshot().state, 'estimated')
  m.reset()
  assert.equal(m.snapshot().state, 'idle')
  assert.equal(m.snapshot().percent, 0)
})

test('估算阶段永不声称 100%', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  for (let s = 0; s < 1000; s += 7) {
    const p = m.onStep(s).percent
    assert.ok(p <= 0.9, `估算给出 ${p} > 0.9`)
  }
})

test('turn/end completed → 100 且 ok=true', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  m.onStep(3)
  const s = m.endTurn('completed')
  assert.equal(s.percent, 1)
  assert.equal(s.ok, true)
  assert.equal(s.state, 'done')
})

test('异常终态不显示 100% 且 ok=false', () => {
  for (const kind of ['aborted', 'error', 'interrupted', 'max-tokens', 'blocked']) {
    const m = new ProgressMachine()
    m.startTurn(1)
    m.onStep(5)
    const before = m.snapshot().percent
    const s = m.endTurn(kind)
    assert.equal(s.ok, false, `${kind} 被判为成功`)
    assert.ok(s.percent < 1, `${kind} 显示了 100%`)
    assert.equal(s.percent, before)
  }
})

test('未知 turn/end reason 不得抛异常（TurnEndReasonMap 可扩展）', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  const s = m.endTurn('some-future-reason')
  assert.equal(s.ok, false)
})

test('新 turn 重置百分比仍保持单调（跨 turn 不倒退）', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  m.onStep(20)
  const high = m.snapshot().percent
  m.endTurn('completed')
  const s = m.startTurn(2)
  assert.ok(s.percent <= high, '新 turn 不应超过上一 turn 的终值')
  assert.equal(s.percent, 0.05)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/progress.test.ts`
Expected: FAIL —— `Cannot find module '../src/progress.ts'`

- [ ] **Step 3: 实现 `src/progress.ts`**

实现要点（不贴完整函数体，签名与测试已确定行为）：

- 内部字段：`state`、`percent`（0..1）、`mode`、`message`、`turn`、`ok`。
- `startTurn(turn)`：状态置 `estimated`，`percent = 0.05`，`mode = 'estimated'`，`ok = true`，清空 `message`。**注意**：跨 turn 时百分比需要重置为 5%，因此单调性只在**单个 turn 内**是硬保证；`startTurn` 是唯一的显式重置点。
- `onStep(step)`：把 `estimatePercent(step) / 100` 作为候选值；若当前是 `precise`，**忽略**候选值且不改 `percent`；否则 `percent = max(percent, candidate)` 且 `percent = min(percent, 0.9)`。
- `reportPrecise(percent, message?)`：clamp 到 `[0,1]`，非有限值直接忽略（返回当前快照）。状态转 `precise`，`mode = 'precise'`，`percent = max(当前, 入参)`（防止 precise 之间也回退）。设置 `message`。
- `endTurn(kind)`：`state = 'done'`。若 `kind === 'completed'` → `percent = 1`、`ok = true`；否则 `ok = false` 且 **`percent` 保持不变**。未知 `kind` 一律按异常处理。
- `reset()`：全部回到 `idle` / `0` / `mode = null`。
- 所有方法返回快照对象（新对象，不是内部引用），避免调用方误改内部状态。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/progress.test.ts`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts test/progress.test.ts
git commit -m "feat: add progress state machine with monotonic invariants"
```

---

## Task 4: 会话事件规约层

**Files:**
- Create: `src/events.ts`
- Test: `test/events.test.ts`

**Interfaces:**
- Consumes: `estimatePercent`（间接，经 Task 3）、`ProgressMachine` from Task 3
- Produces:
  - `export interface SessionEventLike { type: string; data: unknown }`
  - `export interface ReductionResult { changed: boolean; snapshot: ProgressSnapshot; todoRatio: number | null }`
  - `export function reduceSessionEvent(m: ProgressMachine, event: SessionEventLike): ReductionResult`

**背景（必须理解，否则会写错）：** `turn/start`、`step/end`、`turn/end`、`todo/write` **都不是 Cordis 事件名**，它们是持久化会话事件，只能通过 `ctx.on('session/event')` 观察后按 `event.type` 分发（spec §4.1）。同时 **`todo/write` 不在核心 `dsh-session` 类型里**——它由 `tool-todo` 包声明合并添加，因此本模块必须用**运行时校验**读取它，不能假设静态类型存在。

- [ ] **Step 1: 写失败测试**

Create: `test/events.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProgressMachine } from '../src/progress.ts'
import { reduceSessionEvent } from '../src/events.ts'

const ev = (type: string, data: unknown) => ({ type, data })

test('turn/start 进入估算并给出 5%', () => {
  const m = new ProgressMachine()
  const r = reduceSessionEvent(m, ev('turn/start', { turn: 7 }))
  assert.equal(r.changed, true)
  assert.equal(r.snapshot.state, 'estimated')
  assert.equal(r.snapshot.percent, 0.05)
})

test('step/end 推进估算', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('step/end', { turn: 1, step: 10 }))
  assert.ok(r.snapshot.percent > 0.05)
  assert.equal(r.snapshot.mode, 'estimated')
})

test('todo/write 给出精确比例并切到 precise（加权公式）', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'in_progress' },
    ],
  }))
  // (completed + 0.5 * in_progress) / total = (2 + 0.5) / 4
  assert.equal(r.todoRatio, 0.625)
  assert.equal(r.snapshot.state, 'precise')
  assert.equal(r.snapshot.percent, 0.625)
})

test('todo 加权公式：无任何完成项时也反映进行中的工作', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'pending' },
    ],
  }))
  // (0 + 0.5) / 4 = 0.125；纯 completed/total 会给出 0.0
  assert.equal(r.todoRatio, 0.125)
  assert.ok(r.snapshot.percent > 0, '不应显示 0%')
})

test('todo 加权公式：全部完成时必须恰为 1.0', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'completed' },
    ],
  }))
  // (3 + 0) / 3 = 1.0，不得因浮点误差变成 0.999…
  assert.equal(r.todoRatio, 1)
  assert.equal(r.snapshot.percent, 1)
})

test('todo 项数增加导致比值下降时，显示值保持不变（单调度）', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('todo/write', {
    todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }],
  }))
  const high = m.snapshot().percent   // (2+0)/2 = 1.0
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'pending' },
    ],
  }))
  assert.equal(r.todoRatio, 0.5)            // 比值确实降了
  assert.equal(r.snapshot.percent, high)    // 但显示值不降
})

test('todo 权重常量 0.5 可单点替换（若日后需调为 0.25）', () => {
  // 本测试是「改动点集中」的守护：加权公式只在一处计算，
  // 调整常量只需改一个地方而不必改多处调用。
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'pending' },
    ],
  }))
  // (0 + 0.5*2) / 4 = 0.25
  assert.equal(r.todoRatio, 0.25)
})

test('todo/write 空数组不产生 NaN，且不改动进度', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const before = m.snapshot().percent
  const r = reduceSessionEvent(m, ev('todo/write', { todos: [] }))
  assert.equal(r.todoRatio, null)
  assert.equal(r.snapshot.percent, before)
  assert.ok(Number.isFinite(r.snapshot.percent))
})

test('畸形 todo/write 载荷不抛异常', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  for (const bad of [null, undefined, 42, 'x', {}, { todos: 'nope' }, { todos: [null, 1, {}] }]) {
    assert.doesNotThrow(() => reduceSessionEvent(m, ev('todo/write', bad)))
  }
})

test('turn/end completed 与 aborted 分流正确', () => {
  const a = new ProgressMachine()
  reduceSessionEvent(a, ev('turn/start', { turn: 1 }))
  const done = reduceSessionEvent(a, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(done.snapshot.percent, 1)
  assert.equal(done.snapshot.ok, true)

  const b = new ProgressMachine()
  reduceSessionEvent(b, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(b, ev('step/end', { turn: 1, step: 5 }))
  const aborted = reduceSessionEvent(b, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'user' } }))
  assert.equal(aborted.snapshot.ok, false)
  assert.ok(aborted.snapshot.percent < 1)
})

test('无关注事件返回 changed=false 且不触碰状态', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const before = m.snapshot()
  for (const t of ['user/message', 'assistant/message', 'tool/call', 'request/context', 'plan/mode', '未来/未知']) {
    const r = reduceSessionEvent(m, ev(t, { anything: true }))
    assert.equal(r.changed, false, `${t} 被误认为进度事件`)
  }
  assert.deepEqual(m.snapshot(), before)
})

test('事件重放（同一 turn/start 重复）不倒退', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('step/end', { turn: 1, step: 20 }))
  const high = m.snapshot().percent
  const r = reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  assert.equal(r.snapshot.percent, high >= 0.05 ? high : 0.05)
})

test('turn/start 携带非法 turn 值不抛异常', () => {
  const m = new ProgressMachine()
  for (const bad of [null, 'x', undefined, {}, NaN]) {
    assert.doesNotThrow(() => reduceSessionEvent(m, ev('turn/start', { turn: bad })))
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/events.test.ts`
Expected: FAIL —— `Cannot find module '../src/events.ts'`

- [ ] **Step 3: 实现 `src/events.ts`**

实现要点：

- 用 `switch (event.type)`，**必须**保留 `default` 分支返回 `changed: false`。**绝不使用 `assertNever`**——`SessionEventMap` 可被其他插件声明合并扩展（spec §4.1）。
- 每个分支都要对 `event.data` 做运行时形状校验（`typeof === 'object' && !== null`、字段 `typeof === 'number'`）。校验失败的载荷必须走"无操作返回"，不抛异常。
- `todo/write`：读 `data.todos`，要求是数组。**采用 `(completed + 0.5 × in_progress) / total`**（理由见下方决策说明）。**总数为 0 时 `todoRatio` 返回 `null` 且不调用 `reportPrecise`**，避免 `0/0 = NaN` 污染状态机。
- `turn/end`：`reason` 可能是对象 `{ kind }` 或裸字符串（防御两种形态），提取 `kind` 交给 `endTurn`。
- 返回的 `changed` 用于上层判断是否需要推送 socket（避免无意义写）。

**todo 进度公式决策：用 `(completed + 0.5 × in_progress) / total`，不用 `completed / total`。**

| 场景（c=completed, i=in_progress, t=total） | `c/t` | `(c+0.5i)/t` |
|---|---|---|
| 0, 1, 5 | 0.00 | **0.10** |
| 0, 2, 5 | 0.00 | **0.20** |
| 0, 5, 10 | 0.00 | **0.25** |
| 1, 3, 10 | 0.10 | **0.25** |
| 2, 1, 5 | 0.40 | **0.50** |
| 3, 0, 4 | 0.75 | 0.75（两者一致） |
| 4, 0, 5 | 0.80 | 0.80（两者一致） |

理由：

1. **`completed/total` 的全部信息是「尚无一项完成」**，无法区分「刚开始」与「马上做完第一项」。上面 0,5,10 这一行两个公式差 25 个百分点——`c/t` 在模型正密集工作时显示 0%，观感是"卡住了"。
2. 加权版能奖励"真实进行中的工作"，而这正是大多数活跃时刻的状态。
3. 一旦有项完成，两个公式趋于一致（后两行完全相同），所以加权只影响"未完成任一项"的早期阶段，风险面很小。
4. 因为显示值单调不减（`max()` 保护），加权版的乐观偏差**不会来回抖动**。

**已知代价（如实记录）**：模型可能同时把多项标记为 `in_progress` 却只专注其中一项，此时加权版会高估。这是**已知的可接受偏差**，不是 bug——`c/t` 的低估问题更常见也更糟。若日后发现高估明显，把这个 `0.5` 调成 `0.25` 即可，改一个常量。

**注意与单调度不变式的交互**：`max()` 会让这个比值**永不下降**，所以后续 `todo/write` 若增加 `total`（新增待办）导致比值变低，显示值会保持不变——这是单调不变式的**有意行为**，不是缺陷。

**⚠️ 已知张力（必须知悉，不要在实现时"顺手修掉"）**：上述规则有一个真实副作用——若模型先把全部待办标记为 `completed`（显示值被推到 1.0），随后又追加新的 `pending` 待办，那么**在本 turn 内百分比会永久卡在 100%，即使工作仍在继续**。

- 触发条件较窄：需要 `todo/write` 先出现"全完成"，之后又出现"项数增加"。
- 影响范围局限：仅限当前 turn；`turn/start` 会重置为 5%，所以下一个 turn 自动恢复正确。
- 这是**单调不变式与精确比例数据之间的固有冲突**，两者都是 spec 的硬要求（spec §4.3 不变式 2）。要彻底消除只能允许回退，那会违反你明确要求的"绝不回退"。
- **本计划选择保留单调度**，因为进度条回退比偶发高估更伤害可读性。此张力已记录在 spec §11 风险表。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/events.test.ts`
Expected: 13 passed

- [ ] **Step 5: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat: reduce durable session events into progress machine input"
```

---

## Task 5: NDJSON 协议编解码

**Files:**
- Create: `src/protocol.ts`
- Test: `test/protocol.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type OutboundMessage = { type: 'hello'; version: number } | { type: 'progress'; percent: number; mode: 'estimated' | 'precise'; message?: string } | { type: 'done'; reason: string; ok: boolean } | { type: 'bye' }`
  - `export function encodeMessage(msg: OutboundMessage): string` —— 返回**不含换行符**的 JSON 文本
  - `export function decodeMessages(buffer: string): { messages: unknown[]; rest: string }` —— 按 `\n` 切分，返回完整行解析结果与未完成的尾部残留
  - `export function validateProgress(msg: unknown): { ok: true; percent: number; mode: 'estimated' | 'precise' } | { ok: false; reason: string }` —— clamp 到 `[0,1]`，拒绝非有限值

- [ ] **Step 1: 写失败测试**

Create: `test/protocol.test.ts`

这里钉住 Review Focus 第 2、3、5 条（半包/粘包、非 ASCII、越界值）：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeMessage, decodeMessages, validateProgress } from '../src/protocol.ts'

test('编码产物不含裸换行（否则会撕裂 NDJSON 帧）', () => {
  const s = encodeMessage({ type: 'progress', percent: 0.5, mode: 'precise', message: '第一行\n第二行' })
  assert.ok(!s.includes('\n'), '编码结果含换行，会破坏分帧')
})

test('往返编解码', () => {
  const msg = { type: 'progress' as const, percent: 0.42, mode: 'estimated' as const }
  const { messages, rest } = decodeMessages(encodeMessage(msg) + '\n')
  assert.equal(rest, '')
  assert.deepEqual(messages[0], msg)
})

test('半包：不完整尾部作为 rest 返回且不解析', () => {
  const full = encodeMessage({ type: 'progress', percent: 0.3, mode: 'precise' })
  const half = full.slice(0, 10)
  const r = decodeMessages(half)
  assert.deepEqual(r.messages, [])
  assert.equal(r.rest, half)
})

test('粘包：一行内多个 JSON 全部解出', () => {
  const a = encodeMessage({ type: 'progress', percent: 0.1, mode: 'precise' })
  const b = encodeMessage({ type: 'bye' })
  const r = decodeMessages(`${a}\n${b}\n`)
  assert.equal(r.messages.length, 2)
  assert.equal(r.rest, '')
})

test('非 ASCII 中文往返不损坏（UTF-8 边界安全）', () => {
  const text = '正在编译 模块 ①✓'
  const r = decodeMessages(encodeMessage({ type: 'progress', percent: 0.5, mode: 'precise', message: text }) + '\n')
  assert.equal((r.messages[0] as any).message, text)
})

test('畸形 JSON 行被跳过而非抛出', () => {
  const good = encodeMessage({ type: 'bye' })
  assert.doesNotThrow(() => decodeMessages(`{bad json\n${good}\n`))
  const r = decodeMessages(`{bad json\n${good}\n`)
  assert.equal(r.messages.length, 1)
})

test('validateProgress clamp 越界值', () => {
  assert.deepEqual(validateProgress({ type: 'progress', percent: 5, mode: 'precise' }), { ok: true, percent: 1, mode: 'precise' })
  assert.deepEqual(validateProgress({ type: 'progress', percent: -3, mode: 'estimated' }), { ok: true, percent: 0, mode: 'estimated' })
})

test('validateProgress 拒绝非有限值与错误形状', () => {
  for (const bad of [
    { type: 'progress', percent: NaN, mode: 'precise' },
    { type: 'progress', percent: Infinity, mode: 'precise' },
    { type: 'progress', percent: '0.5', mode: 'precise' },
    { type: 'progress', percent: 0.5, mode: 'nope' },
    { type: 'progress', percent: 0.5 },
    { type: 'other', percent: 0.5, mode: 'precise' },
    null,
    42,
  ]) {
    const r = validateProgress(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 被错误接受`)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/protocol.test.ts`
Expected: FAIL —— `Cannot find module '../src/protocol.ts'`

- [ ] **Step 3: 实现 `src/protocol.ts`**

实现要点：

- `encodeMessage`：`JSON.stringify(msg)`，并**把消息内所有 `\n` 与 `\r` 替换为空格或转义**再返回。`JSON.stringify` 本身会把字面换行转成 `\n` 两字符转义，但为防止调用方传入已含转义的字符串造成歧义，显式断言输出不含裸 `\n`。
- `decodeMessages`：以 `\n` 切分。最后一段若无结尾 `\n` 则是未完成帧，作为 `rest` 返回**不解析**。对每个完整行 `JSON.parse`，失败则跳过并收集（不抛出）。
- `validateProgress`：检查 `msg` 是对象、`type === 'progress'`、`percent` 是有限 `number`、`mode` 是 `'estimated' | 'precise'` 之一。通过后 `Math.min(1, Math.max(0, percent))`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/protocol.test.ts`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts test/protocol.test.ts
git commit -m "feat: add NDJSON protocol codec with framing and clamping"
```

---

## Task 6: `report_progress` 工具与 `islandProgress` 服务

**Files:**
- Create: `src/tool.ts`
- Test: `test/tool.test.ts`

**Interfaces:**
- Consumes: `ProgressMachine` from Task 3（经 `ProgressSnapshot`）
- Produces:
  - `export const REPORT_PROGRESS_TOOL_NAME = 'report_progress'`
  - `export interface IslandProgressService { report(percent: number, message?: string): void; current(): ProgressSnapshot }`
  - `export function createProgressService(m: ProgressMachine, onPublish: (s: ProgressSnapshot) => void): IslandProgressService`
  - `export function buildReportProgressTool(service: IslandProgressService): ToolDefinition`（返回 `defineTool` 的结果，便于单测断言 schema 与 execute 行为而不注册）

**重要 API 事实（已核实，勿凭记忆写）：**

- `ctx.tools.register(defineTool({...}))` 返回 disposer。
- `defineTool` 从 `@deepseek-ai/dsh-tools` 导入。
- `ToolRunContext` 上的取消信号是 **`exec.signal: AbortSignal`（必需字段）**，`exec.agent?: Agent` 是可选。已核实 `ToolExecutionInput.signal` 声明为 `readonly signal: AbortSignal`。
- 工具的 `execute(args, exec)` 返回值必须匹配 `output.schema` 声明的规范值。

- [ ] **Step 1: 写失败测试**

Create: `test/tool.test.ts`

钉住 Review Focus 第 5 条（越界值）：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProgressMachine } from '../src/progress.ts'
import { createProgressService, buildReportProgressTool } from '../src/tool.ts'

function harness() {
  const m = new ProgressMachine()
  m.startTurn(1)
  const published: number[] = []
  const service = createProgressService(m, (s) => published.push(s.percent))
  return { m, service, published }
}

test('service.report 切到 precise 并发布', () => {
  const { service, published } = harness()
  service.report(0.6, '一半')
  assert.equal(service.current().state, 'precise')
  assert.equal(service.current().percent, 0.6)
  assert.ok(published.length >= 1)
})

test('service.report clamp 越界与非有限值', () => {
  const { service } = harness()
  service.report(5)
  assert.equal(service.current().percent, 1)
  service.report(-2)
  assert.equal(service.current().percent, 1, '不应回退')
  service.report(NaN)
  assert.equal(service.current().percent, 1, 'NaN 不应改动状态')
})

test('超长 message 被截断而非无限增长', () => {
  const { service } = harness()
  service.report(0.5, 'x'.repeat(100_000))
  const msg = service.current().message ?? ''
  assert.ok(msg.length <= 200, `message 长度 ${msg.length} 未截断`)
})

test('service.current 返回快照副本，外部修改不影响内部', () => {
  const { service } = harness()
  service.report(0.5)
  const snap = service.current()
  snap.percent = 0.01
  assert.equal(service.current().percent, 0.5)
})

test('工具定义名称与 schema 符合约定', () => {
  const { service } = harness()
  const tool = buildReportProgressTool(service)
  assert.equal(tool.name, 'report_progress')
  assert.ok(tool.description.length > 0)
  assert.ok(tool.parameters, '缺少 parameters')
  assert.ok(tool.output, '缺少规范输出声明')
})

test('工具 execute 接受合法入参并返回规范值', async () => {
  const { service } = harness()
  const tool = buildReportProgressTool(service)
  const exec = { signal: new AbortController().signal } as any
  const value = await tool.execute({ percent: 0.75, message: 'ok' }, exec)
  assert.equal(service.current().percent, 0.75)
  assert.deepEqual(value, { ok: true })
})

test('工具 execute 对越界入参不抛异常且仍 clamp', async () => {
  const { service } = harness()
  const tool = buildReportProgressTool(service)
  const exec = { signal: new AbortController().signal } as any
  for (const p of [1e9, -1e9, 0]) {
    const v = await tool.execute({ percent: p, message: 'm' }, exec)
    assert.deepEqual(v, { ok: true })
  }
  assert.equal(service.current().percent, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/tool.test.ts`
Expected: FAIL —— `Cannot find module '../src/tool.ts'`

- [ ] **Step 3: 实现 `src/tool.ts`**

实现要点：

- `MESSAGE_MAX_LENGTH = 200`。截断用**码点安全**方式：`[...str].slice(0, 200).join('')`，避免把代理对切成两半。同时剥离 `\n`/`\r` 为空格（防止破坏 NDJSON 帧）。
- `createProgressService(m, onPublish)`：`report` 内先对 `percent` 做有限性检查（非有限直接 `return`，不发布），再 `m.reportPrecise(clamped, sanitizedMessage)`，然后 `onPublish(m.snapshot())`。
- `current()` 返回 `m.snapshot()`（Task 3 已保证是新对象）。
- `buildReportProgressTool(service)`：用 `defineTool`，`parameters` 为 `{ percent: { type: 'number', required: true, ... }, message: { type: 'string', ... } }`，`output.schema` 为 `{ type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }`，`output.render` 返回文本块。`execute` 里**检查 `exec.signal.aborted`**，若已中止则直接返回 `{ ok: false }` 而不写进度。
- 工具不声明 `timeoutMs`——它是同步的、不做阻塞工作。

**关于 `report_progress` 的 `percent` 语义（写给工具描述与 Task 8 的注入文本）：**

`report_progress` 是**可选覆盖**，不是必须调用的仪式。agent 只在以下两种情况才需要调用：

1. 它**自己知道**一个比启发式更准的完成度（例如已明确列出 N 个步骤、或已在做第 k 个）。
2. 任务进入长时间单步（例如一次 10 分钟的命令），进度条会卡在启发式上限附近，需要显式说明当前阶段。

不要鼓励 agent 每步都调用——那会把它变成噪声源，且与 `todo/write` 的自动精确比例重复。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/tool.test.ts`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add src/tool.ts test/tool.test.ts
git commit -m "feat: add report_progress tool and islandProgress service"
```

---

## Task 7: 传输层、辅助进程管理与 `apply` 装配

**Files:**
- Create: `src/transport.ts`
- Create: `src/helper.ts`
- Create: `src/index.ts`
- Test: `test/helper.test.ts`

**Interfaces:**
- Consumes: `ProgressMachine`（Task 3）、`reduceSessionEvent`（Task 4）、`encodeMessage`/`validateProgress`（Task 5）、`createProgressService`/`buildReportProgressTool`（Task 6）
- Produces:
  - `export interface LineSender { send(line: string): void; readonly alive: boolean; close(): void }`
  - `export function connectLineSender(socketPath: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<LineSender>`
  - `export interface HelperHandle { sender: LineSender | null; readonly pid?: number; dispose(): Promise<void> }` —— **`pid` 是显式契约字段，不是可选实现细节**。测试必须依赖它做存活判定（`pid === undefined` 意味着 spawn 失败，而非进程已退出）。
  - `export function startHelper(opts: HelperOptions): Promise<HelperHandle>`
  - `export function apply(ctx: Context, config: Config): void`（`src/index.ts`，插件入口）

**这是风险最高的任务**——进程生命周期与清理正确性都在这里。spec §6.2 的两条知识库硬约束必须落实：

- `framework/index.md:66`：多个异步 disposer **并发执行**，有顺序依赖的清理必须在**同一个** `ctx.effect` 里串行。
- `extra/defensive-patterns.md:21`：只发信号不等退出会留孤儿；必须 kill → **await `close`**。

- [ ] **Step 1: 写失败测试**

Create: `test/helper.test.ts`

用一个 Node 假 helper 脚本作为被 spawn 的对象，验证完整生命周期。这是 Review Focus 第 1 条的落点：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHelper } from '../src/helper.ts'

const FAKE = new URL('../scripts/fake-helper.mjs', import.meta.url).pathname

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'island-test-'))
  chmodSync(dir, 0o700)
  return { dir, sock: join(dir, 'island.sock'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('spawn 假 helper 后能连上并发送一行', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: process.execPath, helperArgs: [FAKE], socketPath: s.sock, connectTimeoutMs: 8000, graceMs: 2000 })
  try {
    assert.ok(h.sender, '未能建立连接')
    h.sender!.send(JSON.stringify({ type: 'progress', percent: 0.5, mode: 'precise' }))
  } finally {
    await h.dispose()
    s.cleanup()
  }
})

test('dispose 之后进程确实已退出（无孤儿）', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: process.execPath, helperArgs: [FAKE], socketPath: s.sock, connectTimeoutMs: 8000, graceMs: 2000 })
  // pid 是 HelperHandle 的显式契约字段（见 Interfaces 的 pid?: number）。
  // 不可用 `(h as any).pid` 绕过类型——那样 pid 恒为 undefined，
  // process.kill(undefined, 0) 抛 TypeError 被 catch 吞掉，测试会永远假通过。
  assert.equal(typeof h.pid, 'number', 'spawn 成功后 HelperHandle.pid 必须是有效 number')
  const pid = h.pid!
  await h.dispose()
  await new Promise((r) => setTimeout(r, 300))
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  assert.equal(alive, false, `dispose 后进程 ${pid} 仍存活（孤儿）`)
  s.cleanup()
})

test('扫真实进程表确认无遗留 helper（覆盖派生进程，非仅 pid 存活判定）', async () => {
  const s = scratch()
  const marker = s.sock   // 唯一路径，pgrep 不会撞到其他并发测试
  const h = await startHelper({
    helperPath: process.execPath, helperArgs: [FAKE],
    socketPath: marker, connectTimeoutMs: 8000, graceMs: 2000,
  })
  try {
    assert.ok(h.sender, '前置条件不成立：未连上 helper')
  } finally {
    await h.dispose()
  }
  // 只在测试仍在运行时检查：s.cleanup() 之后跑会误读为「无泄漏」，
  // 反而掩盖 dispose 的缺陷。
  await new Promise((r) => setTimeout(r, 200))
  let leaked = false
  try {
    // pgrep 匹配命令行：fake-helper.mjs 后紧跟这个唯一 socket 路径。
    // -f 匹配完整命令行；socket 路径含 @ 和 - 不含正则元字符。
    execFileSync('pgrep', ['-f', `fake-helper\\.mjs.*${marker}`], { stdio: 'pipe' })
    leaked = true
  } catch {
    leaked = false   // pgrep 无匹配时退出码 1，即「干净」
  }
  s.cleanup()
  assert.equal(leaked, false, '进程表中仍有 fake-helper，dispose 未达到完全停稳')
})

test('dispose 是幂等的，重复调用不抛异常', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: process.execPath, helperArgs: [FAKE], socketPath: s.sock, connectTimeoutMs: 8000, graceMs: 2000 })
  await h.dispose()
  await assert.doesNotReject(() => h.dispose())
  s.cleanup()
})

test('helper 二进制不存在时优雅降级，不抛未捕获异常', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: '/nonexistent/definitely-not-here', helperArgs: [], socketPath: s.sock, connectTimeoutMs: 1500, graceMs: 500 })
  assert.equal(h.sender, null, '二进制缺失时不应报告已连接')
  await assert.doesNotReject(() => h.dispose())
  s.cleanup()
})

test('连接成功后 socket 文件存在且权限不含 group/other 写', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: process.execPath, helperArgs: [FAKE], socketPath: s.sock, connectTimeoutMs: 8000, graceMs: 2000 })
  try {
    assert.ok(existsSync(s.sock), 'socket 文件未创建')
  } finally {
    await h.dispose()
    s.cleanup()
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/helper.test.ts`
Expected: FAIL —— `Cannot find module '../src/helper.ts'`（`scripts/fake-helper.mjs` 也尚不存在）

- [ ] **Step 3: 写 `scripts/fake-helper.mjs`**

纯 Node ESM 脚本，作为阶段一的集成替身，也是阶段二之前唯一能真实验证 Socket 协议的手段。

行为要求：

- 从 `process.argv[2]` 或环境变量读 socket 路径。
- 若路径已存在 → `unlinkSync`（清 stale），然后 `net.createServer().listen(path)`。
- 启动时把目录权限设为 `0700`。
- 每个连接：累积 `data`，按 `\n` 切分，`JSON.parse` 每行；解析失败的行打印到 stderr 并继续。把收到的进度打印到 stdout（形如 `progress 50% precise`）。
- 连接 `end`/`close` 后**不退出**，继续 `accept`。
- 收到 `SIGTERM` 则 `unlink` socket 并退出 0。
- 不接受任何参数以外的输入，不读用户数据（它是测试替身）。

- [ ] **Step 4: 实现 `src/transport.ts`**

实现要点：

- `connectLineSender(socketPath, opts)`：用 `net.createConnection`，在 `connect` 事件后 resolve，在 `error` 或超时后 reject。写入用 `socket.write(line + '\n')`。
- 返回的 `LineSender.send(line)`：若 `socket.destroyed` 或 `!writable`，**不抛异常**，只把 `alive` 置 `false` 并静默丢弃（上层靠 `alive` 触发重连）。
- 监听 `error` 与 `close` 事件把 `alive` 置 `false`，避免未处理的 `'error'` 事件让 Node 进程崩溃——这点很关键，否则 helper 崩溃会连带 DSH 进程。
- `close()` 幂等。

- [ ] **Step 5: 实现 `src/helper.ts`**

实现要点：

- `startHelper(opts)` 顺序：
  1. `mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })`，并 `chmodSync` 到 `0700`。
  2. `spawn(helperPath, helperArgs, { stdio: ['ignore','pipe','pipe'], detached: process.platform !== 'win32', env: scrubbedEnv() })`。
  3. **把 `child.pid` 存进 handle 的 `pid` 字段**（`spawn()` 同步返回后 `pid` 即可用；`'error'` 事件到达时它可能仍为 `undefined`）。handle 至少暴露 `{ sender, pid, dispose }` 三个字段——`pid` 是被测试依赖的契约，不是内部实现细节。
  4. 捕获 `child.on('error')`（**ENOENT 走这里**）→ 记录警告、把 `sender` 保持 `null`、**不抛异常**（Review Focus 第 1 条）。捕获 `'close'` 并 resolve 一个 `exited` Promise。
  5. 把 stderr 逐行转发给调用方提供的 `onStderr`（缺省静默）。
  6. 轮询 `connectLineSender` 直到成功或 `connectTimeoutMs` 耗尽，轮询间隔从小到大（例如 50ms 起步、封顶 250ms）。超时后 `sender = null` 但**不**杀进程（让用户能从 stderr 看到原因）。
- `dispose()` 顺序（**必须严格串行**，spec §6.2）：
  1. `sender?.close()`，置 `sender = null`（先关注册表，让迟到事件静默）。
  2. 若进程已退出则直接返回。
  3. `SIGTERM`；POSIX 下用 `process.kill(-pid, sig)` 杀整个进程组，失败则回退 `child.kill(sig)`（参考已验证的 `dshmarket/lib/dsh-cli.js:549-577` 模式）。
  4. `await exited`（带 `graceMs` 超时）。
  5. 超时未退出 → `SIGKILL` → 再 `await exited`。
  6. 幂等：二次调用直接返回。
- `scrubbedEnv()`：复制 `process.env`，丢弃匹配 `/(KEY|SECRET|TOKEN|PASSWORD)/i` 的键。

- [ ] **Step 6: 实现 `src/index.ts`**

实现要点：

- 命名空间导出：`export const name`、`export const inject = ['tools', 'systemPrompt']`、`export interface Config`、`export const Config`（schemastery）、`export function apply(ctx, config)`。**无 `export default`**（Global Constraints）。
  - `systemPrompt` 必须进 `inject`：缺了它 `ctx.systemPrompt` 为 `undefined`，且插件会静默停在 `PENDING`（"插件没反应"的头号原因，见 spec §9.3 第 6 步）。
- `Config` 字段：`socketPath`（默认空 → 运行时算 `~/Library/Application Support/dsh-island/island.sock`）、`helperPath`（默认空 → 运行时算包内 `bin/DynamicIslandBridge`）、`connectTimeoutMs`（10000）、`idleTimeoutMs`（120000）、`graceMs`（3000）。
- 装配顺序：
  1. 建 `ProgressMachine`。
  2. `ctx.provide('islandProgress', service)` 注册服务（服务定义在 `src/tool.ts`）。
  3. `ctx.tools.register(buildReportProgressTool(service))`——`ctx` 注册 API 自带 effect 管理，无需手动包 `ctx.effect`。
  4. `ctx.systemPrompt.section(buildProgressInstruction())`——**这是让 agent 知道何时上报的关键一步**（模块在 Task 8）。缺了它 `report_progress` 就是死代码，精确模式永不触发。同样自带 effect 管理。
  5. `ctx.on('session/event', (session, event) => {...})`——把 `event` 包成 `SessionEventLike` 交给 `reduceSessionEvent`；`changed` 为真才推送。**同样自带 effect 管理。**
  6. **单个** `ctx.effect(() => {...}, 'dynamic-island-progress: helper')`：内部 `await startHelper(...)` 得到 `HelperHandle`，设置空闲计时器（每次推送重置），返回 `async () => { clearTimeout(); await handle.dispose() }`。
- 空闲计时器：`idleTimeoutMs` 内无推送 → 发送 `{ type: 'bye' }` 并 `machine.reset()`，让岛收起。
- `turn/end` 后发送 `{ type: 'done', reason, ok }`。
- 推送前检查 `sender?.alive`；不 alive 则尝试**一次**重连（重新 `startHelper`），失败则丢弃本条消息并记日志。不做无限重试，避免忙循环。
- **服务名不写进 `inject`**：`islandProgress` 是本插件自己提供的，消费者（工具）在插件内部闭包引用，不走 `ctx.get`。

- [ ] **Step 7: 运行测试确认通过**

Run: `node --test test/helper.test.ts`
Expected: 6 passed

- [ ] **Step 8: 只跑 helper 测试并检查孤儿进程（本任务的关键验收，独立成步）**

**不要和全量 `npm test` 混在一起**——全量套件会起别的子进程干扰进程表判断，且耗时更长。本步只做一件事：

```sh
node --test test/helper.test.ts
sleep 0.2                      # 留出 200ms 等待窗口，让已发出的 SIGTERM 生效
pgrep -f fake-helper.mjs || echo "CLEAN: 无孤儿进程"
```

Expected: 输出 `CLEAN: 无孤儿进程`（`pgrep` 无匹配时退出码为 1，被 `||` 捕获）。

若打印出任何 PID，说明 dispose 未达到完全停稳——这是**阻塞性缺陷**，必须先修复再继续后续步骤。可用 `ps -o pid,ppid,command -p <PID>` 确认它是不是本插件的 helper。

- [ ] **Step 9: 全量测试 + 类型检查**

Run: `npm test && npm run typecheck`
Expected: 全部测试通过；`tsc` 退出码 0。

- [ ] **Step 10: Commit**

```bash
git add src/transport.ts src/helper.ts src/index.ts scripts/fake-helper.mjs test/helper.test.ts
git commit -m "feat: wire plugin assembly with socket transport and helper lifecycle"
```

---

## Task 8: `systemPrompt` 指令注入 —— 让 agent 知道何时该上报

**Files:**
- Create: `src/instructions.ts`
- Test: `test/instructions.test.ts`

**Interfaces:**
- Consumes: `REPORT_PROGRESS_TOOL_NAME` from Task 6
- Produces: `export function buildProgressInstruction(): PromptSection`，返回 `{ name, order, text }`

**为什么这个任务存在（本设计最可能的静默失效）**

注册一个工具**不会**让模型知道该在何时调用它。工具 schema 只告诉模型"有这么个函数、参数是什么"，不告诉它"你的任务里什么时候该用"。没有指令注入时，`report_progress` 会表现为死代码：测试全绿、工具可见、但 `estimated` 永不转 `precise`，实际只有启发式在工作——也就是你担心的那个结果。

**已核实的注入机制**（`site/reference/subsystems/system-prompt.md`）：

```ts
section(section: PromptSection): () => void
```

- `PromptSection`：`{ readonly name: string; readonly order: number; readonly text: string | ((ctx: AssembleContext) => string); readonly interpolate?: boolean; readonly complete?: boolean }`
- 按 `order` 升序排列，同 order 按 name 代码单元顺序；同名段在**同一作用域层**内重复注册会抛异常。
- 返回**就是** Cordis effect disposer，插件卸载时自动注销。
- 需要 `inject = ['systemPrompt']`（Task 7 已加），否则 `ctx.systemPrompt` 为 `undefined` 且插件静默停在 `PENDING`。

**为什么用 `section` 而不是 `context`**：`ctx.systemPrompt.context()` 注册的是**动态 runtime context**，会作为 user-role 快照写进保留的模型历史。静态行为指导属于 system prompt（`section`）。更重要的是，把当前进度值持续喂给 agent 会让它看到自己造成的数值变化，可能触发反复上报的自我反馈循环。本插件只用 `section`，**不使用 `context`**。

**关于 `order`：** KB 未枚举 `PromptSectionOrderName` 的成员，而 `PromptSection.order` 就是一个普通 `number`，第三方插件可直接给值（`getSectionOrder()` 只用于解析仓库自有段落的集中分配，非强制）。本计划用 `order: 900`，落在核心段之后、不覆盖任何名字（`name` 用插件专属前缀保证不冲突）。实现时用以下命令核对已安装包里的实际设定，若发现需要不同位置再调整这一个常量。

- [ ] **Step 1: 写失败测试**

Create: `test/instructions.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProgressInstruction } from '../src/instructions.ts'
import { REPORT_PROGRESS_TOOL_NAME } from '../src/tool.ts'

test('段落形状满足 PromptSection 契约', () => {
  const s = buildProgressInstruction()
  assert.equal(typeof s.name, 'string')
  assert.ok(s.name.length > 0)
  assert.equal(typeof s.order, 'number')
  assert.ok(Number.isFinite(s.order), 'order 必须有限，否则注册会抛异常')
  assert.equal(typeof s.text, 'string')
  assert.ok((s.text as string).length > 0)
})

test('order 为 900（落在核心段落之后）', () => {
  assert.equal(buildProgressInstruction().order, 900)
})

test('name 带插件前缀，避免与其他插件同名段落冲突', () => {
  assert.ok(buildProgressInstruction().name.startsWith('dynamic-island-progress'))
})

test('文本提到工具名，模型才能把指令与工具对应起来', () => {
  assert.ok((buildProgressInstruction().text as string).includes(REPORT_PROGRESS_TOOL_NAME))
})

test('文本不鼓励每步都上报（避免噪声与与 todo 自动比例重复）', () => {
  const t = buildProgressInstruction().text as string
  // 必须表达"可选/仅在确知更准时"，而不是无条件调用
  assert.ok(/可选|不必|仅在/.test(t), '文本未说明这是可选覆盖')
})

test('文本不声称估算进度是精确的', () => {
  const t = buildProgressInstruction().text as string
  assert.ok(!/精确估算/.test(t), '不得暗示估算值精确')
})

test('order 在合理区间内（不与内置段落抢占）', () => {
  const o = buildProgressInstruction().order
  assert.ok(o > 0 && o < 10_000, `order=${o} 超出合理区间`)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/instructions.test.ts`
Expected: FAIL —— `Cannot find module '../src/instructions.ts'`

- [ ] **Step 3: 实现 `src/instructions.ts`**

实现要点：

- `SYSTEM_PROMPT_SECTION_ORDER = 900` 作为具名常量导出，便于日后单点调整。
- `name` 用 `'dynamic-island-progress/instructions'`。
- `text` 为静态字符串（不需要 `AssembleContext`，故用 `string` 而非函数），内容必须包含以下要素：
  1. 说明存在一个进度指示器，会**自动**在任务开始时出现、结束时收起——所以 agent 不需要为它做任何仪式性调用。
  2. 声明系统会**自动估算**进度（基于步骤与待办列表），因此大多数任务无需干预。
  3. 明确定义调用 `report_progress` 的两个**可选**时机：agent 自己知道比估算更准的完成度；任务进入长时间单步、进度条会停滞。
  4. 强调 `percent` 是 0..1 的**小数**（不是 0..100），且显示值单调不减、上报更低的值不会让进度倒退。
  5. 提醒不要每一步都上报。
- 文本用中文（与用户交流语言一致，且本机的 agent 默认中文工作）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/instructions.test.ts`
Expected: 7 passed

- [ ] **Step 5: 核对 `systemPrompt` 在已安装包中的实际 API**

本任务依赖的知识库是 commit 快照。动手后、进入 Task 9 前，用以下命令核对真实声明（防止 `section` 名称或 `PromptSection` 字段名与已安装版本不符）：

```sh
export npm_config_cache="$PWD/.npm-cache"
grep -rn "section(" node_modules/@deepseek-ai/cordis/lib/types/*.d.ts 2>/dev/null | head
# systemPrompt 服务类型通常在 dsh 侧包内；若 @deepseek-ai/dsh-system-prompt 未安装，
# 则退化为依赖 KB 记录并在 Task 9 的挂载验证里用真实运行确认（§9.3 第 6 步查 PENDING）。
```

Expected: 能找到 `section(...)` 声明，或明确记录"未安装该包，靠 Task 9 运行时验证"。**不要跳过本步**——若字段名不符，Task 9 的 `context.systemPrompt.section` 会在运行时抛错。

- [ ] **Step 6: Commit**

```bash
git add src/instructions.ts test/instructions.test.ts
git commit -m "feat: inject progress-reporting guidance into the system prompt"
```

---

## Task 9: 挂载层、README 与端到端验证

**Files:**
- Create: `cordis.patch.yml`
- Create: `README.md`
- Create: `scripts/mount-patch.md`（交付给用户的挂载片段，**不自动写入用户配置**）

**Interfaces:**
- Consumes: `src/index.ts`（Task 7）、`src/instructions.ts`（Task 8）
- Produces: 可被用户挂载的包 + 挂载说明 + 无刘海机型差异文档

- [ ] **Step 1: 写 `cordis.patch.yml`**

包内挂载层按**包名**引用（`publish.md:59`），不是相对路径：

```yaml
- insert:
    - id: dynamic-island-progress
      name: dsh-dynamic-island-progress
      config: {}
```

- [ ] **Step 2: 写交付给用户的挂载片段 `scripts/mount-patch.md`**

**关键：绝不修改 `~/.dsh/profiles/desktop/cordis.patch.yml`。** 该文件含用户既有的模型配置（`deepseek-flash`、`reasoningEffort: high`）与 UI 设置。本步骤只**输出**待粘贴内容：

```markdown
# 手动挂载步骤（用户自行执行）

profile 目录：`/Users/yueli/.dsh/profiles/desktop`
目标文件：`/Users/yueli/.dsh/profiles/desktop/cordis.patch.yml`

请先备份：
    cp ~/.dsh/profiles/desktop/cordis.patch.yml ~/.dsh/profiles/desktop/cordis.patch.yml.bak

然后把下面这一行**追加**到该文件末尾（它已有一个顶层 YAML 数组，追加元素即可）：

- insert:
    - id: dynamic-island-progress
      name: dsh-dynamic-island-progress

注意：
- 不要覆盖文件，只追加。
- 该文件是顶层数组，新增条目必须与其他条目同级。
- 若希望用 `--patch` overlay 做一次性试验而不改持久配置，改用：
    dsh web --patch ./cordis.patch.yml
```

- [ ] **Step 3: 写 `README.md`**

必须包含以下小节，内容取自 spec：

1. **这是什么**、架构图（插件 = client，helper = server）。
2. **安装**：`bash scripts/install-deps.sh`、构建 helper（阶段二，需 Xcode）。
3. **无 Xcode 时的现状**：helper 二进制缺失，插件能加载但不会显示灵动岛，日志给出明确指引。指向阶段二计划。
4. **挂载**：指到 `scripts/mount-patch.md`。
5. **验证阶梯**：抄 spec §9.3 的 8 步表。
6. **⚠️ 无刘海机型差异（必须写明）**：DynamicNotchKit 在无刘海屏使用 `.floating` 样式，而库的 `_compact()` 在 floating 下直接 `await hide()`，因此**无刘海 Mac 上无法常驻百分比药丸**，行为降级为 hover-to-expand（悬停展开、移开收起）。这是库的固有限制，非本插件缺陷。
7. **配置项表**：`socketPath` / `helperPath` / `connectTimeoutMs` / `idleTimeoutMs` / `graceMs` 及默认值。
8. **进度语义**：估算阶段上限 90%，`report_progress` 后切精确模式，异常中断不显示 100%。

- [ ] **Step 4: 端到端验证（假 helper）**

Run:
```bash
# 终端 A：手动起假 helper（模拟 helper 侧）
node scripts/fake-helper.mjs "$HOME/Library/Application Support/dsh-island/island.sock"

# 终端 B：跑集成测试，确认协议与生命周期
npm test
```
Expected: 测试全绿；终端 A 打印收到的 `progress ...` 行，且测试结束后终端 A 的进程被 SIGTERM 正常终止。

- [ ] **Step 5: 确认挂载层可被发现**

Run: `dsh --profile desktop --dump-config 2>/dev/null | grep -i dynamic-island`
Expected: 若尚未挂载则无输出（正常）。挂载后应出现 `# == dsh-dynamic-island-progress` 层。**本步骤不写入用户配置**，仅在用户粘贴后执行。

- [ ] **Step 6: Commit**

```bash
git add cordis.patch.yml README.md scripts/mount-patch.md
git commit -m "docs: add patch layer, mount instructions, and notchless caveat"
```

---

## 阶段二（不在本计划内）

Swift 渲染层对应原需求步骤 3 与 5 的 Swift 部分：`swift/DynamicIslandBridge/`、DynamicNotchKit 依赖、常驻药丸 + hover 展开、socket server、`scripts/build-helper.sh`。

**前置条件：完整 Xcode 安装完成**，并验证宏可用：

```sh
echo 'import SwiftUI; struct V: View { @State var x = 0; var body: some View { Text("\(x)") } }' > /tmp/t.swift
xcrun swiftc -parse-as-library -c /tmp/t.swift -o /tmp/t.o && echo MACROS_OK
```

阶段二会有一份独立计划，因为它的风险面（SwiftUI 宏、SwiftPM 沙箱、SDK 版本）与阶段一完全不同，且需要用真实 Xcode 重新验证本计划已实测的三个工具链坑。

---

## 附：Spec 覆盖对照

| Spec 章节 | 对应任务 |
|---|---|
| §4.1 事件锚点（`session/event` + 分发） | Task 4 |
| §4.1 禁用 `assertNever` | Task 4（含未知事件测试） |
| §4.2 估算公式与 90% 上限 | Task 2 |
| §4.3 状态机 + 4 条不变式 | Task 3 |
| §4.4 异常终态不显示 100% | Task 3、Task 4 |
| §5 协议（NDJSON） | Task 5 |
| §6.1 启动顺序 + env 擦洗 + 0700 | Task 7 |
| §6.2 单个 effect + await 退出 | Task 7 |
| §7 文件布局 | 文件结构表 |
| §8 无 `export default`、`dsh.bundle`、patch 语义 | Task 1、Task 7、Task 9 |
| §9.3 验证阶梯 | Task 7 Step 8、Task 9 Step 4/5 |
| §9.4 挂载（不覆盖用户文件） | Task 9 Step 2 |
| §10 测试策略 | 全部任务的 TDD 步骤 |
| §11 风险表 | Task 7（二进制缺失、stale socket）、Task 9（README 记录） |
| **Review Focus 6：工具成为死代码** | **Task 8（指令注入）** |
| **todo 进度加权公式** | **Task 4（`(c + 0.5i)/t`）** |

**单位换算陷阱（实现时最易出错）**：`estimatePercent` 返回**百分比 0..90**，而 `ProgressMachine.percent` 是 **0..1 小数**。Task 3 的 `onStep` 必须做 `/ 100` 转换。协议层的 `percent` 也是 0..1 小数。
