import XCTest
@testable import DynamicIslandBridge

/// Proves the executable target is importable from the test target. Every later
/// test depends on this working, so it is the first thing the suite checks.
final class SmokeTests: XCTestCase {
    func testExecutableTargetIsTestable() {
        XCTAssertEqual(bridgeVersion, "0.1.0")
    }
}
