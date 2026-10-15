import Darwin
import Foundation
import XCTest
@testable import DynamicIslandBridge

final class SocketServerTests: XCTestCase {
    private var dir: String!
    private var socketPath: String!

    override func setUpWithError() throws {
        // Deliberately short. `sockaddr_un.sun_path` is 104 bytes *including* the
        // NUL terminator, and NSTemporaryDirectory() alone is ~48 bytes here, so
        // a full UUID in the directory name would overflow it and bind() would
        // fail with a baffling EINVAL. See the Task 1 ledger ruling.
        dir = NSTemporaryDirectory() + "isl-" + UUID().uuidString.prefix(8)
        try FileManager.default.createDirectory(
            atPath: dir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        socketPath = dir + "/island.sock"
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: dir)
    }

    private func makeServer(_ received: @escaping (InboundMessage) -> Void) throws -> SocketServer {
        // The test target runs in the Swift 5 language mode (see Package.swift), so
        // this is belt-and-braces rather than required: XCTestExpectation carries no
        // Sendable annotation, and the handler really is only used from the server's
        // serial queue.
        nonisolated(unsafe) let handler = received
        let server = SocketServer(socketPath: socketPath, onMessage: { handler($0) }, onError: { _ in })
        try server.start()
        return server
    }

    /// Opens one connection and returns its descriptor; the caller closes it.
    ///
    /// Real BSD sockets, not a mock: framing bugs live in the byte stream, and a
    /// mock would hide exactly the defects these tests exist to catch.
    private func connectClient() -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0)
        guard fd >= 0 else { return fd }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = socketPath.withCString { source in
            withUnsafeMutablePointer(to: &addr.sun_path) { pathPointer in
                pathPointer.withMemoryRebound(to: CChar.self, capacity: 104) { destination in
                    // strlcpy, not strncpy: it always NUL-terminates.
                    strlcpy(destination, source, 104)
                }
            }
        }

        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, length) }
        }
        XCTAssertEqual(result, 0, "connect 失败 (errno \(errno))")
        return fd
    }

    private func send(_ text: String, to fd: Int32) {
        _ = text.withCString { Darwin.write(fd, $0, strlen($0)) }
    }

    /// Connect, send one chunk, disconnect.
    private func sendRaw(_ text: String) throws {
        let fd = connectClient()
        defer { close(fd) }
        send(text, to: fd)
    }

    func testStartCreatesSocketFile() throws {
        let server = try makeServer { _ in }
        defer { server.stop() }
        XCTAssertTrue(FileManager.default.fileExists(atPath: socketPath))
    }

    func testRemovesStaleSocketBeforeBinding() throws {
        // Simulate the leftover of a previous crash.
        FileManager.default.createFile(atPath: socketPath, contents: Data("stale".utf8))
        XCTAssertNoThrow(try makeServer { _ in })
    }

    func testStopRemovesSocketFile() throws {
        let server = try makeServer { _ in }
        server.stop()
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: socketPath),
            "stop() 必须 unlink，否则重启时会 bind 到别人的 socket"
        )
    }

    func testReceivesProgressMessage() throws {
        let exp = expectation(description: "收到 progress")
        let server = try makeServer { msg in
            if case .progress(let percent, _, _, _) = msg {
                XCTAssertEqual(percent, 0.42, accuracy: 0.001)
                exp.fulfill()
            }
        }
        defer { server.stop() }
        try sendRaw("{\"type\":\"progress\",\"percent\":0.42,\"mode\":\"precise\"}\n")
        wait(for: [exp], timeout: 5)
    }

    /// Reviews-review focus #1: a frame split across reads must be reassembled.
    ///
    /// Both halves go over the *same* connection. Sending them over two
    /// connections would not test reassembly at all: a new connection starts a
    /// new framing context and the partial frame is correctly discarded.
    func testReassemblesFrameSplitAcrossWrites() throws {
        let exp = expectation(description: "收到完整帧")
        let server = try makeServer { msg in
            if case .bye = msg { exp.fulfill() }
        }
        defer { server.stop() }

        let client = connectClient()
        defer { close(client) }

        send("{\"type\":\"b", to: client)
        usleep(50_000)
        send("ye\"}\n", to: client)

        wait(for: [exp], timeout: 5)
    }

    /// A frame split at a multi-byte UTF-8 boundary over a real socket.
    func testReassemblesSplitMultibyteFrame() throws {
        let exp = expectation(description: "收到完整中文帧")
        let server = try makeServer { msg in
            if case .progress(_, _, let message, _) = msg, message == "正在编译" {
                exp.fulfill()
            }
        }
        defer { server.stop() }

        let client = connectClient()
        defer { close(client) }

        let line = "{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"precise\",\"message\":\"正在编译\"}\n"
        let bytes = Array(line.utf8)
        guard let firstNonASCII = bytes.firstIndex(where: { $0 > 0x7F }) else {
            return XCTFail("测试夹具里没有非 ASCII 字节")
        }
        let cut = firstNonASCII + 1 // 落在一个 CJK 标量内部

        _ = bytes[0..<cut].withUnsafeBufferPointer { Darwin.write(client, $0.baseAddress, cut) }
        usleep(50_000)
        let tail = Array(bytes[cut...])
        _ = tail.withUnsafeBufferPointer { Darwin.write(client, $0.baseAddress, tail.count) }

        wait(for: [exp], timeout: 5)
    }

    func testAcceptsSecondConnectionAfterFirstDisconnects() throws {
        let exp = expectation(description: "第二次连接仍被服务")
        exp.expectedFulfillmentCount = 2
        let server = try makeServer { msg in
            if case .bye = msg { exp.fulfill() }
        }
        defer { server.stop() }
        try sendRaw("{\"type\":\"bye\"}\n")
        usleep(200_000)
        try sendRaw("{\"type\":\"bye\"}\n")
        wait(for: [exp], timeout: 5)
    }

    /// Single-client semantics: a second connection replaces the first rather
    /// than being refused, so a plugin restart always wins.
    func testSecondConnectionReplacesAStillOpenFirst() throws {
        let exp = expectation(description: "新连接被服务")
        let server = try makeServer { msg in
            if case .bye = msg { exp.fulfill() }
        }
        defer { server.stop() }

        let first = connectClient()
        defer { close(first) }
        usleep(100_000) // let the server accept it

        try sendRaw("{\"type\":\"bye\"}\n")
        wait(for: [exp], timeout: 5)
    }

    func testClientDisconnectingWithoutSendingDoesNotKillServer() throws {
        let exp = expectation(description: "空连接之后仍能服务")
        let server = try makeServer { msg in
            if case .bye = msg { exp.fulfill() }
        }
        defer { server.stop() }

        let silent = connectClient()
        usleep(150_000)
        close(silent) // EOF before any byte

        try sendRaw("{\"type\":\"bye\"}\n")
        wait(for: [exp], timeout: 5)
    }

    func testMalformedFrameDoesNotKillServer() throws {
        let exp = expectation(description: "坏帧之后的帧仍被处理")
        let server = try makeServer { msg in
            if case .bye = msg { exp.fulfill() }
        }
        defer { server.stop() }
        try sendRaw("{bad json\n{\"type\":\"bye\"}\n")
        wait(for: [exp], timeout: 5)
    }

    func testStopIsIdempotent() throws {
        let server = try makeServer { _ in }
        server.stop()
        XCTAssertNoThrow(server.stop())
    }

    func testStopBeforeStartIsSafe() {
        let server = SocketServer(socketPath: socketPath, onMessage: { _ in }, onError: { _ in })
        XCTAssertNoThrow(server.stop())
    }

    /// Overlong paths must fail loudly at start(), not silently truncate and bind
    /// somewhere nobody is listening.
    func testRejectsOverlongSocketPath() {
        let longPath = "/tmp/" + String(repeating: "x", count: 120) + "/island.sock"
        let server = SocketServer(socketPath: longPath, onMessage: { _ in }, onError: { _ in })
        XCTAssertThrowsError(try server.start()) { error in
            XCTAssertTrue(
                String(describing: error).contains("sun_path"),
                "错误信息应指出 sun_path 溢出，实际：\(error)"
            )
        }
    }

    func testReportsBindFailureForUnwritableDirectory() {
        let server = SocketServer(
            socketPath: "/nonexistent-dir-\(UUID().uuidString)/island.sock",
            onMessage: { _ in },
            onError: { _ in }
        )
        XCTAssertThrowsError(try server.start())
    }
}
