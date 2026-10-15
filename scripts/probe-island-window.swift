// Reports whether a process owns any on-screen window.
//
// Used by scripts/e2e-real-helper.mjs to assert that the full chain — plugin
// event → Unix socket → Swift helper → window server — actually produced a
// window. Exits 0 when at least one matching window exists, 1 otherwise.
//
// Matching is by PID when a second argument is given, and only by owner name
// otherwise. PID matching exists because name matching is not selective enough
// for an e2e run: a developer with the plugin actually mounted always has
// another `DynamicIslandBridge` window on screen, and it was being counted —
// every "expected 0 windows" assertion failed, and worse, assertions expecting a
// window to disappear "passed" against somebody else's island. Both failure
// modes were observed.
//
// Build:
//   swiftc -O -o /tmp/probe scripts/probe-island-window.swift

import CoreGraphics
import Foundation

let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "DynamicIslandBridge"
let wantedPid = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) : nil

let windows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] ?? []

let matched = windows.filter {
    let owner = $0[kCGWindowOwnerName as String] as? String ?? ""
    guard owner.localizedCaseInsensitiveContains(target) else { return false }
    guard let wantedPid else { return true }
    return ($0[kCGWindowOwnerPID as String] as? Int) == wantedPid
}

for window in matched {
    let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    let ownerPid = window[kCGWindowOwnerPID as String] as? Int ?? -1
    let x = Int(bounds["X"] ?? 0), y = Int(bounds["Y"] ?? 0)
    let w = Int(bounds["Width"] ?? 0), h = Int(bounds["Height"] ?? 0)
    print("WINDOW pid=\(ownerPid) layer=\(layer) x=\(x) y=\(y) w=\(w) h=\(h)")
}
print("MATCHED=\(matched.count)")
exit(matched.isEmpty ? 1 : 0)
