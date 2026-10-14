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

    /// The idle watchdog keys off this counter. It must tick for anything that
    /// means "work is happening" and stay put for handshake/retraction, which
    /// would otherwise keep an invisible island's timer alive forever.
    func testActivityTickCountsProgressAndDoneOnly() {
        let buffer = ProgressBuffer()
        XCTAssertEqual(buffer.activityTick, 0)

        buffer.apply(.hello(version: 1))
        XCTAssertEqual(buffer.activityTick, 0, "握手不算活动")

        buffer.apply(.progress(percent: 0.2, mode: .estimated, message: nil))
        XCTAssertEqual(buffer.activityTick, 1)

        buffer.apply(.progress(percent: 0.2, mode: .estimated, message: nil))
        XCTAssertEqual(buffer.activityTick, 2, "即使 percent 相同也要计数")

        buffer.apply(.done(reason: "completed", ok: true))
        XCTAssertEqual(buffer.activityTick, 3)

        buffer.apply(.bye)
        XCTAssertEqual(buffer.activityTick, 3, "bye 不算活动")
    }

    /// `retract` is the collapse path, and it runs *before* the ~0.4s hide
    /// animation. Zeroing the percentage there would make the pill flash "0%" on
    /// its way out — the last thing the user should see is the completed number.
    func testRetractHidesWithoutZeroingThePercentage() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.75, mode: .precise, message: "收尾中"))
        buffer.retract()

        XCTAssertFalse(buffer.isVisible)
        XCTAssertEqual(buffer.phase, .idle)
        XCTAssertEqual(buffer.percent, 0.75)
        XCTAssertEqual(buffer.message, "收尾中")
    }

    func testRetractDoesNotCountAsActivity() {
        let buffer = ProgressBuffer()
        buffer.retract()
        XCTAssertEqual(buffer.activityTick, 0)
        buffer.apply(.progress(percent: 0.1, mode: .estimated, message: nil))
        XCTAssertEqual(buffer.activityTick, 1)
    }

    /// After a retract, the next turn's first progress is a real false→true
    /// transition — that is the event the controller re-shows the island on.
    func testProgressAfterRetractBecomesVisibleAgain() {
        let buffer = ProgressBuffer()
        buffer.apply(.progress(percent: 0.9, mode: .precise, message: nil))
        buffer.retract()
        buffer.apply(.progress(percent: 0.05, mode: .estimated, message: "新一轮"))
        XCTAssertTrue(buffer.isVisible)
        XCTAssertEqual(buffer.phase, .running)
    }
}
