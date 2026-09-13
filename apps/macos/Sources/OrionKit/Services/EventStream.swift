import Foundation

/// One decoded server-sent event from the desktop stream.
public struct ServerSentEvent: Sendable, Equatable {
    public let name: String
    public let data: String

    public init(name: String, data: String) {
        self.name = name
        self.data = data
    }

    public func decode<T: Decodable>(_ type: T.Type) -> T? {
        guard let payload = data.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(type, from: payload)
    }
}

/// Incremental SSE parser.
///
/// Kept separate from the transport so the framing rules can be tested without a socket: events
/// arrive split across arbitrary chunk boundaries, and a naive line-at-a-time reader loses
/// multi-line `data:` payloads and comment keep-alives.
public struct ServerSentEventParser {
    private var pendingName: String?
    private var pendingData: [String] = []
    private var lineBuffer: [UInt8] = []

    public init() {}

    /// Feeds one raw byte, returning an event when a completed line terminates a block.
    ///
    /// Bytes rather than `URLSession.AsyncBytes.lines`: that sequence does not emit empty lines,
    /// and a blank line is exactly what dispatches an SSE event — consuming it would mean never
    /// dispatching anything.
    public mutating func consume(byte: UInt8) -> ServerSentEvent? {
        switch byte {
        case UInt8(ascii: "\n"):
            let line = String(decoding: lineBuffer, as: UTF8.self)
            lineBuffer.removeAll(keepingCapacity: true)
            return consume(line: line)
        case UInt8(ascii: "\r"):
            // CRLF framing: the CR belongs to the terminator, not the value.
            return nil
        default:
            lineBuffer.append(byte)
            return nil
        }
    }

    /// Feeds one complete line and returns an event when the line terminates a block.
    public mutating func consume(line: String) -> ServerSentEvent? {
        // A blank line dispatches the accumulated block.
        if line.isEmpty {
            defer {
                pendingName = nil
                pendingData = []
            }
            guard let name = pendingName, !pendingData.isEmpty else { return nil }
            return ServerSentEvent(name: name, data: pendingData.joined(separator: "\n"))
        }
        // Comments are keep-alives (the BFF writes ": ping" every 25s).
        if line.hasPrefix(":") { return nil }

        guard let separator = line.firstIndex(of: ":") else { return nil }
        let field = String(line[line.startIndex..<separator])
        var value = String(line[line.index(after: separator)...])
        if value.hasPrefix(" ") { value.removeFirst() }

        switch field {
        case "event": pendingName = value
        case "data": pendingData.append(value)
        default: break // id and retry are unused by this contract.
        }
        return nil
    }
}

/// Reads the desktop SSE stream as an async sequence of events.
public final class EventStream: @unchecked Sendable {
    private let request: URLRequest
    private let session: URLSession
    private var task: Task<Void, Never>?

    public init(request: URLRequest, session: URLSession) {
        self.request = request
        self.session = session
    }

    /// Yields events until the stream ends, the task is cancelled, or the connection fails.
    ///
    /// A finished stream is not an error: the caller decides whether to reconnect, because a
    /// dropped stream and a revoked pairing need different responses.
    public func events() -> AsyncThrowingStream<ServerSentEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        throw OrionClient.mapFailure(status: http.statusCode, headers: http, data: Data())
                    }
                    var parser = ServerSentEventParser()
                    for try await byte in bytes {
                        if Task.isCancelled { break }
                        if let event = parser.consume(byte: byte) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch let error as URLError where error.code == .cancelled {
                    continuation.finish()
                } catch let error as URLError {
                    continuation.finish(throwing: OrionClientError.transport(error.localizedDescription))
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            self.task = task
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
    }
}

/// Gateway status as it arrives on the desktop stream — already redacted by the BFF.
public struct GatewayStatusEvent: Decodable, Sendable, Equatable {
    public let connected: Bool
    public let scopeCount: Int?
    public let reason: String?
}
