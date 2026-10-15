import Foundation
import XCTest
@testable import DynamicIslandBridge

final class ProtocolTests: XCTestCase {

    // MARK: 分帧

    func testHalfPacketIsBufferedNotParsed() {
        var buf = LineBuffer()
        XCTAssertEqual(buf.append("{\"type\":\"prog"), [])
    }

    func testHalfPacketCompletedByNextChunk() {
        var buf = LineBuffer()
        _ = buf.append("{\"type\":\"bye\"")
        XCTAssertEqual(buf.append("}\n"), ["{\"type\":\"bye\"}"])
    }

    func testMultipleFramesInOneChunk() {
        var buf = LineBuffer()
        let lines = buf.append("{\"type\":\"bye\"}\n{\"type\":\"bye\"}\n")
        XCTAssertEqual(lines.count, 2)
    }

    func testFrameSplitAcrossThreeChunks() {
        var buf = LineBuffer()
        XCTAssertEqual(buf.append("{\"ty"), [])
        XCTAssertEqual(buf.append("pe\":\"b"), [])
        XCTAssertEqual(buf.append("ye\"}\n"), ["{\"type\":\"bye\"}"])
    }

    func testEmptyLinesAreSkipped() {
        var buf = LineBuffer()
        XCTAssertEqual(buf.append("\n\n{\"type\":\"bye\"}\n").count, 1)
    }

    /// A frame ending without a trailing newline must stay buffered, not be
    /// flushed early and not be dropped.
    func testTrailingPartialFrameIsRetained() {
        var buf = LineBuffer()
        XCTAssertEqual(buf.append("{\"type\":\"bye\"}\n{\"type\":\"prog"), ["{\"type\":\"bye\"}"])
        XCTAssertEqual(buf.append("ress\"}\n"), ["{\"type\":\"progress\"}"])
    }

    /// The socket hands us bytes, not strings. A multi-byte UTF-8 scalar can be
    /// split across two reads; decoding each read independently would replace it
    /// with U+FFFD and corrupt the message with no error anywhere.
    func testMultibyteCharacterSplitAcrossByteChunks() {
        var buf = LineBuffer()
        let line = "{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"estimated\",\"message\":\"正在编译\"}"
        let bytes = Array(line.utf8)
        guard let firstNonASCII = bytes.firstIndex(where: { $0 > 0x7F }) else {
            return XCTFail("测试夹具里没有非 ASCII 字节")
        }
        let cut = firstNonASCII + 1 // 落在一个 CJK 标量内部

        XCTAssertEqual(buf.append(Data(bytes[0..<cut])), [])

        var tail = Data(bytes[cut...])
        tail.append(0x0A)
        let lines = buf.append(tail)

        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(
            decodeMessage(lines[0]),
            .progress(percent: 0.5, mode: .estimated, message: "正在编译", task: nil)
        )
    }

    /// A peer that never sends a newline would otherwise grow the buffer without
    /// bound. Overflow drops the garbage and resynchronizes on the next line.
    func testPendingBufferIsBounded() {
        var buf = LineBuffer()
        XCTAssertEqual(buf.append(Data(repeating: 0x41, count: LineBuffer.maxPendingBytes + 1)), [])
        XCTAssertEqual(buf.append("\n{\"type\":\"bye\"}\n"), ["{\"type\":\"bye\"}"])
    }

    // MARK: 解析

    func testDecodesProgress() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":0.42,\"mode\":\"precise\"}")
        guard case .progress(let p, let mode, _, _)? = m else { return XCTFail("未解析为 progress") }
        XCTAssertEqual(p, 0.42, accuracy: 0.0001)
        XCTAssertEqual(mode, .precise)
    }

    func testDecodesProgressWithNonASCIIText() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"estimated\",\"message\":\"正在编译 ①✓\"}")
        guard case .progress(_, _, let msg, _)? = m else { return XCTFail("未解析") }
        XCTAssertEqual(msg, "正在编译 ①✓")
    }

    func testDecodesProgressWithoutMessage() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":0.1,\"mode\":\"estimated\"}")
        guard case .progress(_, _, let msg, _)? = m else { return XCTFail("未解析") }
        XCTAssertNil(msg)
    }

    func testDecodesProgressTask() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"precise\",\"task\":\"运行测试\"}")
        guard case .progress(_, _, _, let task)? = m else { return XCTFail("未解析") }
        XCTAssertEqual(task, "运行测试")
    }

    /// The field is optional: frames without it are the common case.
    func testDecodesProgressWithoutTask() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"precise\"}")
        guard case .progress(_, _, _, let task)? = m else { return XCTFail("未解析") }
        XCTAssertNil(task)
    }

    func testMessageAndTaskDecodeIndependently() {
        let line = "{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"precise\","
            + "\"message\":\"状态行\",\"task\":\"任务标签\"}"
        guard case .progress(_, _, let msg, let task)? = decodeMessage(line) else {
            return XCTFail("未解析")
        }
        XCTAssertEqual(msg, "状态行")
        XCTAssertEqual(task, "任务标签")
    }

    /// A present-but-wrong-typed `task` is a protocol violation, matching how
    /// `message` is treated — not silently coerced or dropped.
    func testRejectsNonStringTask() {
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"precise\",\"task\":42}"))
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"precise\",\"task\":null}"))
    }

    func testClampsPercentAboveOne() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":1e9,\"mode\":\"precise\"}")
        guard case .progress(let p, _, _, _)? = m else { return XCTFail("未解析") }
        XCTAssertEqual(p, 1.0)
    }

    func testClampsNegativePercent() {
        let m = decodeMessage("{\"type\":\"progress\",\"percent\":-5,\"mode\":\"precise\"}")
        guard case .progress(let p, _, _, _)? = m else { return XCTFail("未解析") }
        XCTAssertEqual(p, 0.0)
    }

    func testRejectsNonFinitePercent() {
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"percent\":null,\"mode\":\"precise\"}"))
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"mode\":\"precise\"}"))
    }

    /// `true` bridges to `NSNumber` in Swift and would read as 1.0 — a silent
    /// "100%" out of a malformed frame. Reject instead of coercing.
    func testRejectsBooleanPercent() {
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"percent\":true,\"mode\":\"precise\"}"))
    }

    /// A JSON string is not a number, even when it looks like one.
    func testRejectsStringPercent() {
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"percent\":\"0.5\",\"mode\":\"precise\"}"))
    }

    func testRejectsUnknownMode() {
        XCTAssertNil(decodeMessage("{\"type\":\"progress\",\"percent\":0.5,\"mode\":\"nope\"}"))
    }

    func testRejectsMalformedJSON() {
        XCTAssertNil(decodeMessage("{bad json"))
        XCTAssertNil(decodeMessage(""))
        XCTAssertNil(decodeMessage("42"))
    }

    func testRejectsUnknownType() {
        XCTAssertNil(decodeMessage("{\"type\":\"future-thing\",\"percent\":0.5}"))
    }

    func testDecodesDone() {
        guard case .done(let reason, let ok)? = decodeMessage("{\"type\":\"done\",\"reason\":\"completed\",\"ok\":true}") else {
            return XCTFail("未解析为 done")
        }
        XCTAssertEqual(reason, "completed")
        XCTAssertTrue(ok)
    }

    func testDecodesDoneNotOk() {
        guard case .done(let reason, let ok)? = decodeMessage("{\"type\":\"done\",\"reason\":\"aborted\",\"ok\":false}") else {
            return XCTFail("未解析为 done")
        }
        XCTAssertEqual(reason, "aborted")
        XCTAssertFalse(ok)
    }

    func testRejectsDoneWithoutOk() {
        XCTAssertNil(decodeMessage("{\"type\":\"done\",\"reason\":\"completed\"}"))
    }

    func testDecodesHello() {
        guard case .hello(let v)? = decodeMessage("{\"type\":\"hello\",\"version\":1}") else {
            return XCTFail("未解析为 hello")
        }
        XCTAssertEqual(v, 1)
    }

    func testRejectsHelloWithoutVersion() {
        XCTAssertNil(decodeMessage("{\"type\":\"hello\"}"))
    }

    func testDecodesBye() {
        guard case .bye? = decodeMessage("{\"type\":\"bye\"}") else { return XCTFail("未解析为 bye") }
    }

    func testDecodesSurroundingWhitespace() {
        guard case .bye? = decodeMessage("  {\"type\":\"bye\"}  ") else { return XCTFail("未解析为 bye") }
    }
}
