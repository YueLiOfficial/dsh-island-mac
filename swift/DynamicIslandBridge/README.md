# DynamicIslandBridge

`dsh-island-mac` 的原生辅助进程：在 macOS 刘海区渲染当前 DSH 任务的完成百分比。

它没有主窗口、没有 Dock 图标、不抢焦点（`NSApplication.setActivationPolicy(.accessory)`），
随插件生命周期启动与终止。

## 角色

```
插件 (TypeScript, client)  ──NDJSON over Unix socket──▶  本进程 (server)
   connect + 推进度                                        bind + listen + 渲染
```

**为什么辅助进程是 server**：它是容易重启的一方。让稳定的插件做重连方，
失败处理比反过来简单——客户端断开后 server 只需回到 `accept`，不必退出。

## 构建

```sh
bash scripts/build-helper.sh      # 产出 bin/DynamicIslandBridge
```

构建必须走 **SwiftPM**，不要用裸 `swiftc` 验证宏。DynamicNotchKit 是 SwiftUI 包，
需要 `SwiftUIMacros` 宏插件，而它只随完整 Xcode.app 分发。脚本已固化三个坑的规避：
`--disable-sandbox`（DSH agent 沙箱内必需）、缓存重定向到仓库内、
`DEVELOPER_DIR` 优先指向 Xcode.app。

## 运行

```sh
bin/DynamicIslandBridge [--idle-timeout-ms <毫秒>] [<socket 路径>]
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `<socket 路径>` | `~/Library/Application Support/dsh-island/island.sock` | 位置参数，取**最后一个位置参数** |
| `--idle-timeout-ms` | `120000` | 无消息多久后自动收起；与插件 `idleTimeoutMs` 保持一致 |
| `--version` | — | 打印版本后退出 |

socket 路径取「最后一个**位置参数**」而不是「最后一个参数」：插件总是把它追加到 argv 末尾
（`src/supervisor.ts`），但 `--idle-timeout-ms 5000` 之后最后一个参数是 `5000` 而不是路径。
解析器 `BridgeOptions` 把两者分开，并有单元测试钉住。

socket 目录会自动创建并设为 `0700`，socket 文件本身为 `0600`。

## 协议（NDJSON）

每行一个 JSON 对象，UTF-8。插件 → 本进程方向：

| type | 字段 | 行为 |
|---|---|---|
| `hello` | `version: number` | 握手。**不显示**灵动岛——否则每次重连都会闪一下 |
| `progress` | `percent: 0..1`、`mode: "estimated"｜"precise"`、`message?: string` | 更新药丸数值；`message` 缺省时保留上一条 |
| `done` | `reason: string`、`ok: boolean` | `ok:true` → 显示 100% 并停留 ~1.2s 后收起；`ok:false` → 保持当前值 + 失败标记 |
| `bye` | — | 立即收起，回 `accept` |

接收端容忍**半包与粘包**：帧可能被拆到多次 `read`，也可能一次到达多帧。
`percent` clamp 到 `0...1`；非有限值、非数字、布尔值一律丢弃而非强转——
`true` 在 Swift 里会经 `NSNumber` 桥接成 `1.0`，静默显示成 100%。

## 显示形态

| 机型 | 行为 |
|---|---|
| 有刘海 | 刘海中常驻百分比药丸，hover 展开进度条与消息 |
| **无刘海** | **无法常驻药丸**，降级为 hover-to-expand |

无刘海机型降级的原因在库内部：`DynamicNotch._compact()` 里有

```swift
if effectiveStyle(for: screen).isFloating { await hide(); return }
```

即 floating 样式下调用 `compact()` 等于隐藏窗口。所以本进程在无刘海机型上改为
`expand()`，并且**忽略** hover 移出事件（否则鼠标一移开窗口就没了）。
这是 DynamicNotchKit 的固有限制，不是本进程的缺陷。

## 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 插件日志 `helper not reachable at <socket> (binary: <path>)` | 二进制不存在，或 Xcode 缺失导致从未构建成功 | `bash scripts/build-helper.sh`；无完整 Xcode 时这是预期的降级，DSH 其余功能不受影响 |
| 插件日志停在 `helper not reachable`，二进制却在 | socket 路径长度超过 103 字节（`sun_path` 是 `char[104]`，含 NUL） | 进程会在 stderr 明确报 `unix socket path is too long`；换更短的路径 |
| 岛出现后不收起 | 上一次崩溃残留的 socket 被 bind 到，或插件进程死亡且空闲超时未到 | 本进程启动时无条件 `unlink` stale socket；空闲超时默认 120s |
| 鼠标移开后岛不收起（有刘海机型） | `hoverBehavior` 若含 `.keepVisible`，库的 `_hide()` 会每 0.1s 重试直到光标移开 | 已固定为 `[.increaseShadow]`，**不要**改成 `.all`（`.all` 含 `.keepVisible`） |
| 岛卡在最后一次进度不动 | 插件已死但 socket 半开，没有 EOF | 空闲超时（`--idle-timeout-ms`）；默认 120s |
| SIGTERM 后进程不退、被 SIGKILL | 信号处理未生效 | `DispatchSourceSignal` 必须被**持有**：释放的 dispatch source 会被取消，而默认处置已被换成 `SIG_IGN`，信号就彻底被忽略 |

## 测试

```sh
swift test --disable-sandbox --package-path swift/DynamicIslandBridge

# 端到端：真插件源码 → 真二进制 → 真窗口（含孤儿与空闲超时检查）
node scripts/e2e-real-helper.mjs
```

单元测试覆盖纯逻辑（协议解码、socket 服务、进度状态、显示决策），不需要显示器。
渲染与进程生命周期由 `scripts/e2e-real-helper.mjs` 在真机验证。

## 许可证

本进程未指定许可证。DynamicNotchKit 为 MIT。
