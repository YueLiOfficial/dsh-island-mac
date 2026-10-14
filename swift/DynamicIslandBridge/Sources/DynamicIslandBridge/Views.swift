import SwiftUI

/// Resting state: a percentage pill beside the physical notch.
///
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

    private var isFailed: Bool {
        buffer.phase == .done(ok: false)
    }

    private var tint: Color {
        isFailed ? .orange : .white
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
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .foregroundStyle(.white)
        .frame(width: 260)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
