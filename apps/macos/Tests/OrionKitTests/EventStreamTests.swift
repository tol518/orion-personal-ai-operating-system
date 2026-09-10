import XCTest
@testable import OrionKit

/// The SSE framing rules. These matter because events arrive split across arbitrary chunk
/// boundaries and the BFF writes comment keep-alives between them.
final class ServerSentEventParserTests: XCTestCase {
    /// Feeds lines the way the transport does and collects whatever dispatches.
    private func parse(_ lines: [String]) -> [ServerSentEvent] {
        var parser = ServerSentEventParser()
        return lines.compactMap { parser.consume(line: $0) }
    }

    func testParsesASingleEvent() {
        let events = parse(["event: chat", #"data: {"state":"delta"}"#, ""])
        XCTAssertEqual(events, [ServerSentEvent(name: "chat", data: #"{"state":"delta"}"#)])
    }

    func testJoinsMultiLineDataPayloads() {
        let events = parse(["event: chat", "data: line one", "data: line two", ""])
        XCTAssertEqual(events.first?.data, "line one\nline two")
    }

    func testIgnoresKeepAliveComments() {
        // The BFF writes ": ping" every 25 seconds; it must not dispatch or clear pending state.
        let events = parse(["event: chat", ": ping", "data: payload", ""])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.data, "payload")
    }

    func testDoesNotDispatchAnEventWithoutData() {
        XCTAssertTrue(parse(["event: chat", ""]).isEmpty)
    }

    func testDoesNotDispatchDataWithoutAnEventName() {
        XCTAssertTrue(parse(["data: orphaned", ""]).isEmpty)
    }

    func testHandlesConsecutiveEvents() {
        let events = parse([
            "event: gateway.status", "data: a", "",
            "event: chat", "data: b", "",
        ])
        XCTAssertEqual(events.map(\.name), ["gateway.status", "chat"])
        XCTAssertEqual(events.map(\.data), ["a", "b"])
    }

    func testStripsOnlyOneLeadingSpaceFromAValue() {
        let events = parse(["event: chat", "data:  two spaces", ""])
        XCTAssertEqual(events.first?.data, " two spaces")
    }

    func testIgnoresUnknownFields() {
        let events = parse(["id: 42", "retry: 500", "event: chat", "data: payload", ""])
        XCTAssertEqual(events.count, 1)
    }

    func testBlankLineResetsPartialState() {
        // A dropped connection can leave a half-written block; the next event must still parse.
        let events = parse(["event: chat", "", "event: agent", "data: fresh", ""])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.name, "agent")
    }

    /// Regression test for the framing bug this parser exists to avoid.
    ///
    /// `URLSession.AsyncBytes.lines` silently drops empty lines, and a blank line is exactly what
    /// dispatches an SSE event — so a line-based reader receives every byte and yields nothing.
    /// The byte path must preserve blank lines.
    func testByteStreamDispatchesOnBlankLines() {
        var parser = ServerSentEventParser()
        let wire = "event: chat\ndata: {\"state\":\"delta\"}\n\nevent: agent\ndata: second\n\n"
        var events: [ServerSentEvent] = []
        for byte in Array(wire.utf8) {
            if let event = parser.consume(byte: byte) { events.append(event) }
        }
        XCTAssertEqual(events.map(\.name), ["chat", "agent"])
        XCTAssertEqual(events.map(\.data), [#"{"state":"delta"}"#, "second"])
    }

    func testByteStreamHandlesCRLFFraming() {
        var parser = ServerSentEventParser()
        var events: [ServerSentEvent] = []
        for byte in Array("event: chat\r\ndata: payload\r\n\r\n".utf8) {
            if let event = parser.consume(byte: byte) { events.append(event) }
        }
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.data, "payload", "the CR must not survive into the value")
    }

    func testByteStreamSurvivesChunkBoundariesMidEvent() {
        // Bytes arrive in whatever sizes the socket delivers; state must persist across them.
        var parser = ServerSentEventParser()
        var events: [ServerSentEvent] = []
        for chunk in ["event: ch", "at\ndata: {\"a\":1", "}\n", "\n"] {
            for byte in Array(chunk.utf8) {
                if let event = parser.consume(byte: byte) { events.append(event) }
            }
        }
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.name, "chat")
        XCTAssertEqual(events.first?.data, #"{"a":1}"#)
    }

    func testByteStreamIgnoresKeepAliveComments() {
        var parser = ServerSentEventParser()
        var events: [ServerSentEvent] = []
        for byte in Array(": ping\n\nevent: chat\ndata: real\n\n".utf8) {
            if let event = parser.consume(byte: byte) { events.append(event) }
        }
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.data, "real")
    }

    func testByteStreamHandlesMultiByteUTF8() {
        var parser = ServerSentEventParser()
        var events: [ServerSentEvent] = []
        for byte in Array("event: chat\ndata: caf\u{00E9} \u{1F680}\n\n".utf8) {
            if let event = parser.consume(byte: byte) { events.append(event) }
        }
        XCTAssertEqual(events.first?.data, "café 🚀", "a character split across bytes must reassemble")
    }

    func testDecodesGatewayStatus() {
        let event = ServerSentEvent(
            name: "gateway.status",
            data: #"{"connected":false,"scopeCount":0,"reason":"gateway not reachable from the host"}"#
        )
        let status = event.decode(GatewayStatusEvent.self)
        XCTAssertEqual(status?.connected, false)
        XCTAssertEqual(status?.reason, "gateway not reachable from the host")
    }

    func testDecodeReturnsNilForMalformedJson() {
        XCTAssertNil(ServerSentEvent(name: "chat", data: "not json").decode(ChatEvent.self))
    }
}
