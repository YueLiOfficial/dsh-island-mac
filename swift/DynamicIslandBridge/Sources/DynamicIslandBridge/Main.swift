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

/// Retained for the lifetime of the process.
///
/// This must be a stored global, not a discarded return value: a `DispatchSource`
/// that loses its last reference is cancelled, which would leave SIGTERM ignored
/// (the disposition was replaced with `SIG_IGN`) and the process unkillable except
/// by SIGKILL. That failure mode is exactly what the end-to-end check caught.
@MainActor private var signalSources: [DispatchSourceSignal] = []

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

        let options = BridgeOptions.parse(CommandLine.arguments)

        do {
            try ensureParentDirectory(of: options.socketPath)
        } catch {
            islandLog("cannot prepare the socket directory for \(options.socketPath): \(error)")
            exit(1)
        }

        let buffer = ProgressBuffer()
        let controller = NotchController(
            buffer: buffer,
            lingerMilliseconds: options.lingerMilliseconds,
            idleTimeoutMilliseconds: options.idleTimeoutMilliseconds
        )
        controller.start()

        let server = SocketServer(
            socketPath: options.socketPath,
            onMessage: { message in
                // Delivered on the server's own serial queue.
                Task { @MainActor in buffer.apply(message) }
            },
            onError: { text in islandLog(text) }
        )

        do {
            try server.start()
        } catch {
            islandLog("cannot listen on \(options.socketPath): \(error)")
            exit(1)
        }

        signalSources = installSignalHandlers(server: server, controller: controller)

        // The pid is included so an end-to-end check can verify *this* process
        // exited, without resorting to `pgrep -f`, which also matches the shell
        // that invoked it.
        islandLog("listening on \(options.socketPath) (pid \(getpid()))")
        NSApplication.shared.run()
    }
}

/// Handles SIGTERM/SIGINT by shutting down and exiting promptly.
///
/// The plugin's disposer sends SIGTERM and waits `graceMs` (3s) before escalating
/// to SIGKILL, so anything slow here shows up as an ungraceful kill.
///
/// Dispatch sources rather than a C signal handler: a signal handler may only
/// call async-signal-safe functions, and neither `Task { }` nor Swift runtime
/// work qualifies. A `DispatchSourceSignal` handler runs in normal context.
///
/// **The caller must retain the returned sources.** A released dispatch source is
/// cancelled, and since the default disposition has been replaced with `SIG_IGN`
/// the signal would then be ignored entirely.
@MainActor
private func installSignalHandlers(
    server: SocketServer,
    controller: NotchController
) -> [DispatchSourceSignal] {
    // Default disposition would kill the process before the dispatch source ever
    // runs, leaving the socket file behind.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    var sources: [DispatchSourceSignal] = []
    for signalNumber in [SIGTERM, SIGINT] {
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            // The main dispatch queue is the main actor's executor.
            MainActor.assumeIsolated {
                controller.stop()
                // Also unlinks the socket, so the next start does not need the
                // stale-socket recovery path.
                server.stop()
                islandLog("stopped on signal \(signalNumber)")
                exit(0)
            }
        }
        source.resume()
        sources.append(source)
    }
    return sources
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
