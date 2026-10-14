import SwiftUI

/// Which chrome DynamicNotchKit will draw around the content.
///
/// The library picks between its notch view (drawn on black) and its
/// floating/"notchless" view (a `.popover` material) from the *screen*, at window
/// construction time. Content cannot read that from the environment — the
/// library's `EnvironmentValues.notchStyle` is internal — so the controller
/// publishes it here and updates it whenever the screen set changes.
///
/// Without this, a single hardcoded `.white` is invisible for exactly the users
/// who only ever get the floating panel: a notchless Mac in light mode.
@MainActor
public final class NotchAppearance: ObservableObject {
    /// True when the floating (`NotchlessView`) panel will be used.
    @Published public var usesFloatingStyle: Bool

    public init(usesFloatingStyle: Bool) {
        self.usesFloatingStyle = usesFloatingStyle
    }
}

/// Foreground colours for the detail panel.
///
/// Pure so the legibility rule is assertable without rendering; the library's own
/// convention is `notchStyle.isNotch ? .white : .primary`.
enum DetailPalette {
    static func foreground(usesFloatingStyle: Bool) -> Color {
        usesFloatingStyle ? .primary : .white
    }

    static func secondaryForeground(usesFloatingStyle: Bool) -> Color {
        usesFloatingStyle ? .secondary : .white.opacity(0.6)
    }

    static func tint(usesFloatingStyle: Bool, failed: Bool) -> Color {
        if failed { return .orange }
        return foreground(usesFloatingStyle: usesFloatingStyle)
    }
}

/// Resting state: a percentage pill beside the physical notch.
///
/// Only ever rendered by the library's *notch* view (`NotchlessView` draws the
/// expanded content alone), so its foreground is unconditionally white on black.
/// The library lays `compactLeading` out to the left of the notch and
/// `compactTrailing` to its right, separated by a spacer exactly as wide as the
/// notch. Keeping everything in `compactTrailing` guarantees it is never covered
/// by the black cutout.
struct ProgressPill: View {
    @ObservedObject var buffer: ProgressBuffer

    private var isFailed: Bool {
        buffer.phase == .done(ok: false)
    }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: isFailed ? "exclamationmark.triangle.fill" : "hourglass")
                .font(.system(size: 10, weight: .semibold))
            Text("\(Int((buffer.percent * 100).rounded()))%")
                // The vertical budget is tight: content is framed to
                // `notchSize.height` (== safeAreaInsets.top, 32pt on the machine
                // this was built for), of which 4pt top + 8pt bottom are already
                // consumed by the library's safe-area insets. Roughly 20pt is
                // left, so anything past ~13pt gets clipped by the NotchShape mask.
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .monospacedDigit()
        }
        .foregroundStyle(.white)
        // The library only insets the *outer* (trailing) edge of compactTrailing;
        // the side facing the notch has no inset (the HStack spacing is 0), so the
        // percentage would otherwise sit flush against the cutout's right edge.
        .padding(.leading, 8)
        .padding(.trailing, 6)
    }
}

/// Expanded state: progress bar, percentage, and the status line.
struct ProgressDetail: View {
    @ObservedObject var buffer: ProgressBuffer
    @ObservedObject var appearance: NotchAppearance

    private var isFailed: Bool {
        buffer.phase == .done(ok: false)
    }

    private var usesFloatingStyle: Bool {
        appearance.usesFloatingStyle
    }

    private var tint: Color {
        DetailPalette.tint(usesFloatingStyle: usesFloatingStyle, failed: isFailed)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(isFailed ? "任务未正常结束" : "任务进度")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Text("\(Int((buffer.percent * 100).rounded()))%")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .monospacedDigit()
            }

            ProgressView(value: min(1, max(0, buffer.percent)))
                .progressViewStyle(.linear)
                .tint(tint)

            if let message = buffer.message, !message.isEmpty {
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(DetailPalette.secondaryForeground(usesFloatingStyle: usesFloatingStyle))
                    .lineLimit(2)
            }
        }
        .foregroundStyle(DetailPalette.foreground(usesFloatingStyle: usesFloatingStyle))
        .frame(width: 260)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
