import XCTest
@testable import DynamicIslandBridge

/// `ProgressBuffer` is `@MainActor` because SwiftUI reads it and the socket queue
/// writes it; the annotation is what makes that safe, so the tests adopt it too.
@MainActor
final class ProgressBufferTests: XCTestCase {

    func testStartsHiddenAndIdle() {
        let buffer = ProgressBuffer()
        XCTAssertFalse(buffer.isVisible)
        XCTAssertEqual(buffer.phase, .idle)
        XCTAssertEqual(buffer.percent, 0)
        XCTAssertNil(buffer.message)
    }

    func testProgressMakesVisibleAndRunning() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.42, mode: .precise, message: "一半"))
        XCTAssertTrue(buffer.isVisible)
        XCTAssertEqual(buffer.phase, .running)
        XCTAssertEqual(buffer.percent, 0.42, accuracy: 0.0001)
        XCTAssertEqual(buffer.message, "一半")
        XCTAssertEqual(buffer.mode, .precise)
    }

    func testPercentClampedOnApply() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 1e9, mode: .precise, message: nil))
        XCTAssertEqual(buffer.percent, 1.0)

        let other = ProgressBuffer()
        other.apply(.progress(percent: -3, mode: .precise, message: nil))
        XCTAssertEqual(other.percent, 0.0)
    }

    func testDoneOkSetsFullAndTerminal() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.5, mode: .estimated, message: nil))
        buffer.apply(.done(reason: "completed", ok: true))
        XCTAssertEqual(buffer.phase, .done(ok: true))
        XCTAssertEqual(buffer.percent, 1.0)
        XCTAssertTrue(buffer.isVisible, "停留收起由 NotchController 负责，buffer 不能先隐藏")
    }

    func testDoneNotOkDoesNotClaimFull() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.5, mode: .estimated, message: nil))
        buffer.apply(.done(reason: "aborted", ok: false))
        XCTAssertEqual(buffer.phase, .done(ok: false))
        XCTAssertLessThan(buffer.percent, 1.0, "异常结束不得显示 100%")
    }

    func testByeHidesAndResets() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.5, mode: .precise, message: "x"))
        buffer.apply(.bye)
        XCTAssertFalse(buffer.isVisible)
        XCTAssertEqual(buffer.phase, .idle)
        XCTAssertEqual(buffer.percent, 0)
        XCTAssertNil(buffer.message)
    }

    func testHelloDoesNotMakeVisible() {
        let buffer = ProgressBuffer()
        buffer.apply(.hello(version: 1))
        XCTAssertFalse(buffer.isVisible, "握手不应弹出灵动岛")
    }

    func testDoneReplacesMessageWithReason() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.5, mode: .precise, message: "旧消息"))
        buffer.apply(.done(reason: "aborted", ok: false))
        XCTAssertEqual(buffer.message, "aborted", "失败时应显示原因")
    }

    func testEmptyMessageDoesNotClearPrevious() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.3, mode: .precise, message: "进行中"))
        buffer.apply(.progress(percent: 0.6, mode: .precise, message: nil))
        XCTAssertEqual(buffer.message, "进行中", "缺省 message 不应清掉上一条")
    }

    /// A new turn can start inside the linger window, before `bye` arrives.
    func testProgressAfterDoneReturnsToRunning() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.5, mode: .precise, message: nil))
        buffer.apply(.done(reason: "completed", ok: true))
        buffer.apply(.progress(percent: 0.1, mode: .estimated, message: "新一轮"))
        XCTAssertEqual(buffer.phase, .running)
        XCTAssertTrue(buffer.isVisible)
        XCTAssertEqual(buffer.percent, 0.1, accuracy: 0.0001)
    }

    func testModeTracksLatestProgress() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.2, mode: .estimated, message: nil))
        XCTAssertEqual(buffer.mode, .estimated)
        buffer.apply(.progress(percent: 0.4, mode: .precise, message: nil))
        XCTAssertEqual(buffer.mode, .precise)
    }
}
