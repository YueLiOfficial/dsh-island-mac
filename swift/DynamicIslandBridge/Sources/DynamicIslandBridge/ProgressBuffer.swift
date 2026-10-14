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
    @Published public private(set) var isVisible = false
    @Published public private(set) var phase: Phase = .idle

    public init() {}

    public func apply(_ message: InboundMessage) {
        switch message {
        case .hello:
            // Handshake only. Making the island visible here would flash the
            // pill on every plugin reconnect, before any work has happened.
            break

        case let .progress(percent, mode, message):
            self.percent = min(1, max(0, percent))
            self.mode = mode
            // Only overwrite when the sender supplied one: a progress update
            // without a message must not blank the status line mid-turn.
            if let message { self.message = message }
            self.isVisible = true
            self.phase = .running

        case let .done(reason, ok):
            self.phase = .done(ok: ok)
            // An abnormal end must not be rendered as completion. 100% is only
            // ever claimed for a turn that actually completed.
            if ok { self.percent = 1 }
            // The reason is more useful than the stale status line: it is the
            // only place the failure cause reaches the user.
            self.message = reason
            // `isVisible` stays true. The linger-then-hide timing belongs to
            // NotchController, which owns the animation.

        case .bye:
            self.isVisible = false
            self.phase = .idle
            self.percent = 0
            self.message = nil
        }
    }
}
