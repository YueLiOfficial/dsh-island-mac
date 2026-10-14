import XCTest
@testable import DynamicIslandBridge

/// `NotchPresenter` is the pure decision layer behind `NotchController`.
///
/// It exists because the plan itself flags the hide/linger race as "最容易漏且症状隐蔽" —
/// and a race that only manifests as a pill that flashes and disappears is not
/// something a code read can reliably verify. Pulling the ordering rules out of
/// the window code makes them assertable.
@MainActor
final class NotchPresenterTests: XCTestCase {

    private func makePresenter(hasNotch: Bool) -> NotchPresenter {
        NotchPresenter(hasNotch: hasNotch)
    }

    func testBecomingVisibleCompactsOnNotchedScreen() {
        var presenter = makePresenter(hasNotch: true)
        XCTAssertEqual(presenter.visibilityChanged(to: true), [.compact])
        XCTAssertTrue(presenter.isVisible)
    }

    /// Review Focus #3: in the floating style `compact()` hides the window
    /// outright, so a notchless screen must be expanded instead.
    func testBecomingVisibleExpandsOnNotchlessScreen() {
        var presenter = makePresenter(hasNotch: false)
        XCTAssertEqual(
            presenter.visibilityChanged(to: true),
            [.expand],
            "floating 样式下 compact 等于隐藏窗口"
        )
    }

    func testBecomingInvisibleHides() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        XCTAssertEqual(presenter.visibilityChanged(to: false), [.hide])
        XCTAssertFalse(presenter.isVisible)
    }

    func testDuplicateVisibilityEmitsNothing() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        XCTAssertEqual(presenter.visibilityChanged(to: true), [])
        _ = presenter.visibilityChanged(to: false)
        XCTAssertEqual(presenter.visibilityChanged(to: false), [])
    }

    func testHoverExpands() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        XCTAssertEqual(presenter.hoverChanged(to: true), [.expand])
    }

    func testHoverExitCompactsOnNotchedScreen() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.hoverChanged(to: true)
        XCTAssertEqual(presenter.hoverChanged(to: false), [.compact])
    }

    /// Review Focus #3, second half: the library does not expand on hover by
    /// itself, so the controller must — but the exit must not compact on a
    /// floating screen, because that would hide the window under the cursor.
    func testHoverExitIsIgnoredOnNotchlessScreen() {
        var presenter = makePresenter(hasNotch: false)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.hoverChanged(to: true)
        XCTAssertEqual(presenter.hoverChanged(to: false), [])
    }

    func testHoverWhileHiddenIsIgnored() {
        var presenter = makePresenter(hasNotch: true)
        XCTAssertEqual(presenter.hoverChanged(to: true), [])
    }

    func testDoneSchedulesLingerExactlyOnce() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        XCTAssertEqual(presenter.phaseChanged(to: .done(ok: true)), [.scheduleLingerHide])
        XCTAssertEqual(presenter.phaseChanged(to: .done(ok: true)), [])
    }

    func testLingerElapsedHidesAndResets() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.phaseChanged(to: .done(ok: true))
        XCTAssertEqual(presenter.lingerElapsed(), [.retractBuffer, .hide])
        XCTAssertFalse(presenter.isVisible)
        XCTAssertFalse(presenter.isLingerPending)
    }

    func testLingerElapsedWithoutPendingLingerIsNoOp() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        XCTAssertEqual(presenter.lingerElapsed(), [])
        XCTAssertTrue(presenter.isVisible)
    }

    /// The race the plan calls out: a new turn starts inside the linger window.
    ///
    /// Note the path: `ProgressBuffer` keeps `isVisible == true` through `done`,
    /// so the new turn shows up as a *phase* change, not a visibility change. If
    /// this did not cancel, the previous turn's queued hide would land right
    /// after the new pill appears.
    func testNewTurnInsideLingerWindowCancelsThePendingHide() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.phaseChanged(to: .done(ok: true))

        XCTAssertEqual(presenter.phaseChanged(to: .running), [.cancelLingerHide])

        // Even if the timer had already fired and queued its work, it must be inert.
        XCTAssertEqual(presenter.lingerElapsed(), [])
        XCTAssertTrue(presenter.isVisible, "新任务的药丸不能被上一轮的 hide 吃掉")
    }

    func testBecomingVisibleWithAPendingHideCancelsItBeforePresenting() {
        var presenter = NotchPresenter(
            hasNotch: true,
            isVisible: false,
            isHovering: false,
            isLingerPending: true
        )
        XCTAssertEqual(
            presenter.visibilityChanged(to: true),
            [.cancelLingerHide, .compact],
            "必须先取消上一轮计时，再展示本轮"
        )
    }

    func testIdlePhaseAlsoCancelsAPendingHide() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.phaseChanged(to: .done(ok: true))
        XCTAssertEqual(presenter.phaseChanged(to: .idle), [.cancelLingerHide])
    }

    func testBecomingInvisibleResetsHoverState() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.hoverChanged(to: true)
        _ = presenter.visibilityChanged(to: false)
        // A stale "hovering" flag would make the next turn think the cursor is
        // already on a pill that has not been drawn yet.
        XCTAssertFalse(presenter.isHovering)
    }

    // MARK: 空闲超时

    func testIdleElapsedHidesAndResetsWhileRunning() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        XCTAssertEqual(presenter.idleElapsed(), [.retractBuffer, .hide])
        XCTAssertFalse(presenter.isVisible)
    }

    func testIdleElapsedIsNoOpWhenNothingIsShowing() {
        var presenter = makePresenter(hasNotch: true)
        XCTAssertEqual(presenter.idleElapsed(), [])
    }

    /// The linger timer already owns the hide. A second `hide()` racing it would
    /// ask the library to do the same thing twice.
    func testIdleElapsedDefersToAPendingLingerHide() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.phaseChanged(to: .done(ok: true))
        XCTAssertEqual(presenter.idleElapsed(), [])
        XCTAssertTrue(presenter.isLingerPending, "linger 仍然有效")
    }

    // MARK: 收起的顺序

    /// Retract must come **before** hide.
    ///
    /// `hide()` awaits a ~0.4s animation, during which the main actor is free to
    /// process a new turn's `progress`. `ProgressBuffer` keeps `isVisible == true`
    /// through `done`, so if the retract were queued behind the hide, that new
    /// turn would produce no visibility transition at all: the island would stay
    /// hidden until the new turn's *next* progress frame, and nothing would log an
    /// error. Retracting first clears the buffer's visibility, so the new turn
    /// does emit a false→true transition and is shown as soon as the hide ends.
    func testCollapseRetractsTheBufferBeforeHiding() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.phaseChanged(to: .done(ok: true))
        XCTAssertEqual(presenter.lingerElapsed(), [.retractBuffer, .hide])
        XCTAssertFalse(presenter.isVisible)
    }

    func testIdleCollapseAlsoRetractsBeforeHiding() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        XCTAssertEqual(presenter.idleElapsed(), [.retractBuffer, .hide])
    }

    func testANewTurnAfterACollapseShowsAgain() {
        var presenter = makePresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.phaseChanged(to: .done(ok: true))
        _ = presenter.lingerElapsed()
        XCTAssertEqual(
            presenter.visibilityChanged(to: true),
            [.compact],
            "收起之后的新一轮必须能重新出现"
        )
    }

    // MARK: 屏幕能力（合盖 / 换显示器）

    /// `hasNotch` must not be sampled once at init. Closing the lid and moving to
    /// a notchless display would otherwise leave every presentation using
    /// `compact()`, which on a floating screen *hides* the window — and hover
    /// cannot rescue it, because the library's `updateHoverState` bails while the
    /// notch is hidden.
    func testScreenCapabilityChangeRepresentsAVisibleIsland() {
        var presenter = NotchPresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        XCTAssertEqual(
            presenter.screenCapabilityChanged(to: false),
            [.expand],
            "无刘海屏上 compact 等于隐藏窗口"
        )
        XCTAssertFalse(presenter.hasNotch)
    }

    func testScreenCapabilityChangeIsInertWhenNothingIsShown() {
        var presenter = NotchPresenter(hasNotch: true)
        XCTAssertEqual(presenter.screenCapabilityChanged(to: false), [])
        XCTAssertFalse(presenter.hasNotch, "能力值仍然要更新，供下一轮使用")
    }

    func testScreenCapabilityChangeWithNoActualChangeIsInert() {
        var presenter = NotchPresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        XCTAssertEqual(presenter.screenCapabilityChanged(to: true), [])
    }

    func testScreenCapabilityIsReReadForEachDecision() {
        var presenter = NotchPresenter(hasNotch: true)
        _ = presenter.visibilityChanged(to: true)
        _ = presenter.visibilityChanged(to: false)
        presenter.hasNotch = false
        XCTAssertEqual(
            presenter.visibilityChanged(to: true),
            [.expand],
            "缓存住的 hasNotch 会让岛在换屏后再也不出现"
        )
    }
}
