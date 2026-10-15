import Combine
import Foundation

/// Observable mirror of the progress reported over the socket.
///
/// Why this exists at all: `DynamicNotchInfo` fixes its text in `init` via
/// `LocalizedStringKey`, so it cannot show a live percentage. Rendering a live
/// value requires `DynamicNotch` plus an `ObservableObject` the SwiftUI content
/// views can observe.
///
/// `@MainActor` because two threads meet here: SwiftUI reads these properties on
/// the main thread, and `SocketServer` hands messages over from its own serial
/// queue. Annotating the type is what makes that crossing safe rather than
/// merely unlikely to break.
///
/// This type only mirrors; it does not police ordering. Monotonicity and the
/// "estimates never claim 100%" rule are enforced in the plugin's state machine
/// (`src/progress.ts`) before anything reaches the wire.
@MainActor
public final class ProgressBuffer: ObservableObject {
    /// Where the current turn is. `done` is terminal until `bye` or a new turn.
    public enum Phase: Equatable {
        case idle
        case running
        case done(ok: Bool)
    }

    /// 0...1, always clamped on the way in.
    @Published public private(set) var percent: Double = 0
    @Published public private(set) var mode: ProgressMode = .estimated
    @Published public private(set) var message: String?
    /// Short description of the work in progress, for the hover panel.
    ///
    /// Kept separate from `message` so the two can be shown on different lines:
    /// `message` is a status line a terminal signal supplied, this is derived
    /// continuously from the event stream.
    @Published public private(set) var currentTask: String?
    @Published public private(set) var isVisible = false
    @Published public private(set) var phase: Phase = .idle

    /// Bumped on every message that means "work is happening" (`progress`,
    /// `done`). The idle watchdog restarts on each tick. `hello` and `bye` do not
    /// count: they would keep an invisible island's timer alive forever.
    ///
    /// A counter rather than a `PassthroughSubject` because a `@MainActor` class
    /// is `Sendable` and therefore may not store a non-`Sendable` subject.
    @Published public private(set) var activityTick: UInt64 = 0

    public init() {}

    public func apply(_ message: InboundMessage) {
        switch message {
        case .hello:
            // Handshake only. Making the island visible here would flash the
            // pill on every plugin reconnect, before any work has happened.
            break

        case let .progress(percent, mode, message, task):
            self.percent = min(1, max(0, percent))
            self.mode = mode
            // Only overwrite when the sender supplied one: a progress update
            // without a message must not blank the status line mid-turn.
            if let message { self.message = message }
            // Absent is the common case (most frames carry no new label), and a
            // frame without one must not blank the line that is already showing.
            if let task { self.currentTask = task }
            self.isVisible = true
            self.phase = .running
            self.activityTick &+= 1

        case let .done(reason, ok):
            self.phase = .done(ok: ok)
            // An abnormal end must not be rendered as completion. 100% is only
            // ever claimed for a turn that actually completed.
            if ok { self.percent = 1 }
            // The reason is more useful than the stale status line: it is the
            // only place the failure cause reaches the user.
            self.message = reason
            self.activityTick &+= 1
            // `isVisible` stays true. The linger-then-hide timing belongs to
            // NotchController, which owns the animation.

        case .bye:
            self.isVisible = false
            self.phase = .idle
            self.percent = 0
            self.message = nil
            // The task label belongs to the turn that just ended; leaving it
            // would show stale work on the next turn's first hover.
            self.currentTask = nil
        }
    }

    /// Stop showing the island, keeping the last reading.
    ///
    /// This is the *local* collapse (linger and idle timeouts), and it is
    /// deliberately not `apply(.bye)`. It runs before `hide()` awaits its ~0.4s
    /// animation, so clearing the percentage here would make the pill flash "0%"
    /// on its way out. It also makes the next turn's first `progress` a genuine
    /// false→true visibility transition, which is the event that re-shows the
    /// island — `apply(.bye)` would be equivalent, but only at the cost of that
    /// flash.
    ///
    /// Not counted as activity: a collapse must not keep the idle watchdog alive.
    public func retract() {
        isVisible = false
        phase = .idle
    }
}
