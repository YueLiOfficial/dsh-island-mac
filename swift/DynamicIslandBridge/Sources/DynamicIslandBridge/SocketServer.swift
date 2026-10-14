import Darwin
import Foundation

/// Failures that prevent the server from listening at all.
///
/// These are thrown from `start()`; runtime I/O errors on an established
/// connection go to the `onError` callback instead, because a broken client must
/// never take the server down with it.
public enum SocketServerError: Error, Equatable, CustomStringConvertible {
    case socketPathTooLong(path: String, byteCount: Int, limit: Int)
    case systemCall(name: String, code: Int32)

    public var description: String {
        switch self {
        case let .socketPathTooLong(path, byteCount, limit):
            return """
            unix socket path is too long: \(byteCount) bytes > \(limit). \
            sockaddr_un.sun_path holds only 104 bytes including the NUL terminator. \
            Path was: \(path)
            """
        case let .systemCall(name, code):
            return "\(name) failed: \(String(cString: strerror(code))) (errno \(code))"
        }
    }
}

/// A Unix-domain-socket server speaking NDJSON, one JSON object per line.
///
/// This process is the *server*: the plugin connects to us. That direction is
/// deliberate — the helper is the side that restarts, and a stable client that
/// reconnects is simpler to reason about than a listening client that has to
/// recover from a peer that vanished mid-accept.
///
/// Concurrency: every mutable field is touched only on `queue`, which is serial.
/// `stop()` and `start()` therefore funnel through `queue.sync` rather than
/// reaching in directly. The `@unchecked Sendable` conformance is an assertion
/// about exactly that discipline, not an accident.
///
/// Single-client: a new connection closes the previous one, so a plugin restart
/// always wins without needing the old connection to time out first.
public final class SocketServer: @unchecked Sendable {
    public typealias MessageHandler = @Sendable (InboundMessage) -> Void
    public typealias ErrorHandler = @Sendable (String) -> Void

    /// `sockaddr_un.sun_path` is `char[104]` and needs a NUL terminator.
    public static let maxSocketPathBytes = 104 - 1

    private let socketPath: String
    private let onMessage: MessageHandler
    private let onError: ErrorHandler

    /// Serializes all socket state. Also the target queue for every dispatch source.
    private let queue = DispatchQueue(label: "dev.dsh.dynamic-island.socket-server")

    private var listenFD: Int32 = -1
    private var listenSource: DispatchSourceRead?
    private var clientFD: Int32 = -1
    private var clientSource: DispatchSourceRead?
    private var lineBuffer = LineBuffer()
    private var isStopped = false
    private var didBind = false

    public init(
        socketPath: String,
        onMessage: @escaping MessageHandler,
        onError: @escaping ErrorHandler
    ) {
        self.socketPath = socketPath
        self.onMessage = onMessage
        self.onError = onError
    }

    // MARK: - Lifecycle

    /// Removes any stale socket, binds, and starts accepting.
    ///
    /// Throws only for conditions that make listening impossible. Calling this
    /// after `stop()` is a no-op that cleans up after itself.
    public func start() throws {
        if socketPath.utf8.count > Self.maxSocketPathBytes {
            throw SocketServerError.socketPathTooLong(
                path: socketPath,
                byteCount: socketPath.utf8.count,
                limit: Self.maxSocketPathBytes
            )
        }

        let fd = try createListeningSocket()

        queue.sync {
            guard !isStopped else {
                // stop() ran first; do not leak the descriptor we just bound.
                close(fd)
                if didBind { unlink(socketPath) }
                return
            }

            listenFD = fd
            didBind = true

            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self] in self?.acceptPendingConnection() }
            listenSource = source
            source.resume()
        }
    }

    /// Stops accepting, drops the current client, and unlinks the socket.
    ///
    /// Idempotent. Synchronous: when this returns, the socket file is gone and no
    /// further `onMessage` callback will be delivered.
    ///
    /// Do not call this from inside an `onMessage` callback — that runs on
    /// `queue`, and `stop()` does a `queue.sync`.
    public func stop() {
        queue.sync {
            guard !isStopped else { return }
            isStopped = true

            closeClient()

            if let source = listenSource {
                source.cancel()
            }
            listenSource = nil

            if listenFD >= 0 {
                close(listenFD)
                listenFD = -1
            }

            if didBind {
                unlink(socketPath)
                didBind = false
            }
        }
    }

    // MARK: - Listening socket

    /// Performs the socket setup on the calling thread; nothing shared is touched.
    private func createListeningSocket() throws -> Int32 {
        // A predecessor that crashed leaves the socket file behind and bind()
        // would fail with EADDRINUSE against a socket no one is listening on.
        // Unconditional unlink is the documented recovery.
        if unlink(socketPath) != 0, errno != ENOENT {
            throw SocketServerError.systemCall(name: "unlink", code: errno)
        }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw SocketServerError.systemCall(name: "socket", code: errno)
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        // strlcpy, not strncpy: it always NUL-terminates, so a truncated path can
        // never make bind() read past the buffer.
        socketPath.withCString { source in
            withUnsafeMutablePointer(to: &addr.sun_path) { pathPointer in
                pathPointer.withMemoryRebound(to: CChar.self, capacity: 104) { destination in
                    _ = strlcpy(destination, source, 104)
                }
            }
        }

        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) }
        }
        guard bindResult == 0 else {
            let code = errno
            close(fd)
            throw SocketServerError.systemCall(name: "bind", code: code)
        }

        guard listen(fd, 4) == 0 else {
            let code = errno
            close(fd)
            throw SocketServerError.systemCall(name: "listen", code: code)
        }

        // Private to this user. Progress text is not secret, but it is also
        // nobody else's business.
        chmod(socketPath, 0o600)

        return fd
    }

    // MARK: - Connection handling (all on `queue`)

    private func acceptPendingConnection() {
        var addr = sockaddr_un()
        var length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let fd = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(listenFD, $0, &length) }
        }

        guard fd >= 0 else {
            if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { return }
            onError("accept failed: \(String(cString: strerror(errno))) (errno \(errno))")
            return
        }

        closeClient()

        clientFD = fd
        lineBuffer = LineBuffer()

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.readFromClient(fd) }
        clientSource = source
        source.resume()
    }

    private func readFromClient(_ fd: Int32) {
        // A queued event can outlive the connection it belongs to when a second
        // client replaced the first. Acting on it would read from a closed — and
        // possibly reused — descriptor.
        guard fd == clientFD else { return }

        var chunk = [UInt8](repeating: 0, count: 4096)
        let count = read(fd, &chunk, chunk.count)

        if count > 0 {
            for line in lineBuffer.append(Data(chunk[0..<count])) {
                if let message = decodeMessage(line) {
                    onMessage(message)
                } else {
                    // Same policy as src/protocol.ts: one corrupt frame is dropped,
                    // never fatal. Truncated so a garbage flood cannot blow up logs.
                    onError("dropped malformed frame: \(line.prefix(120))")
                }
            }
            return
        }

        if count == 0 {
            closeClient() // orderly EOF
            return
        }

        if errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { return }

        onError("read failed: \(String(cString: strerror(errno))) (errno \(errno))")
        closeClient()
    }

    /// Cancels the client source *before* closing the descriptor, and never
    /// installs a cancel handler that closes it: cancel handlers run
    /// asynchronously, so a late one could close a newly accepted connection that
    /// reused the same descriptor number.
    private func closeClient() {
        if let source = clientSource {
            source.cancel()
        }
        clientSource = nil

        if clientFD >= 0 {
            close(clientFD)
            clientFD = -1
        }

        lineBuffer = LineBuffer()
    }
}
