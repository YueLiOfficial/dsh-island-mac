import AppKit
import XCTest
@testable import DynamicIslandBridge

/// The pill shows the DeepSeek whale to the left of the notch.
///
/// These tests exist because "the icon does not appear" has several causes that
/// all look identical on screen — a blank pill — while needing different fixes:
///
/// 1. The mark was shipped as a sidecar SwiftPM resource bundle, so a copied or
///    packaged executable traps at first render with `unable to find bundle
///    named DynamicIslandBridge_DynamicIslandBridge`. The end-to-end check caught
///    this by crashing the helper the moment progress arrived.
/// 2. The silhouette was exported with the threshold the wrong way round, so it
///    is entirely transparent.
///
/// A test that only asserted "the view exists" would pass in both cases.
final class WhaleMarkTests: XCTestCase {

    /// The helper is distributed as one executable file, so the mark has to live
    /// inside it. This is the assertion that fails when the mark depends on a
    /// sidecar bundle.
    func testMarkIsEmbeddedInTheBinaryRatherThanLoadedFromABundle() {
        XCTAssertFalse(WhaleMarkData.pngBase64.isEmpty, "图标必须以字节内嵌，不能依赖外部 .bundle")
        let data = Data(base64Encoded: WhaleMarkData.pngBase64, options: .ignoreUnknownCharacters)
        XCTAssertNotNil(data, "内嵌的 base64 解不开")
        guard let data else { return }
        XCTAssertNotNil(NSImage(data: data), "内嵌数据不是一张能解码的 PNG")
    }

    func testMarkDecodesToAUsableImage() {
        guard let image = WhaleMarkAsset.image() else {
            return XCTFail("WhaleMarkAsset.image() 返回 nil —— 内嵌数据或解码路径有问题")
        }
        XCTAssertGreaterThan(image.size.height, 8, "图标太小，多半是导出尺寸写错了")
    }

    /// The whale is wider than it is tall. A transposed export would still be a
    /// valid image, so the shape has to be pinned.
    func testAspectRatioMatchesTheWhale() {
        guard let image = WhaleMarkAsset.image() else { return XCTFail("资源缺失") }
        let ratio = image.size.width / image.size.height
        XCTAssertGreaterThan(ratio, 1.0, "鲸鱼应该比高宽；宽高比 \(ratio) 说明图像被转置或裁剪错了")
        XCTAssertLessThan(ratio, 3.0, "宽高比 \(ratio) 太扁，裁剪框多半没贴合鲸鱼")
    }

    /// Catches an inverted luminance threshold: the background would be kept and
    /// the whale dropped, producing a fully transparent or fully opaque mask.
    func testSilhouetteActuallyHasOpaquePixelsAndTransparentCorners() {
        guard let image = WhaleMarkAsset.image(),
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff)
        else { return XCTFail("资源缺失或无法解码") }

        let stepX = max(1, bitmap.pixelsWide / 48)
        let stepY = max(1, bitmap.pixelsHigh / 48)
        var opaque = 0
        var transparent = 0

        for x in stride(from: 0, to: bitmap.pixelsWide, by: stepX) {
            for y in stride(from: 0, to: bitmap.pixelsHigh, by: stepY) {
                let alpha = bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0
                if alpha > 0.5 { opaque += 1 } else if alpha < 0.1 { transparent += 1 }
            }
        }

        XCTAssertGreaterThan(opaque, 20, "剪影几乎没有不透明像素 —— 阈值方向搞反了")
        XCTAssertGreaterThan(transparent, 20, "背景没有被抠透明 —— 图标会带一块白底")
    }

    /// The whale and its eye are two connected regions: the eye must stay a hole,
    /// otherwise the mark reads as a blob rather than the DeepSeek logo.
    func testEyeRemainsATransparentHole() {
        guard let image = WhaleMarkAsset.image(),
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff)
        else { return XCTFail("资源缺失或无法解码") }

        // The eye sits slightly right of and below the mark's centre.
        let centreX = bitmap.pixelsWide / 2
        let centreY = bitmap.pixelsHigh / 2
        var foundHole = false

        for x in centreX..<min(bitmap.pixelsWide, centreX + bitmap.pixelsWide / 4) {
            for y in centreY..<min(bitmap.pixelsHigh, centreY + bitmap.pixelsHigh / 4) {
                if (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 1) < 0.2 {
                    // A transparent pixel fully surrounded by opaque ones is the eye.
                    let left = bitmap.colorAt(x: max(0, x - 3), y: y)?.alphaComponent ?? 0
                    let right = bitmap.colorAt(x: min(bitmap.pixelsWide - 1, x + 3), y: y)?.alphaComponent ?? 0
                    if left > 0.7, right > 0.7 { foundHole = true }
                }
            }
        }
        XCTAssertTrue(foundHole, "眼睛被填实了 —— 阈值太低，剪影丢了内部细节")
    }
}
