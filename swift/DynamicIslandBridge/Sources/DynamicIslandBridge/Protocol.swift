import CoreFoundation
import Foundation

/// Wire protocol between the plugin (client) and this helper (server).
///
/// One JSON object per line, UTF-8. Field names mirror `src/protocol.ts`
/// exactly — that file is the contract's source of truth on the TypeScript side.
///
/// Everything in this file is pure logic with zero I/O so it can be unit tested
/// without a socket, a window, or a display.

/// How the reported percentage was derived. Carried on the wire so the UI can
/// eventually distinguish an estimate from a measured value.
public enum ProgressMode: String, Sendable {
    case estimated
    case precise
}

/// A decoded inbound message.
public enum InboundMessage: Sendable, Equatable {
    /// Handshake. Carries the plugin's protocol version.
    case hello(version: Int)
    /// Progress update. `percent` is a 0...1 fraction, already clamped.
    case progress(percent: Double, mode: ProgressMode, message: String?)
    /// Terminal state. `ok == false` means the turn ended abnormally.
    case done(reason: String, ok: Bool)
    /// Retract the island and go back to waiting.
    case bye
}

/// Reassembles newline-delimited frames from arbitrarily chunked reads.
///
/// A frame can be split across any number of reads, and one read can carry
/// several frames. The buffer keeps the unfinished tail; parsing a partial frame
/// would either throw or — worse — silently drop a message.
///
/// The byte-oriented `append` overload exists because a socket delivers *bytes*.
/// Decoding each read to a `String` independently and splitting that would
/// replace a multi-byte UTF-8 scalar straddling a read boundary with U+FFFD,
/// corrupting the payload with no error anywhere. Splitting on the newline byte
/// first means a line boundary can never fall inside a scalar.
public struct LineBuffer {
    /// Frames we expect are well under 1 KiB. A pending buffer this large means
    /// the peer never sends a newline — a broken sender, not a slow one.
    public static let maxPendingBytes = 1 << 20

    private var pending = Data()

    public init() {}

    /// Convenience overload for text sources.
    public mutating func append(_ chunk: String) -> [String] {
        append(Data(chunk.utf8))
    }

    /// Appends raw bytes and returns every complete, non-empty line.
    public mutating func append(_ chunk: Data) -> [String] {
        pending.append(chunk)

        if pending.count > Self.maxPendingBytes {
            // There is no error channel here and throwing would take down the
            // progress feed for the rest of the session. Drop the garbage and
            // resynchronize on the next newline instead.
            pending.removeAll(keepingCapacity: false)
            return []
        }

        var lines: [String] = []
        while let newlineAt = pending.firstIndex(of: 0x0A) {
            let frame = Data(pending[pending.startIndex..<newlineAt])
            pending = Data(pending[pending.index(after: newlineAt)...])

            // A malformed line is dropped, not fatal — same policy as
            // `decodeMessages` in src/protocol.ts.
            guard let text = String(data: frame, encoding: .utf8) else { continue }

            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { lines.append(trimmed) }
        }
        return lines
    }
}

/// Decodes one complete NDJSON line, or returns `nil` for anything malformed.
///
/// Never throws: a corrupt frame must not take down the progress channel. Every
/// field is validated strictly rather than coerced, because a coerced value
/// shows up in the UI as a plausible-looking lie:
///
/// - `percent` out of `[0, 1]` is clamped (the sender and receiver both clamp —
///   see the plan's interface table), but a non-number or non-finite value is
///   rejected outright.
/// - `true`/`false` bridge to `NSNumber` in Swift and would read as `1.0`/`0.0`;
///   they are rejected explicitly.
public func decodeMessage(_ line: String) -> InboundMessage? {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }

    guard
        let object = try? JSONSerialization.jsonObject(with: data),
        let record = object as? [String: Any],
        let type = record["type"] as? String
    else { return nil }

    switch type {
    case "hello":
        guard let version = intValue(record["version"]) else { return nil }
        return .hello(version: version)

    case "progress":
        guard let percent = numberValue(record["percent"]), percent.isFinite else { return nil }
        guard
            let rawMode = record["mode"] as? String,
            let mode = ProgressMode(rawValue: rawMode)
        else { return nil }

        var message: String?
        if let rawMessage = record["message"] {
            guard let text = rawMessage as? String else { return nil }
            message = text
        }
        return .progress(percent: min(1, max(0, percent)), mode: mode, message: message)

    case "done":
        guard
            let reason = record["reason"] as? String,
            let ok = boolValue(record["ok"])
        else { return nil }
        return .done(reason: reason, ok: ok)

    case "bye":
        return .bye

    default:
        // Forward compatible by construction: an unknown type is ignored rather
        // than treated as a protocol violation.
        return nil
    }
}

// MARK: - Strict scalar extraction

/// Extracts a finite `Double`, refusing booleans.
private func numberValue(_ any: Any?) -> Double? {
    guard let number = any as? NSNumber else { return nil }
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
    return number.doubleValue
}

/// Extracts an integral `Int`, refusing booleans, fractions, and overflow.
private func intValue(_ any: Any?) -> Int? {
    guard let value = numberValue(any) else { return nil }
    guard value.isFinite, value.rounded() == value,
          value >= Double(Int.min), value <= Double(Int.max)
    else { return nil }
    return Int(value)
}

/// Extracts a `Bool` only from a real JSON boolean.
private func boolValue(_ any: Any?) -> Bool? {
    guard let number = any as? NSNumber else { return nil }
    guard CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}
