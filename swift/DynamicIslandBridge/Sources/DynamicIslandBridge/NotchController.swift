import AppKit
import Combine
import DynamicNotchKit
import Foundation
import SwiftUI

/// Drives the DynamicNotch window from progress-buffer changes.
///
/// The decision rules live in `NotchPresenter` (pure, unit tested). This type is
/// the effect layer: it subscribes, serializes the library's async transitions,
/// and owns the timers.
///
/// Three library behaviors shape the implementation; all three were read out of
/// DynamicNotchKit 1.1.0 source rather than assumed:
///
/// - `hoverBehavior` must NOT contain `.keepVisible`. `_hide()` retries every
///   0.1s while the cursor is over the notch, so a task ending with the cursor in
///   place would never collapse. `.all` includes it, so `.all` is also out.
/// - `expand()`/`compact()` each sleep ~0.4s for their animation and are not
///   reentrant-safe against each other. Every call is funneled through one
///   serial consumer so two transitions can never interleave.
/// - Hover does not expand anything by itself; `isHovering` only changes the
///   capsule height. The controller subscribes and expands on its own.
@MainActor
public final class NotchController {
    /// How long a finished turn stays on screen before collapsing.
    public static let defaultLingerMilliseconds: UInt64 = 1_200

    /// Hover transitions are debounced: the library's compact↔expanded
    /// conversion runs in a detached `Task` guarded by `state == .hidden`, so a
    /// fast enter/leave flicker makes two conversions fight and the guard bail.
    public static let hoverDebounceMilliseconds: UInt64 = 200

    private let buffer: ProgressBuffer
    private let appearance: NotchAppearance
    private let lingerNanoseconds: UInt64
    private let idleNanoseconds: UInt64

    private var presenter: NotchPresenter
    private var notch: DynamicNotch<ProgressDetail, EmptyView, ProgressPill>?

    private var observationCancellables = Set<AnyCancellable>()
    private var effectContinuation: AsyncStream<NotchEffect>.Continuation?
    private var effectTask: Task<Void, Never>?
    private var lingerTask: Task<Void, Never>?
    private var hoverDebounceTask: Task<Void, Never>?
    private var idleTask: Task<Void, Never>?

    public init(
        buffer: ProgressBuffer,
        lingerMilliseconds: UInt64 = NotchController.defaultLingerMilliseconds,
        idleTimeoutMilliseconds: UInt64 = BridgeOptions.defaultIdleTimeoutMilliseconds
    ) {
        self.buffer = buffer
        self.lingerNanoseconds = lingerMilliseconds * 1_000_000
        self.idleNanoseconds = idleTimeoutMilliseconds * 1_000_000
        let hasNotch = Self.screenHasNotch()
        self.presenter = NotchPresenter(hasNotch: hasNotch)
        self.appearance = NotchAppearance(usesFloatingStyle: !hasNotch)
    }

    /// Whether the primary screen has a physical notch.
    ///
    /// DynamicNotchKit has an equivalent `NSScreen.hasNotch`, but it is `internal`
    /// to that module and therefore invisible here. This mirrors its
    /// implementation: both auxiliary top areas exist only when there is a notch.
    public static func screenHasNotch(_ screen: NSScreen? = NSScreen.screens.first) -> Bool {
        guard let screen else { return false }
        return screen.auxiliaryTopLeftArea?.width != nil
            && screen.auxiliaryTopRightArea?.width != nil
    }

    // MARK: - Lifecycle

    public func start() {
        guard notch == nil else { return }

        // Captured as locals: `DynamicNotch.init` is not main-actor isolated, so
        // the view-builder closures must not reach back into `self`.
        let buffer = self.buffer
        let appearance = self.appearance

        let notch = DynamicNotch<ProgressDetail, EmptyView, ProgressPill>(
            // Not `.keepVisible` and not `.all` — see the type doc.
            hoverBehavior: [.increaseShadow],
            style: .auto,
            expanded: { ProgressDetail(buffer: buffer, appearance: appearance) },
            compactLeading: { EmptyView() },
            compactTrailing: { ProgressPill(buffer: buffer) }
        )
        self.notch = notch

        let (effects, continuation) = AsyncStream<NotchEffect>.makeStream()
        effectContinuation = continuation
        effectTask = Task { @MainActor [weak self] in
            for await effect in effects {
                guard let self else { return }
                await self.perform(effect)
            }
        }

        // `Published` emits on whatever actor mutates it, and `ProgressBuffer` is
        // main-actor isolated, so these callbacks are already on the main actor.
        // `assumeIsolated` states that and keeps the ordering synchronous — a
        // `Task { @MainActor }` hop would not guarantee that a visibility change
        // lands before the phase change that follows it.
        buffer.$isVisible
            .removeDuplicates()
            .sink { [weak self] visible in
                MainActor.assumeIsolated { self?.handleVisibility(visible) }
            }
            .store(in: &observationCancellables)

        buffer.$phase
            .removeDuplicates()
            .sink { [weak self] phase in
                MainActor.assumeIsolated { self?.handlePhase(phase) }
            }
            .store(in: &observationCancellables)

        notch.$isHovering
            .removeDuplicates()
            .sink { [weak self] hovering in
                MainActor.assumeIsolated { self?.handleHover(hovering) }
            }
            .store(in: &observationCancellables)

        // Restart the idle watchdog on every message that means work is
        // happening. `dropFirst` skips the subscription replay of the current
        // value, so a fresh controller does not arm a timer before anything has
        // been shown.
        buffer.$activityTick
            .dropFirst()
            .sink { [weak self] _ in
                MainActor.assumeIsolated { self?.restartIdleTimer() }
            }
            .store(in: &observationCancellables)

        // Attaching or removing a display changes whether the library can render
        // the compact pill at all — on a floating screen `compact()` hides the
        // window, and hover cannot rescue it because the library's hover handler
        // bails while the notch is hidden. Re-evaluate instead of trusting the
        // capability sampled at startup.
        NotificationCenter.default.publisher(
            for: NSApplication.didChangeScreenParametersNotification
        )
        .sink { [weak self] _ in
            MainActor.assumeIsolated { self?.handleScreenParametersChanged() }
        }
        .store(in: &observationCancellables)
    }

    /// Cancels every subscription and timer and asks the window to hide.
    /// Deliberately does not wait for the hide animation.
    public func stop() {
        observationCancellables.removeAll()

        hoverDebounceTask?.cancel()
        hoverDebounceTask = nil
        lingerTask?.cancel()
        lingerTask = nil
        idleTask?.cancel()
        idleTask = nil

        effectContinuation?.finish()
        effectContinuation = nil
        effectTask?.cancel()
        effectTask = nil

        if let notch {
            self.notch = nil
            Task { await notch.hide() }
        }
    }

    // MARK: - Input handling

    private func handleVisibility(_ visible: Bool) {
        refreshScreenCapability()
        enqueue(presenter.visibilityChanged(to: visible))
    }

    /// Re-reads the screen capability and re-presents if it changed.
    ///
    /// Polling the value before every decision is cheaper than trusting a
    /// notification that may not fire for the transition that matters.
    private func refreshScreenCapability() {
        presenter.hasNotch = Self.screenHasNotch()
        appearance.usesFloatingStyle = !presenter.hasNotch
    }

    private func handleScreenParametersChanged() {
        let hasNotch = Self.screenHasNotch()
        appearance.usesFloatingStyle = !hasNotch
        enqueue(presenter.screenCapabilityChanged(to: hasNotch))
    }

    private func handlePhase(_ phase: ProgressBuffer.Phase) {
        enqueue(presenter.phaseChanged(to: phase))
    }

    private func handleHover(_ hovering: Bool) {
        // Debounced, then decided: a flicker cancels the earlier decision instead
        // of queueing two contradictory ones.
        hoverDebounceTask?.cancel()
        hoverDebounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.hoverDebounceMilliseconds * 1_000_000)
            guard !Task.isCancelled, let self else { return }
            self.enqueue(self.presenter.hoverChanged(to: hovering))
        }
    }

    private func enqueue(_ effects: [NotchEffect]) {
        for effect in effects {
            effectContinuation?.yield(effect)
        }
    }

    // MARK: - Effect execution (single serial consumer)

    /// Runs strictly one effect at a time. `expand()`/`compact()`/`hide()` each
    /// await an animation, so overlapping calls are exactly what the library
    /// cannot handle.
    private func perform(_ effect: NotchEffect) async {
        switch effect {
        case .hide:
            await notch?.hide()

        case .compact:
            // The presenter never emits this on a screen without a notch, where
            // the library's compact() hides the window instead.
            await notch?.compact()

        case .expand:
            await notch?.expand()

        case .scheduleLingerHide:
            scheduleLingerHide()

        case .cancelLingerHide:
            lingerTask?.cancel()
            lingerTask = nil

        case .retractBuffer:
            // Before `.hide`, never after: `hide()` awaits ~0.4s during which a new
            // turn's progress can land, and clearing visibility first is what lets
            // that new turn re-show the island instead of being swallowed.
            buffer.retract()
        }
    }

    private func scheduleLingerHide() {
        lingerTask?.cancel()
        lingerTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: self.lingerNanoseconds)
            // `try?` swallows CancellationError, so check explicitly.
            guard !Task.isCancelled else { return }
            self.enqueue(self.presenter.lingerElapsed())
        }
    }

    /// Arms the "nothing has arrived for a long time" watchdog.
    ///
    /// Covers the plugin dying without a `bye`: a half-open socket never produces
    /// EOF, so the island would otherwise sit at the last percentage forever.
    private func restartIdleTimer() {
        idleTask?.cancel()
        idleTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: self.idleNanoseconds)
            guard !Task.isCancelled else { return }
            self.enqueue(self.presenter.idleElapsed())
        }
    }
}
