# DSH 灵动岛进度插件 — Swift 渲染层实现计划（阶段二）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `DynamicIslandBridge` —— 一个无主窗口、无 Dock 图标的 Swift 可执行程序，作为 Unix socket server 接收插件的 NDJSON 进度消息，并在 macOS 刘海区渲染「常驻百分比药丸 + hover 展开详情」。

**Architecture:** SwiftPM 可执行目标，依赖 DynamicNotchKit（MIT）。进程启动即 `setActivationPolicy(.accessory)` 隐藏 Dock 图标。`SocketServer` 负责 bind/listen/accept 与 NDJSON 分帧；`ProgressBuffer` 持有可变进度状态并作为 `ObservableObject` 供 SwiftUI 订阅；`NotchController` 驱动 DynamicNotch 的 compact/expand/hide，并通过订阅 `notch.$isHovering` 实现 hover 展开（库本身不会自动展开）。

**Tech Stack:** Swift 6.0（swift-tools-version 6.0）、DynamicNotchKit（SPM，macOS 13+）、SwiftUI、Network（`NWListener`/`NWConnection` 或 BSD socket）、Swift Package Manager 的 `swift-testing`/`XCTest` 测试目标。

**Spec:** [docs/superpowers/specs/2026-10-14-dynamic-island-progress-design.md](../specs/2026-10-14-dynamic-island-progress-design.md)（§3 协议、§5 Swift 辅助进程、§9 验证）
**阶段一计划:** [2026-10-14-dynamic-island-progress-ts.md](./2026-10-14-dynamic-island-progress-ts.md)（已完成；本计划消费其协议定义）

---

## Global Constraints

- **交流语言：中文。**
- **socket 契约（不可改动，阶段一已实现并发版）**：`~/Library/Application Support/dsh-island/island.sock`，目录权限 `0700`。
  本进程是 **server**：启动时无条件 `unlink` stale socket，再 bind + listen。
- **NDJSON**：每行一个 JSON 对象，UTF-8。必须容忍**半包与粘包**（帧可能被拆到多次 read，也可能一次到达多帧）。
- **入站消息类型**：`hello`（`version`）、`progress`（`percent` 0..1、`mode` `estimated|precise`、`message?`）、`done`（`reason`、`ok`）、`bye`。
- **`percent` 必须 clamp 到 `[0,1]`**，非有限值丢弃而非崩溃。
- **客户端断开后不得退出**：回到 `accept` 等待下一个连接。
- **无主窗口**：无 Dock 图标、无菜单栏、不抢焦点（`setActivationPolicy(.accessory)`）。
- **绝不修改 `~/.dsh/profiles/desktop/cordis.patch.yml`**。
- 不得引入除 DynamicNotchKit 之外的原生依赖。

## 环境前置（已实测，本会话核实）

| 事实 | 值 |
|---|---|
| Xcode | **27.0** 已装于 `/Applications/Xcode.app` |
| macOS 版宏插件 | `.../Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins/libSwiftUIMacros.dylib`（arm64）**存在** |
| `xcode-select` | 仍指向 `/Library/Developer/CommandLineTools` —— 需用户执行 `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` |
| 未切换时的绕过 | 设 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` |
| DynamicNotchKit | **已实测编译成功**（`swift build --disable-sandbox`） |
| 本机刘海几何 | frame 1470×956pt，`safeAreaInsets.top=32`，`auxTopLeft=646`，`auxTopRight=645` → **刘海 179×32pt** |

### 三个工具链坑（必须遵守）

1. **构建必须走 SwiftPM，不要用裸 `swiftc` 验证宏。** 裸 `xcrun swiftc` 在 agent 沙箱内会报
   `swift-plugin-server produced malformed response`（plugin-server 子进程被沙箱杀死）。
   SwiftPM 通过 `-load-resolved-plugin <dylib>#<server>` 显式指定路径，**不受影响**——
   已实测 DynamicNotchKit 库模块全程零宏错误。因此本计划的验证一律用 `swift build`/`swift test`。
2. **`--disable-sandbox` 必需**（在 DSH agent 沙箱内）：否则 SwiftPM 编译
   `Package.swift` manifest 时报 `sandbox-exec: sandbox_apply: Operation not permitted`。
   在用户自己的终端里该参数无害。
3. **缓存目录必须重定向**：SwiftPM 默认写 `~/Library/org.swift.swiftpm`，沙箱内不可写。
   设 `CLANG_MODULE_CACHE_PATH` / `SWIFT_MODULECACHE_PATH` 到仓库内。

这三条都已固化在阶段一交付的 `scripts/build-helper.sh` 中。

## Review Focus

以下 5 类输入/失效模式是 spec 隐含、但单任务测试不足以覆盖的，最易伤到真实使用者。
每条都在指定任务的测试中钉住：

1. **半包/粘包导致消息丢失或错乱**——NDJSON 帧被 TCP 边界切开，或一次到达多帧。合理预期是正确缓冲重组。
   → Task 3
2. **percent 越界或非法**——`1e9`、负数、`NaN`（若对方实现有 bug 或版本不符）。合理预期是 clamp 或丢弃，绝不导致崩溃或 UI 显示乱码。→ Task 3、Task 4
3. **无刘海机型上调用 compact 等于隐藏窗口**——库的固有行为。合理预期是**降级为 hover 展开浮层**而不是什么都不显示。→ Task 5
4. **客户端断开/重连**——插件重启或 helper 被 kill 后重启。合理预期是 server 不退出、能接受新连接。→ Task 3
5. **socket 路径已存在（上次崩溃残留）**——合理预期是启动时清除并成功 bind，而不是 bind 失败退出。→ Task 3

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `swift/DynamicIslandBridge/Package.swift` | SwiftPM 清单；DynamicNotchKit 依赖；可执行目标 + 测试目标 |
| `.../Sources/DynamicIslandBridge/main.swift` | 入口：解析 argv、`setActivationPolicy(.accessory)`、装配 server 与 controller |
| `.../Sources/DynamicIslandBridge/Protocol.swift` | 消息类型 + NDJSON 解码 + `percent` clamp |
| `.../Sources/DynamicIslandBridge/SocketServer.swift` | unlink stale → bind → listen → accept 循环 |
| `.../Sources/DynamicIslandBridge/ProgressBuffer.swift` | `ObservableObject`，持有 percent/mode/message/state，供 SwiftUI 订阅 |
| `.../Sources/DynamicIslandBridge/NotchController.swift` | 驱动 DynamicNotch：compact 药丸 / hover 展开 / hide |
| `.../Sources/DynamicIslandBridge/Views.swift` | 药丸与展开详情的 SwiftUI 视图 |
| `.../Tests/DynamicIslandBridgeTests/ProtocolTests.swift` | NDJSON 分帧与 clamp 的单元测试 |
| `.../Tests/DynamicIslandBridgeTests/ProgressBufferTests.swift` | 状态迁移的单元测试 |

**边界原则**：`Protocol.swift` 与 `ProgressBuffer.swift` 是**纯逻辑、零 I/O**，因此可在无显示器、
无 socket 的环境下完整单元测试。I/O 集中在 `SocketServer.swift`，UI 集中在 `Views.swift`/`NotchController.swift`。

---

## Task 1: SwiftPM 骨架与构建基线

**Files:**
- Create: `swift/DynamicIslandBridge/Package.swift`
- Create: `swift/DynamicIslandBridge/Sources/DynamicIslandBridge/main.swift`
- Create: `swift/DynamicIslandBridge/Tests/DynamicIslandBridgeTests/SmokeTests.swift`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 可构建的 `DynamicIslandBridge` 可执行目标 + 可运行的测试目标；
  `scripts/build-helper.sh`（阶段一已交付）能成功产出 `bin/DynamicIslandBridge`

- [ ] **Step 1: 写 `Package.swift`**

`swift-tools-version: 6.0`，平台 macOS 13（DynamicNotchKit 要求）。
**依赖必须用 `from: "1.0.0"` 以上**——本会话核实过 1.1.0/1.0.0/0.1.0 三个 tag 都使用
`@State`/`@ObservedObject`，因此都需要完整 Xcode，没有"降级到无宏版本"这条路。

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DynamicIslandBridge",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/MrKai77/DynamicNotchKit", from: "1.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "DynamicIslandBridge",
            dependencies: ["DynamicNotchKit"],
            path: "Sources/DynamicIslandBridge"
        ),
        .testTarget(
            name: "DynamicIslandBridgeTests",
            dependencies: ["DynamicIslandBridge"],
            path: "Tests/DynamicIslandBridgeTests"
        ),
    ]
)
```

- [ ] **Step 2: 写最小 `main.swift`**

先只要一个能被构建和测试的骨架。`setActivationPolicy(.accessory)` 必须在任何窗口出现**之前**设置，
所以放在 `main` 最前面；本步骤先验证它能编译并返回固定退出码。

```swift
import AppKit
import Foundation

/// Entry point. This process is a background accessory: no Dock icon, no
/// menu bar, no main window. The activation policy must be set before any
/// window is created, so it is the first thing main does.
@main
enum DynamicIslandBridgeMain {
    static func main() {
        NSApplication.shared.setActivationPolicy(.accessory)
        if CommandLine.arguments.contains("--version") {
            print("DynamicIslandBridge 0.1.0")
            exit(0)
        }
        // Wired up in later tasks: socket server + notch controller.
        exit(0)
    }
}
```

- [ ] **Step 3: 写冒烟测试 `SmokeTests.swift`**

用 XCTest（`swift test` 默认支持）。本步骤只证明测试目标本身可运行——
这是后续所有 RED/GREEN 循环的前提。

```swift
import XCTest
@testable import DynamicIslandBridge

final class SmokeTests: XCTestCase {
    func testExecutableTargetIsTestable() {
        XCTAssertTrue(true)
    }
}
```

- [ ] **Step 4: 构建**

Run:
```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export CLANG_MODULE_CACHE_PATH="$PWD/.swift-cache"
export SWIFT_MODULECACHE_PATH="$PWD/.swift-cache"
swift build --disable-sandbox --package-path swift/DynamicIslandBridge
```

Expected: 输出 `Build complete!`，无宏错误。

**若报 `SwiftUIMacros ... could not be found` 或 `plugin-server produced malformed response`**：
不要改用普通 `swiftc` 试验。检查 `DEVELOPER_DIR` 是否指向 Xcode.app，并确认
`$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins/libSwiftUIMacros.dylib` 存在。

- [ ] **Step 5: 跑测试**

Run: `swift test --disable-sandbox --package-path swift/DynamicIslandBridge`
Expected: 1 test passed。

- [ ] **Step 6: 验证 `--version` 与退出码**

Run: `swift run --disable-sandbox --package-path swift/DynamicIslandBridge DynamicIslandBridge --version`
Expected: 打印 `DynamicIslandBridge 0.1.0`，退出码 0。
**同时观察：不应出现 Dock 图标**（进程即刻退出，但若出现图标说明 accessory 策略没生效）。

- [ ] **Step 7: Commit**

```bash
git add swift/DynamicIslandBridge
git commit -m "feat(swift): scaffold DynamicIslandBridge SwiftPM package with accessory policy"
```

---

## Task 2: 协议解码（纯逻辑）

**Files:**
- Create: `swift/DynamicIslandBridge/Sources/DynamicIslandBridge/Protocol.swift`
- Create: `swift/DynamicIslandBridge/Tests/DynamicIslandBridgeTests/ProtocolTests.swift`

**Interfaces:**
- Consumes: 无
- Produces:
  - `enum InboundMessage`：`.hello(version: Int)`、`.progress(percent: Double, mode: ProgressMode, message: String?)`、`.done(reason: String, ok: Bool)`、`.bye`
  - `enum ProgressMode: String`：`.estimated`、`.precise`
  - `struct LineBuffer`：`mutating func append(_ chunk: String) -> [String]` —— 输入任意分片，输出完整行
  - `func decodeMessage(_ line: String) -> InboundMessage?` —— 解析失败返回 nil

**契约来源**：`src/protocol.ts`（阶段一，已实现）。字段名必须逐字对应。

- [ ] **Step 1: 写失败测试**

Create: `Tests/DynamicIslandBridgeTests/ProtocolTests.swift`

这组测试钉住 Review Focus 第 1、2 条：

```swift
import XCTest
@testable import DynamicIslandBridge

final class ProtocolTests: XCTestCase {

    // MARK: 分帧

    func testHalfPacketIsBufferedNotParsed() {
        var buf = LineBuffer()
        XCTAssertEqual(buf.append("{\"type\":\"prog"), [])
    }

    func testHalfPacketCompletedByNextChunk() {
        var buf = LineBuffer()
        _ = buf.append("{\"type\":\"bye\"")
        XCTAssertEqual(buf.append("}\n"), ["{\"type\":\"bye\"}"])
    }

    func testMultipleFramesInOneChunk() {
        var buf = LineBuffer()
        let lines = buf.append("{\"type\":\"bye\"}\n{\"type\":\"bye\"}\n")
        XCTAssertEqual(lines.count, 2)
    }

    func testFrameSplitAcrossThreeChunks() {
        var buf = LineBuffer()
        XCTAssertEqual(buf.append("{\"ty"), [])
        XCTAssertEqual(buf.append("pe\":\"b"), [])
        XCTAssertEqual(buf.append("ye\"}\n"), ["{\"type\":\"bye\"}"])
    }

    func testEmptyLinesAreSkipped() {
        var buf = LineBuffer()
        XCTAssertEqual(buf.append("\n\n{\"type\":\"bye\"}\n").count, 1)
    }

    // MARK: 解析

    func testDecodesProgress() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":0.42,\"mode\":\"precise\"}")
        guard case .progress(let p, let mode, _)? = m else { return XCTFail("未解析为 progress") }
        XCTAssertEqual(p, 0.42, accuracy: 0.0001)
        XCTAssertEqual(mode, .precise)
    }

    func testDecodesProgressWithNonASCIIText() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"estimated\",\"message\":\"正在编译 ①✓\"}")
        guard case .progress(_, _, let msg)? = m else { return XCTFail("未解析") }
        XCTAssertEqual(msg, "正在编译 ①✓")
    }

    func testClampsPercentAboveOne() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":1e9,\"mode\":\"precise\"}")
        guard case .progress(let p, _, _)? = m else { return XCTFail("未解析") }
        XCTAssertEqual(p, 1.0)
    }

    func testClampsNegativePercent() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":-5,\"mode\":\"precise\"}")
        guard case .progress(let p, _, _)? = m else { return XCTFail("未解析") }
        XCTAssertEqual(p, 0.0)
    }

    func testRejectsNonFinitePercent() {
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"percent\":null,\"mode\":\"precise\"}"))
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"mode\":\"precise\"}"))
    }

    func testRejectsUnknownMode() {
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"nope\"}"))
    }

    func testRejectsMalformedJSON() {
        XCTAssertNil(decodeMessage("{bad json"))
        XCTAssertNil(decodeMessage(""))
        XCTAssertNil(decodeMessage("42"))
    }

    func testDecodesDone() {
        guard case .done(let reason, let ok)? = decodeMessage("{\"type\":\"done\",\"reason\":\"completed\",\"ok\":true}") else {
            return XCTFail("未解析为 done")
        }
        XCTAssertEqual(reason, "completed")
        XCTAssertTrue(ok)
    }

    func testDecodesHello() {
        guard case .hello(let v)? = decodeMessage("{\"type\":\"hello\",\"version\":1}") else {
            return XCTFail("未解析为 hello")
        }
        XCTAssertEqual(v, 1)
    }

    func testDecodesBye() {
        guard case .bye? = decodeMessage("{\"type\":\"bye\"}") else { return XCTFail("未解析为 bye") }
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `swift test --disable-sandbox --package-path swift/DynamicIslandBridge`
Expected: 编译失败 —— `cannot find 'LineBuffer' in scope` / `cannot find 'decodeMessage'`。

- [ ] **Step 3: 实现 `Protocol.swift`**

实现要点：

- `LineBuffer` 用 String 累积。按 `\n` 切分，最后一段无结尾换行则保留为未完成帧。
  空行跳过。**不要**用 `split` 后丢弃尾部，否则半包会静默丢失。
- `decodeMessage` 用 `JSONSerialization`（避免为 4 种消息定义全套 `Codable`）。
  校验：`type` 存在且为 String；`progress` 要求 `percent` 是 `NSNumber` 且 `doubleValue.isFinite`，
  `mode` 必须是 `estimated`/`precise`。任一不满足返回 `nil` —— 不抛异常。
- `percent` clamp：`min(1.0, max(0.0, value))`。
- `ProgressMode` 用 `String` 原始值以便与 wire 值直接对应。

- [ ] **Step 4: 运行测试确认通过**

Run: `swift test --disable-sandbox --package-path swift/DynamicIslandBridge`
Expected: 15 tests passed（加上 Task 1 的冒烟测试共 16）。

- [ ] **Step 5: Commit**

```bash
git add swift/DynamicIslandBridge/Sources/DynamicIslandBridge/Protocol.swift \
        swift/DynamicIslandBridge/Tests/DynamicIslandBridgeTests/ProtocolTests.swift
git commit -m "feat(swift): add NDJSON frame buffer and message decoder"
```

---

## Task 3: Socket server（server 端生命周期）

**Files:**
- Create: `swift/DynamicIslandBridge/Sources/DynamicIslandBridge/SocketServer.swift`
- Create: `swift/DynamicIslandBridge/Tests/DynamicIslandBridgeTests/SocketServerTests.swift`

**Interfaces:**
- Consumes: `LineBuffer`、`decodeMessage`、`InboundMessage` from Task 2
- Produces:
  - `final class SocketServer`
  - `init(socketPath: String, onMessage: @escaping (InboundMessage) -> Void, onError: @escaping (String) -> Void)`
  - `func start() throws` —— unlink stale → bind → listen
  - `func stop()` —— 关闭 fd 并 unlink socket

**实现语言选择**：用 BSD socket（`Darwin.socket/bind/listen/accept`）+ `DispatchSourceRead`，
而不是 `NWListener`。理由：Unix domain socket 的路径长度限制（`sun_path` 104 字节）与
`unlink` 语义用 BSD API 更直接，且不引入 Network.framework 的异步抽象层次。

- [ ] **Step 1: 写失败测试**

Create: `Tests/DynamicIslandBridgeTests/SocketServerTests.swift`

钉住 Review Focus 第 4、5 条（重连、stale socket）：

```swift
import XCTest
@testable import DynamicIslandBridge

final class SocketServerTests: XCTestCase {
    private var dir: String!
    private var socketPath: String!

    override func setUpWithError() throws {
        dir = NSTemporaryDirectory() + "island-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        socketPath = dir + "/island.sock"
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: dir)
    }

    private func makeServer(_ received: @escaping (InboundMessage) -> Void) throws -> SocketServer {
        let s = SocketServer(socketPath: socketPath, onMessage: received, onError: { _ in })
        try s.start()
        return s
    }

    /// 用 BSD socket 客户端发一段原始字节
    private func sendRaw(_ text: String) throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0)
        defer { close(fd) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: 104) { dst in
                socketPath.withCString { src in strncpy(dst, src, 104) }
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let r = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) }
        }
        XCTAssertEqual(r, 0, "connect 失败")
        _ = text.withCString { write(fd, $0, strlen($0)) }
    }

    func testStartCreatesSocketFile() throws {
        let s = try makeServer { _ in }
        defer { s.stop() }
        XCTAssertTrue(FileManager.default.fileExists(atPath: socketPath))
    }

    func testRemovesStaleSocketBeforeBinding() throws {
        // 模拟上次崩溃残留
        FileManager.default.createFile(atPath: socketPath, contents: Data("stale".utf8))
        XCTAssertNoThrow(try makeServer { _ in })
    }

    func testReceivesProgressMessage() throws {
        let exp = expectation(description: "收到 progress")
        let s = try makeServer { msg in
            if case .progress(let p, _, _) = msg {
                XCTAssertEqual(p, 0.42, accuracy: 0.001)
                exp.fulfill()
            }
        }
        defer { s.stop() }
        try sendRaw("{\"type\":\"progress\",\"percent\":0.42,\"mode\":\"precise\"}\n")
        wait(for: [exp], timeout: 5)
    }

    func testReassemblesFrameSplitAcrossWrites() throws {
        let exp = expectation(description: "收到完整帧")
        let s = try makeServer { msg in
            if case .bye = msg { exp.fulfill() }
        }
        defer { s.stop() }
        try sendRaw("{\"type\":\"b")
        usleep(50_000)
        try sendRaw("ye\"}\n")
        wait(for: [exp], timeout: 5)
    }

    func testAcceptsSecondConnectionAfterFirstDisconnects() throws {
        let exp = expectation(description: "第二次连接仍被服务")
        exp.expectedFulfillmentCount = 2
        let s = try makeServer { msg in
            if case .bye = msg { exp.fulfill() }
        }
        defer { s.stop() }
        try sendRaw("{\"type\":\"bye\"}\n")
        usleep(200_000)
        try sendRaw("{\"type\":\"bye\"}\n")
        wait(for: [exp], timeout: 5)
    }

    func testMalformedFrameDoesNotKillServer() throws {
        let exp = expectation(description: "坏帧之后的帧仍被处理")
        let s = try makeServer { msg in
            if case .bye = msg { exp.fulfill() }
        }
        defer { s.stop() }
        try sendRaw("{bad json\n{\"type\":\"bye\"}\n")
        wait(for: [exp], timeout: 5)
    }

    func testStopIsIdempotent() throws {
        let s = try makeServer { _ in }
        s.stop()
        XCTAssertNoThrow(s.stop())
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `swift test --disable-sandbox --package-path swift/DynamicIslandBridge`
Expected: 编译失败 —— `cannot find 'SocketServer' in scope`。

- [ ] **Step 3: 实现 `SocketServer.swift`**

实现要点：

- `start()`：
  1. `unlink(socketPath)` 无条件执行（忽略 ENOENT）——**这一步是 Review Focus 第 5 条的落点**。
  2. `socket(AF_UNIX, SOCK_STREAM, 0)`；`bind`；`listen(backlog: 4)`。
  3. `chmod(socketPath, 0o600)`。
  4. 用 `DispatchSource.makeReadSource(fileDescriptor: listenFD, queue: .global())` 接受连接。
  5. **不设 `SO_REUSEADDR`**：Unix socket 的 stale 问题由 unlink 解决，设它反而掩盖 bug。
- `accept` 后为每个连接创建 `DispatchSourceRead`，累积到 `LineBuffer`，逐行 `decodeMessage`，
  非 nil 则回调。解析失败的行写 stderr 并**继续**（Review Focus 第 1 条）。
- 连接 `EOF` 时关闭该 fd，但**不停止 listen**（Review Focus 第 4 条）。
- **同一时刻只服务一个连接**：新连接到来时关闭旧连接（容忍插件重启）。
- `stop()` 幂等：取消所有 source、关闭所有 fd、`unlink` socket。
- **不得 `fatalError` 或 `exit`**：所有 I/O 错误走 `onError` 回调，让 server 继续存活。

- [ ] **Step 4: 运行测试确认通过**

Run: `swift test --disable-sandbox --package-path swift/DynamicIslandBridge`
Expected: 全部通过（Task 1 的 1 + Task 2 的 15 + 本任务 7 = 23）。

- [ ] **Step 5: Commit**

```bash
git add swift/DynamicIslandBridge/Sources/DynamicIslandBridge/SocketServer.swift \
        swift/DynamicIslandBridge/Tests/DynamicIslandBridgeTests/SocketServerTests.swift
git commit -m "feat(swift): add Unix socket server with stale-socket recovery and reconnect"
```

---

## Task 4: 进度状态（ObservableObject，纯逻辑）

**Files:**
- Create: `swift/DynamicIslandBridge/Sources/DynamicIslandBridge/ProgressBuffer.swift`
- Create: `swift/DynamicIslandBridge/Tests/DynamicIslandBridgeTests/ProgressBufferTests.swift`

**Interfaces:**
- Consumes: `InboundMessage`、`ProgressMode` from Task 2
- Produces:
  - `final class ProgressBuffer: ObservableObject`
  - `@Published private(set) var percent: Double`、`mode: ProgressMode`、`message: String?`、`isVisible: Bool`、`phase: Phase`
  - `enum Phase { case idle, running, done(ok: Bool) }`
  - `func apply(_ message: InboundMessage)`

**为什么单独一层**：SwiftUI 内容视图必须能观察到实时变化。已核实
`DynamicNotchInfo` 用 `LocalizedStringKey` 且在 init 时固定，**无法显示实时百分比**——
所以必须用 `DynamicNotch` + 自己的 `ObservableObject`。

- [ ] **Step 1: 写失败测试**

Create: `Tests/DynamicIslandBridgeTests/ProgressBufferTests.swift`

```swift
import XCTest
@testable import DynamicIslandBridge

final class ProgressBufferTests: XCTestCase {

    func testStartsHiddenAndIdle() {
        let b = ProgressBuffer()
        XCTAssertFalse(b.isVisible)
        XCTAssertEqual(b.phase, .idle)
    }

    func testProgressMakesVisibleAndRunning() {
        let b = ProgressBuffer()
        b.apply(.progress(percent: 0.42, mode: .precise, message: "一半"))
        XCTAssertTrue(b.isVisible)
        XCTAssertEqual(b.phase, .running)
        XCTAssertEqual(b.percent, 0.42, accuracy: 0.0001)
        XCTAssertEqual(b.message, "一半")
    }

    func testPercentClampedOnApply() {
        let b = ProgressBuffer()
        b.apply(.progress(percent: 1e9, mode: .precise, message: nil))
        XCTAssertEqual(b.percent, 1.0)
        let c = ProgressBuffer()
        c.apply(.progress(percent: -3, mode: .precise, message: nil))
        XCTAssertEqual(c.percent, 0.0)
    }

    func testDoneOkSetsFullAndTerminal() {
        let b = ProgressBuffer()
        b.apply(.progress(percent: 0.5, mode: .estimated, message: nil))
        b.apply(.done(reason: "completed", ok: true))
        XCTAssertEqual(b.phase, .done(ok: true))
        XCTAssertEqual(b.percent, 1.0)
    }

    func testDoneNotOkDoesNotClaimFull() {
        let b = ProgressBuffer()
        b.apply(.progress(percent: 0.5, mode: .estimated, message: nil))
        b.apply(.done(reason: "aborted", ok: false))
        XCTAssertEqual(b.phase, .done(ok: false))
        XCTAssertLessThan(b.percent, 1.0, "异常结束不得显示 100%")
    }

    func testByeHidesAndResets() {
        let b = ProgressBuffer()
        b.apply(.progress(percent: 0.5, mode: .precise, message: "x"))
        b.apply(.bye)
        XCTAssertFalse(b.isVisible)
        XCTAssertEqual(b.phase, .idle)
        XCTAssertNil(b.message)
    }

    func testHelloDoesNotMakeVisible() {
        let b = ProgressBuffer()
        b.apply(.hello(version: 1))
        XCTAssertFalse(b.isVisible, "握手不应弹出灵动岛")
    }

    func testDoneReplacesMessageWithReason() {
        let b = ProgressBuffer()
        b.apply(.progress(percent: 0.5, mode: .precise, message: "旧消息"))
        b.apply(.done(reason: "aborted", ok: false))
        XCTAssertEqual(b.message, "aborted", "失败时应显示原因")
    }

    func testEmptyMessageDoesNotClearPrevious() {
        let b = ProgressBuffer()
        b.apply(.progress(percent: 0.3, mode: .precise, message: "进行中"))
        b.apply(.progress(percent: 0.6, mode: .precise, message: nil))
        XCTAssertEqual(b.message, "进行中", "缺省 message 不应清掉上一条")
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `swift test --disable-sandbox --package-path swift/DynamicIslandBridge`
Expected: 编译失败 —— `cannot find 'ProgressBuffer' in scope`。

- [ ] **Step 3: 实现 `ProgressBuffer.swift`**

实现要点：

- `Phase` 必须 `Equatable`（测试用 `XCTAssertEqual`）。带关联值的 `case done(ok: Bool)` 自动合成。
- `apply(.progress)`：clamp 到 `[0,1]`；`isVisible = true`；`phase = .running`；
  **仅当 `message != nil` 时才更新 `message`**（保留上一条，避免 UI 闪空）。
- `apply(.done)`：`phase = .done(ok:)`；`ok == true` → `percent = 1.0`，否则保持当前值；
  `message = reason`（失败原因比旧的状态行更有用）。`isVisible` 保持 `true`
  —— 由 `NotchController` 负责停留一会儿再收起。
- `apply(.bye)`：`isVisible = false`；`phase = .idle`；`percent = 0`；`message = nil`。
- `apply(.hello)`：无副作用。
- 所有 `@Published` 属性变更加 `@MainActor` 约束，因为 SwiftUI 与 `DispatchSource` 回调在不同队列。

- [ ] **Step 4: 运行测试确认通过**

Run: `swift test --disable-sandbox --package-path swift/DynamicIslandBridge`
Expected: 全部通过（23 + 9 = 32）。

- [ ] **Step 5: Commit**

```bash
git add swift/DynamicIslandBridge/Sources/DynamicIslandBridge/ProgressBuffer.swift \
        swift/DynamicIslandBridge/Tests/DynamicIslandBridgeTests/ProgressBufferTests.swift
git commit -m "feat(swift): add observable progress buffer with clamped state transitions"
```

---

## Task 5: 灵动岛渲染（药丸 + hover 展开 + 无刘海降级）

**Files:**
- Create: `swift/DynamicIslandBridge/Sources/DynamicIslandBridge/Views.swift`
- Create: `swift/DynamicIslandBridge/Sources/DynamicIslandBridge/NotchController.swift`
- Modify: `swift/DynamicIslandBridge/Sources/DynamicIslandBridge/main.swift`

**Interfaces:**
- Consumes: `ProgressBuffer`（Task 4）、`SocketServer`（Task 3）
- Produces:
  - `struct ProgressPill: View` —— compact 态常驻百分比
  - `struct ProgressDetail: View` —— 展开态的进度条 + 百分比 + 消息
  - `final class NotchController`
  - `init(buffer: ProgressBuffer)`
  - `func start()` —— 创建 DynamicNotch，订阅 `buffer` 与 `notch.$isHovering`
  - `func stop()`

**已核实的库行为（务必据此实现，勿凭想象；以下每条都经源码逐行核对）**：

- `DynamicNotch<Expanded, CompactLeading, CompactTrailing>` 的 init：
  `init(hoverBehavior:style:expanded:compactLeading:compactTrailing:)`，后两个有默认值。
- `expand(on:)` / `compact(on:)` / `hide()` **都是 `async`**，内部各自 sleep 0.4s 等动画。
- `style: .auto` 会按屏幕自动选 `.notch` 或 `.floating`（靠 `NSScreen.hasNotch`，
  其实现为 `auxiliaryTopLeftArea?.width != nil && auxiliaryTopRightArea?.width != nil`）。
- **hover 不会自动展开**：`updateHoverState` 只做
  `guard state != .hidden, hovering != isHovering else { return }` 然后置 `isHovering`
  （外加可选触觉反馈）。在 compact 态，`isHovering` 的唯一视觉作用是让胶囊高度从
  `notchSize.height` 变成 `menubarHeight`。
- `isHovering` 是 `@Published public private(set)`，**因此可订阅** `notch.$isHovering` 自行展开。
- **floating 样式不支持 compact**：`_compact()` 内
  `if effectiveStyle(for: screen).isFloating { await hide(); return }`
  —— 无刘海机型上调用 `compact()` 等于隐藏窗口。

- [ ] **Step 1: 写 `Views.swift`**

```swift
import SwiftUI

/// Resting state: a compact percentage pill beside the notch.
///
/// The library lays `compactLeading` out to the left of the physical notch and
/// `compactTrailing` to its right, separated by a spacer as wide as the notch
/// itself. Keeping all content in `compactTrailing` guarantees it is never
/// covered by the black notch cutout.
struct ProgressPill: View {
    @ObservedObject var buffer: ProgressBuffer

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: buffer.phase == .done(ok: false) ? "exclamationmark.triangle.fill"
                                                              : "hourglass")
                .font(.system(size: 10, weight: .semibold))
            Text("\(Int((buffer.percent * 100).rounded()))%")
                // 垂直预算很紧：内容被 frame 到 notchSize.height（= safeAreaInsets.top，
                // 本机 32pt），其中 4pt(top) + 8pt(bottom) 的 inset 已被占用，
                // 实际可用约 20pt。字号超过 ~13pt 会被 NotchShape 的 mask 裁掉。
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .monospacedDigit()
        }
        .foregroundStyle(.white)
        // 库只在 compactTrailing 的**外侧**（.trailing）加了 8pt inset，
        // 朝向刘海那一侧没有 inset（HStack spacing 为 0），因此必须自己补
        // leading padding，否则百分比文字会紧贴物理刘海右边缘。
        .padding(.leading, 8)
        .padding(.trailing, 6)
    }
}

/// Expanded state: progress bar, percentage, and the status line.
struct ProgressDetail: View {
    @ObservedObject var buffer: ProgressBuffer

    private var tint: Color {
        buffer.phase == .done(ok: false) ? .orange : .white
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(buffer.phase == .done(ok: false) ? "任务未正常结束" : "任务进度")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Text("\(Int((buffer.percent * 100).rounded()))%")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .monospacedDigit()
            }
            ProgressView(value: min(1, max(0, buffer.percent)))
                .progressViewStyle(.linear)
                .tint(tint)
            if let message = buffer.message, !message.isEmpty {
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .foregroundStyle(.white)
        .frame(width: 260)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
```

- [ ] **Step 2: 写 `NotchController.swift`**

实现要点：

- 持有 `DynamicNotch<ProgressDetail, EmptyView, ProgressPill>` 与 `ProgressBuffer`。
- `start()`：
  1. 创建 notch，`style: .auto`，`hoverBehavior: [.increaseShadow]`。
     **绝不能包含 `.keepVisible`**：已核实库的 `_hide` 内
     `if hoverBehavior.contains(.keepVisible), isHovering { Task { sleep(0.1); _hide(...) }; return }`
     —— 若包含它，任务结束时光标只要还停在岛上，`hide()` 就会**每 0.1s 重试直到光标移开**，
     直接违反"结束即收起"。`.all` 同样含它，所以也不能用。
  2. 订阅 `buffer.$isVisible`：由 false→true 时 `await notch.compact()`（有刘海）或
     `await notch.expand()`（无刘海，因为 floating 下 compact 会隐藏）；由 true→false 时 `await notch.hide()`。
  3. 订阅 `notch.$isHovering`：为 true 时 `await notch.expand()`，为 false 时
     `await notch.compact()`。**这是 hover-to-expand 的实现**——库不会自己做。
     无刘海机型上忽略 hover→compact（会隐藏窗口），改为忽略移出事件。
  4. 订阅 `buffer.$phase`：进入 `.done` 后等待约 1.2s 再 `await notch.hide()`，
     并 `buffer.apply(.bye)` 复位。用 `Task` + `Task.sleep`，并保存任务句柄以便取消。
     **必须处理以下竞态**：`hideTask` 是**单一可取消任务**——若在 1.2s 窗口内
     `buffer.isVisible` 由 false 变回 true（新任务立刻开始），**必须先 `hideTask?.cancel()`
     再重新 compact/expand**。否则上一次任务的 `hide()` 会在 `await` 返回后关掉刚出现的药丸，
     表现为"新任务开始时灵动岛闪一下就不见了"。这条是本任务最容易漏且症状隐蔽的缺陷。
- 判断是否无刘海：`NSScreen.screens.first?.hasNotch`。注意 `hasNotch` 是
  DynamicNotchKit 在 `NSScreen` 上的 extension（`internal`），**在你的 target 里不可见**——
  因此自行实现等价判断：
  `screen.auxiliaryTopLeftArea?.width != nil && screen.auxiliaryTopRightArea?.width != nil`。
- **hover 切换必须防抖（约 150–250ms）**：已核实 compact↔expanded 的中间转换跑在
  一个**不被 `expand()`/`compact()` await 的 detached `Task`** 里，且依赖
  `guard self.state == .hidden else { return }`。快速移入移出会触发互相打架的转换、
  守卫各自 bail，导致视觉状态与最后一次调用不一致。防抖 + 串行化后再依赖它。
- 所有 `await notch.*` 调用必须在 `@MainActor` 上下文（库的窗口操作是主线程的，
  `DynamicNotchControllable` 协议标注了 `@MainActor`）。
- `stop()`：取消所有订阅与 Task，调用 `Task { await notch.hide() }`。**不阻塞**等待动画。

- [ ] **Step 3: 接线 `main.swift`**
替换 Task 1 的骨架：解析 socket 路径（`argv[1]`，或默认 `~/Library/Application Support/dsh-island/island.sock`），
创建 `ProgressBuffer` 与 `NotchController`，创建并 `start()` `SocketServer`，
把 `onMessage` 投递到 `@MainActor` 上的 `buffer.apply`，然后 `NSApplication.shared.run()`。

关键：`onMessage` 来自 `DispatchSource` 的后台队列，**必须**显式切回主 actor：

```swift
Task { @MainActor in buffer.apply(message) }
```

- [ ] **Step 4: 构建**

Run: `swift build --disable-sandbox --package-path swift/DynamicIslandBridge`
Expected: `Build complete!`

- [ ] **Step 5: 手工验证渲染（本任务的关键验收）**

Run:
```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
SOCK="$HOME/Library/Application Support/dsh-island/island.sock"
swift run --disable-sandbox --package-path swift/DynamicIslandBridge DynamicIslandBridge "$SOCK" &
sleep 3
echo '{"type":"progress","percent":0.42,"mode":"precise","message":"正在编译"}' | nc -U "$SOCK"
```

Expected:
1. 刘海右侧出现 `42%` 药丸（含沙漏图标）。
2. **鼠标悬停**在药丸上 → 展开显示进度条 + 42% + "正在编译"。
3. 移开鼠标 → 收起回药丸。
4. `echo '{"type":"done","reason":"completed","ok":true}' | nc -U "$SOCK"` → 药丸短暂显示 100% 后整个消失。
5. **Dock 中不出现图标**，菜单栏无本程序条目。

若看到的是悬浮圆角浮层而非刘海药丸，说明 `style: .auto` 判定为无刘海——
用 `NSScreen.screens.first?.auxiliaryTopLeftArea` 复核（本机应为非 nil）。

- [ ] **Step 6: 验证无刘海降级路径（Review Focus 第 3 条）**

无法在本机物理验证（本机有刘海）。改为**代码审查 + 逻辑确认**：
确认 `NotchController` 在 `hasNotch == false` 时调用 `expand()` 而不是 `compact()`，
并在 README 中记录该差异。在 ledger 中注明此路径为**未经物理验证**。

- [ ] **Step 7: Commit**

```bash
git add swift/DynamicIslandBridge/Sources/DynamicIslandBridge/Views.swift \
        swift/DynamicIslandBridge/Sources/DynamicIslandBridge/NotchController.swift \
        swift/DynamicIslandBridge/Sources/DynamicIslandBridge/main.swift
git commit -m "feat(swift): render notch pill with hover-to-expand and notchless fallback"
```

---

## Task 6: 集成、超时收起与端到端验证

**Files:**
- Modify: `swift/DynamicIslandBridge/Sources/DynamicIslandBridge/NotchController.swift`
- Modify: `swift/DynamicIslandBridge/Sources/DynamicIslandBridge/main.swift`
- Create: `swift/DynamicIslandBridge/README.md`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可被阶段一插件启动并驱动的完整辅助进程

- [ ] **Step 1: 加入超时自动收起**

`NotchController` 增加空闲计时：每次收到 `progress` 重置计时器；
`idleTimeoutMs`（默认 120_000，与插件侧一致）内无消息则 `await notch.hide()` 并复位 buffer。
这覆盖插件意外死亡、socket 半开等场景——否则灵动岛会永久停留在最后一次进度。

- [ ] **Step 2: 确认信号处理**

`main.swift` 注册 `SIGTERM`/`SIGINT` 处理：`server.stop()` + `notch.hide()` 后 `exit(0)`。
插件侧 `dispose()` 先发 SIGTERM 并等待退出，因此这里必须**及时退出**，否则会走到 SIGKILL。

- [ ] **Step 3: 写入 `swift/DynamicIslandBridge/README.md`**

记录：用途、如何构建（指向 `scripts/build-helper.sh`）、协议表、故障排查
（socket 权限、helper 未启动、floating 降级）。

- [ ] **Step 4: 端到端验证（真插件 → 真 helper）**

Run:
```sh
bash scripts/build-helper.sh
# 用假 helper 的路径换成真 helper 做一次对照：
#   阶段一的 npm test 已覆盖协议与生命周期；本步验证渲染。
npm test
bash scripts/verify-teardown.sh DynamicIslandBridge
```

Expected: `npm test` 全绿；`verify-teardown.sh` 报告 CLEAN——**证明插件 dispose 后
真 helper 也被终止**，这是阶段一与阶段二合起来才成立的端到端清理保证。

- [ ] **Step 5: 全量回归**

Run:
```sh
npm test && npm run typecheck
swift test --disable-sandbox --package-path swift/DynamicIslandBridge
```

Expected: TS 侧 63/63 + typecheck 干净；Swift 侧 32/32。

- [ ] **Step 6: Commit**

```bash
git add swift/DynamicIslandBridge
git commit -m "feat(swift): add idle timeout, signal handling, and integration docs"
```

---

## 附：与阶段一的接口对照

| 阶段一（TypeScript） | 阶段二（Swift） | 一致性 |
|---|---|---|
| `Protocol.ts` `OutboundMessage`（4 种 type） | `InboundMessage`（同样 4 种） | 字段名逐字对应 |
| `encodeMessage` 无裸换行 | `LineBuffer` 按 `\n` 分帧 | 一致 |
| `validateProgress` clamp `[0,1]` + 拒绝非有限 | `decodeMessage` clamp `[0,1]` + 拒绝非有限 | 一致（双方都做，双保险） |
| `done` 的 `ok` 决定是否 100% | `ProgressBuffer.apply(.done)` 同样分流 | 一致 |
| socket 路径 + 目录 0700 | 同路径、同权限 | 一致 |
| 插件侧 connect 重试 | server 侧 accept 循环 | 一致 |
| `graceMs` 默认 3000 | SIGTERM → 及时 exit | 一致 |

**唯一的单位约定**：wire 上的 `percent` 是 **0..1 小数**。阶段一的
`estimatePercent` 返回 0..90 **百分比**，但它在 `ProgressMachine.onStep` 内已 `/100` 转成小数，
因此到达 wire 时已经是小数——阶段二无需再做除法。
