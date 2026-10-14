import Foundation

/// Command-line options for the helper.
///
/// The plugin starts this process as `helper <socketPath>` (see
/// `src/supervisor.ts`), so the socket path is the **last positional** argument.
/// That still holds when the helper is a `node script.mjs` stand-in, where argv
/// is `[node, script, socket]` — which is why the last element is read rather
/// than `argv[1]`.
///
/// Positional, not "the last argument": once a flag with a value exists, the raw
/// last argument can be that value. Parsing properly is the difference between
/// `--idle-timeout-ms 5000` meaning "five seconds" and meaning "listen on a
/// socket called 5000".
public struct BridgeOptions: Equatable {
    /// Must stay in step with `idleTimeoutMs` in `src/index.ts`.
    public static let defaultIdleTimeoutMilliseconds: UInt64 = 120_000

    public var socketPath: String
    public var idleTimeoutMilliseconds: UInt64

    public init(socketPath: String, idleTimeoutMilliseconds: UInt64) {
        self.socketPath = socketPath
        self.idleTimeoutMilliseconds = idleTimeoutMilliseconds
    }

    public static func parse(_ arguments: [String]) -> BridgeOptions {
        var idleTimeout = defaultIdleTimeoutMilliseconds
        var positional: [String] = []

        var index = 1 // skip argv[0]
        while index < arguments.count {
            let argument = arguments[index]

            if argument == "--idle-timeout-ms" {
                // A malformed value falls back to the default rather than killing
                // the process: this is a diagnostic knob, not a contract.
                if index + 1 < arguments.count, let value = UInt64(arguments[index + 1]) {
                    idleTimeout = value
                    index += 2
                    continue
                }
                index += 1
                continue
            }

            if !argument.hasPrefix("-") {
                positional.append(argument)
            }
            index += 1
        }

        return BridgeOptions(
            socketPath: positional.last ?? defaultSocketPath(),
            idleTimeoutMilliseconds: idleTimeout
        )
    }
}

/// Mirrors `defaultSocketPath()` in `src/index.ts`.
public func defaultSocketPath() -> String {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("Application Support", isDirectory: true)
        .appendingPathComponent("dsh-island", isDirectory: true)
        .appendingPathComponent("island.sock")
        .path
}
