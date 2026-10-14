import SwiftUI
import XCTest
@testable import DynamicIslandBridge

/// Colours are not renderable in a unit test, but the *decision* behind them is
/// pure — and it encodes a real legibility rule: DynamicNotchKit draws notch
/// content on black and floating content on a `.popover` material, so a single
/// hardcoded `.white` is invisible for exactly the users who only ever get the
/// floating panel. The library's own convention is
/// `notchStyle.isNotch ? .white : .primary`.
final class DetailPaletteTests: XCTestCase {

    func testFloatingStyleUsesPrimaryForeground() {
        XCTAssertEqual(DetailPalette.foreground(usesFloatingStyle: true), Color.primary)
    }

    func testNotchStyleUsesWhiteForeground() {
        XCTAssertEqual(DetailPalette.foreground(usesFloatingStyle: false), Color.white)
    }

    func testFloatingStyleDoesNotUseWhiteForeground() {
        XCTAssertNotEqual(
            DetailPalette.foreground(usesFloatingStyle: true),
            Color.white,
            "浅色模式下 .popover 材质上的白字看不见"
        )
    }

    func testUnfailedTintFollowsTheForeground() {
        XCTAssertEqual(DetailPalette.tint(usesFloatingStyle: false, failed: false), Color.white)
        XCTAssertEqual(DetailPalette.tint(usesFloatingStyle: true, failed: false), Color.primary)
    }

    func testFailedTintIsOrangeOnEveryStyle() {
        XCTAssertEqual(DetailPalette.tint(usesFloatingStyle: false, failed: true), Color.orange)
        XCTAssertEqual(DetailPalette.tint(usesFloatingStyle: true, failed: true), Color.orange)
    }

    func testSecondaryTextFollowsTheStyleToo() {
        XCTAssertEqual(DetailPalette.secondaryForeground(usesFloatingStyle: true), Color.secondary)
        XCTAssertEqual(
            DetailPalette.secondaryForeground(usesFloatingStyle: false),
            Color.white.opacity(0.6)
        )
    }
}
