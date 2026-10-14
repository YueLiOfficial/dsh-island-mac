import Foundation

/// A side effect the notch controller should perform.
///
/// Kept as plain data so the ordering rules that produce these can be tested
/// without a window server, a display, or a run loop.
/// `Sendable` is spelled out rather than inferred: implicit conformance is only
/// granted to non-public types, and these values cross into an `AsyncStream`.
public enum NotchEffect: Equatable, Sendable {
    case hide
    case compact
    case expand
    /// Start the linger timer that hides the island after a terminal state.
    case scheduleLingerHide
    /// Cancel a running linger timer. Emitted when a new turn starts inside the
    /// linger window: without it the previous turn's queued `hide()` lands right
    /// after the new pill appears, and the island flashes and vanishes.
    case cancelLingerHide
    /// Stop showing the current reading.
    ///
    /// Runs **before** `hide` on every collapse path. `hide()` awaits a ~0.4s
    /// animation during which a new turn's `progress` can arrive; retracting
    /// first is what makes that new turn produce a real false→true visibility
    /// transition, so it is shown instead of being swallowed.
    case retractBuffer
}

/// Pure decision layer for notch presentation.
///
/// Everything here is a deterministic function of the inputs; the controller
/// only executes the effects. That split is what makes the two easy-to-miss
/// behaviors assertable:
///
/// 1. **The floating style cannot be compacted.** `DynamicNotch._compact()` calls
///    `hide()` outright when the effective style is `.floating`, so on a machine
///    without a notch both "show" and "hover exit" must avoid `compact`.
/// 2. **A new turn can begin inside the linger window.** `ProgressBuffer` keeps
///    `isVisible == true` through `done`, so the new turn arrives as a phase
///    change; that phase change is what cancels the pending hide.
public struct NotchPresenter {
    /// Whether the target screen has a physical notch. On such a screen the
    /// library supports the compact pill; without one it does not.
    /// Re-read from the current screen before each decision, never cached for the
    /// session: closing the lid and moving to a notchless display would otherwise
    /// leave every presentation asking for `compact()`, which on a floating screen
    /// *hides* the window and cannot be rescued by hover.
    public var hasNotch: Bool

    public private(set) var isVisible: Bool
    public private(set) var isHovering: Bool
    /// A linger timer has been scheduled and has not yet fired or been cancelled.
    public private(set) var isLingerPending: Bool

    public init(
        hasNotch: Bool,
        isVisible: Bool = false,
        isHovering: Bool = false,
        isLingerPending: Bool = false
    ) {
        self.hasNotch = hasNotch
        self.isVisible = isVisible
        self.isHovering = isHovering
        self.isLingerPending = isLingerPending
    }

    public mutating func visibilityChanged(to visible: Bool) -> [NotchEffect] {
        guard visible != isVisible else { return [] }
        isVisible = visible

        guard visible else {
            // A stale "hovering" flag would make the next turn behave as if the
            // cursor were already on a pill that has not been drawn yet.
            isHovering = false
            return [.hide]
        }

        var effects: [NotchEffect] = []
        if isLingerPending {
            // Cancel before presenting: the previous turn's hide must be dead
            // before the new pill is drawn.
            isLingerPending = false
            effects.append(.cancelLingerHide)
        }
        // The first presentation of a turn: compact where that is supported,
        // expand where compact would hide the window instead.
        effects.append(hasNotch ? .compact : .expand)
        return effects
    }

    public mutating func hoverChanged(to hovering: Bool) -> [NotchEffect] {
        guard hovering != isHovering else { return [] }
        // Hovering a hidden window is meaningless; the library filters these out
        // too (`updateHoverState` bails when `state == .hidden`).
        guard isVisible else { return [] }

        isHovering = hovering

        if hovering { return [.expand] }

        // Floating style: `compact()` hides the window, so ignore the exit and
        // stay expanded. This is the documented degradation, not an oversight.
        return hasNotch ? [.compact] : []
    }

    public mutating func phaseChanged(to phase: ProgressBuffer.Phase) -> [NotchEffect] {
        switch phase {
        case .done:
            guard !isLingerPending else { return [] }
            isLingerPending = true
            return [.scheduleLingerHide]

        case .idle, .running:
            guard isLingerPending else { return [] }
            isLingerPending = false
            return [.cancelLingerHide]
        }
    }

    /// The linger timer fired.
    public mutating func lingerElapsed() -> [NotchEffect] {
        // A timer that was cancelled but had already queued its work must be
        // inert. This is the second half of the race guard: even if cancellation
        // loses, nothing happens.
        guard isLingerPending else { return [] }
        isLingerPending = false
        isVisible = false
        isHovering = false
        return [.retractBuffer, .hide]
    }

    /// The idle watchdog fired: nothing has arrived for a long time.
    ///
    /// Covers the case where the plugin dies without a `bye` — a half-open socket
    /// never produces EOF, so without this the island would sit at the last
    /// percentage forever.
    public mutating func idleElapsed() -> [NotchEffect] {
        // A pending linger already owns the hide; a second `hide()` racing it
        // asks the library to do the same thing twice.
        guard isVisible, !isLingerPending else { return [] }
        isVisible = false
        isHovering = false
        return [.retractBuffer, .hide]
    }

    /// The set of available screens changed (lid closed, display attached or
    /// removed).
    ///
    /// Returns the effects needed to keep the current presentation valid on the
    /// new screen. A floating screen cannot be compacted — the library's
    /// `_compact()` calls `hide()` instead — so a visible island must be
    /// re-expressed as expanded.
    public mutating func screenCapabilityChanged(to hasNotch: Bool) -> [NotchEffect] {
        let changed = hasNotch != self.hasNotch
        self.hasNotch = hasNotch
        guard changed, isVisible else { return [] }
        return [hasNotch ? .compact : .expand]
    }
}
