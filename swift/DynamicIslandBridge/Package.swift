// swift-tools-version: 6.0
import PackageDescription

// DynamicIslandBridge is the native helper behind the dsh-dynamic-island-progress
// plugin. The plugin is the socket *client*; this process is the *server*.
//
// DynamicNotchKit is the only third-party dependency. It is a SwiftUI package, so
// building it requires the SwiftUIMacros plugin that ships only inside full
// Xcode.app — see scripts/build-helper.sh and the Swift plan for the write-up.
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
            // No `resources:` on purpose. The whale mark is embedded in
            // WhaleMarkData.swift: a SwiftPM resource bundle is a sidecar the
            // distributed executable does not carry, and Bundle.module then traps
            // at first render. See the type doc on WhaleMarkAsset.
        ),
        .testTarget(
            name: "DynamicIslandBridgeTests",
            dependencies: ["DynamicIslandBridge"],
            path: "Tests/DynamicIslandBridgeTests",
            // The production target is compiled in the Swift 6 language mode.
            // The test target deliberately is not: XCTestExpectation carries no
            // Sendable annotation in the macOS SDK, so the plan's expectation-based
            // socket tests cannot be written as strict-concurrency-clean closures.
            // See the ledger ruling for Task 1.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
