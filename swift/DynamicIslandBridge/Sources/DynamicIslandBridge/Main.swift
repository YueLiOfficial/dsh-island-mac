import AppKit
import Foundation

/// Version reported by `--version`. Kept in sync with the plugin's package.json
/// major/minor by hand; nothing machine-checks it.
let bridgeVersion = "0.1.0"

/// Entry point.
///
/// This process is a background accessory: no Dock icon, no menu bar item, no
/// main window, and it never takes focus. The activation policy must be set
/// before any window is created, so it happens first — before the socket server
/// and before DynamicNotchKit exists.
///
/// NOTE: this file is deliberately NOT named `main.swift`. A file with that name
/// is the module's implicit top-level entry point, and `@main` cannot coexist
/// with it.
@main
enum DynamicIslandBridgeMain {
    static func main() {
        NSApplication.shared.setActivationPolicy(.accessory)

        if CommandLine.arguments.contains("--version") {
            print("DynamicIslandBridge \(bridgeVersion)")
            exit(0)
        }

        // Wired up in later tasks: socket server + notch controller.
        exit(0)
    }
}
