import XCTest
@testable import DynamicIslandBridge

final class BridgeOptionsTests: XCTestCase {

    func testSocketPathIsTheLastPositionalArgument() {
        let options = BridgeOptions.parse(["/bin/helper", "/tmp/island.sock"])
        XCTAssertEqual(options.socketPath, "/tmp/island.sock")
    }

    /// During development the plugin may be pointed at a `node script.mjs`
    /// stand-in, so argv is `[node, script, socket]`. Reading the last element
    /// rather than `argv[1]` is what makes one helper work for both shapes.
    func testWorksWhenTheHelperIsRunThroughNode() {
        let options = BridgeOptions.parse(["/usr/bin/node", "fake-helper.mjs", "/tmp/island.sock"])
        XCTAssertEqual(options.socketPath, "/tmp/island.sock")
    }

    func testDefaultsTheSocketPathWhenNoneIsGiven() {
        let options = BridgeOptions.parse(["/bin/helper"])
        XCTAssertEqual(options.socketPath, defaultSocketPath())
    }

    /// The regression this parser exists for: treating the raw last argument as
    /// the socket path would make the timeout value the socket path.
    func testIdleTimeoutValueDoesNotBecomeTheSocketPath() {
        let options = BridgeOptions.parse(["/bin/helper", "--idle-timeout-ms", "5000"])
        XCTAssertEqual(options.socketPath, defaultSocketPath())
        XCTAssertEqual(options.idleTimeoutMilliseconds, 5000)
    }

    func testIdleTimeoutFlagBeforeTheSocketPath() {
        let options = BridgeOptions.parse([
            "/bin/helper", "--idle-timeout-ms", "5000", "/tmp/island.sock",
        ])
        XCTAssertEqual(options.socketPath, "/tmp/island.sock")
        XCTAssertEqual(options.idleTimeoutMilliseconds, 5000)
    }

    func testUnknownFlagDoesNotBecomeTheSocketPath() {
        let options = BridgeOptions.parse(["/bin/helper", "--verbose"])
        XCTAssertEqual(options.socketPath, defaultSocketPath())
    }

    func testInvalidIdleTimeoutIsIgnoredNotFatal() {
        let options = BridgeOptions.parse([
            "/bin/helper", "--idle-timeout-ms", "abc", "/tmp/island.sock",
        ])
        XCTAssertEqual(options.socketPath, "/tmp/island.sock")
        XCTAssertEqual(
            options.idleTimeoutMilliseconds,
            BridgeOptions.defaultIdleTimeoutMilliseconds,
            "坏值应退回默认值，而不是让 helper 起不来"
        )
    }

    func testTrailingIdleTimeoutWithoutValueIsIgnored() {
        let options = BridgeOptions.parse(["/bin/helper", "--idle-timeout-ms"])
        XCTAssertEqual(options.socketPath, defaultSocketPath())
        XCTAssertEqual(options.idleTimeoutMilliseconds, BridgeOptions.defaultIdleTimeoutMilliseconds)
    }

    /// Must stay in step with `idleTimeoutMs` in `src/index.ts`.
    func testDefaultIdleTimeoutMatchesThePluginSide() {
        XCTAssertEqual(BridgeOptions.defaultIdleTimeoutMilliseconds, 120_000)
    }
}
