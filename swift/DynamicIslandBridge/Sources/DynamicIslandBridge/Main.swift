import AppKit
import Foundation

/// Version reported by `--version`. Kept in sync with the plugin's package.json
/// by hand; nothing machine-checks it.
let bridgeVersion = "0.1.0"

/// Diagnostics go to **stderr**, never stdout: the plugin spawns this process with
/// stdout set to `ignore`, so anything written there is discarded — and an
/// undrained stdout pipe would eventually block the process mid-write.
func islandLog(_ text: String) {
    FileHandle.standardError.write(Data("island: \(text)\n".utf8))
}

/// Entry point.
///
/// This process is a background accessory: no Dock icon, no menu bar item, no
/// main window, and it never takes focus. The activation policy must be set
/// before any window is created, which is why it happens first.
///
/// NOTE: this file is deliberately NOT named `main.swift`. A file with that name
/// is the module's implicit top-level entry point, and `@main` cannot coexist
/// with it.
@main
enum DynamicIslandBridgeMain {
    @MainActor
    static func main() {
        NSApplication.shared.setActivationPolicy(.accessory)

        if CommandLine.arguments.contains("--version") {
            print("DynamicIslandBridge \(bridgeVersion)")
            exit(0)
        }

        let socketPath = resolveSocketPath(CommandLine.arguments)

        do {
            try ensureParentDirectory(of: socketPath)
        } catch {
            islandLog("cannot prepare the socket directory for \(socketPath): \(error)")
            exit(1)
        }

        let buffer = ProgressBuffer()
        let controller = NotchController(buffer: buffer)
        controller.start()

        let server = SocketServer(
            socketPath: socketPath,
            onMessage: { message in
                // Delivered on the server's own serial queue.
                Task { @MainActor in buffer.apply(message) }
            },
            onError: { text in islandLog(text) }
        )

        do {
            try server.start()
        } catch {
            islandLog("cannot listen on \(socketPath): \(error)")
            exit(1)
        }

        islandLog("listening on \(socketPath)")
        NSApplication.shared.run()
    }
}

/// Where to listen.
///
/// The plugin always appends the socket path as the **last** argument
/// (`src/supervisor.ts`). Reading the last element rather than `argv[1]` keeps
/// this correct for both the native binary (`[binary, socket]`) and a
/// `node script.mjs` stand-in used during development
/// (`[node, script, socket]`).
func resolveSocketPath(_ arguments: [String]) -> String {
    if let last = arguments.dropFirst().last, !last.hasPrefix("-") {
        return last
    }
    return defaultSocketPath()
}

/// Mirrors `defaultSocketPath()` in `src/index.ts`.
func defaultSocketPath() -> String {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("Application Support", isDirectory: true)
        .appendingPathComponent("dsh-island", isDirectory: true)
        .appendingPathComponent("island.sock")
        .path
}

/// The socket lives in a directory only this user can enter: the path is
/// predictable, and a world-writable parent would invite a symlink race.
func ensureParentDirectory(of path: String) throws {
    let directory = (path as NSString).deletingLastPathComponent
    guard !directory.isEmpty else { return }

    let manager = FileManager.default
    try manager.createDirectory(
        atPath: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    // `attributes` only applies when the directory is created, so tighten an
    // existing one explicitly.
    try? manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory)
}
