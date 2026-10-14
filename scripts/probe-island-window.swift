// Reports whether a process owns any on-screen window.
//
// Used by scripts/e2e-real-helper.mjs to assert that the full chain — plugin
// event → Unix socket → Swift helper → window server — actually produced a
// window. Exits 0 when at least one matching window exists, 1 otherwise.
//
// Build:
//   swiftc -O -o /tmp/probe scripts/probe-island-window.swift

import CoreGraphics
import Foundation

let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "DynamicIslandBridge"

let windows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] ?? []

let matched = windows.filter {
    ($0[kCGWindowOwnerName as String] as? String ?? "")
        .localizedCaseInsensitiveContains(target)
}

for window in matched {
    let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    let x = Int(bounds["X"] ?? 0), y = Int(bounds["Y"] ?? 0)
    let w = Int(bounds["Width"] ?? 0), h = Int(bounds["Height"] ?? 0)
    print("WINDOW layer=\(layer) x=\(x) y=\(y) w=\(w) h=\(h)")
}
print("MATCHED=\(matched.count)")
exit(matched.isEmpty ? 1 : 0)
