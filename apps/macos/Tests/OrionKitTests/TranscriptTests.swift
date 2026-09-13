import XCTest
@testable import OrionKit

/// Transcript normalization. The BFF wraps user turns in a memory envelope and appends hidden
/// markers to assistant replies; the native transcript must hide both, exactly as the web UI does.
final class TranscriptFormatterTests: XCTestCase {
    func testUnwrapsAMemoryEnrichedUserMessage() {
        let enriched = """
        <jarvis-memory-context>
        some retrieved memory

        User message:
        what is the deploy status?

        Memory rules:
        do not invent memories
        """
        XCTAssertEqual(
            TranscriptFormatter.unwrapUserMessage(enriched),
            "what is the deploy status?"
        )
    }

    func testLeavesAPlainUserMessageAlone() {
        XCTAssertEqual(TranscriptFormatter.unwrapUserMessage("hello"), "hello")
    }

    func testLeavesAnEnvelopeMissingItsMarkersAlone() {
        // Better to show the raw envelope than to silently drop the user's words.
        let text = "<jarvis-memory-context>\nno markers here"
        XCTAssertEqual(TranscriptFormatter.unwrapUserMessage(text), text)
    }

    func testStripsEveryHiddenMarkerKind() {
        let reply = """
        Done.
        <!-- jarvis-memory-citations: ["m1","m2"] -->
        <!-- jarvis-memory-proposals: [] -->
        <!--jarvis-managed-memory-upserts:[{"id":"x"}]-->
        """
        XCTAssertEqual(TranscriptFormatter.stripHiddenMarkers(reply), "Done.")
    }

    func testStripsMarkersSpanningMultipleLines() {
        let reply = "Answer.\n<!-- jarvis-memory-citations:\n[\"m1\"]\n-->"
        XCTAssertEqual(TranscriptFormatter.stripHiddenMarkers(reply), "Answer.")
    }

    func testPreservesLeadingWhitespaceInsideAReply() {
        // Indentation is meaningful in a code block, so only trailing space is trimmed.
        XCTAssertEqual(TranscriptFormatter.stripHiddenMarkers("    indented   "), "    indented")
    }

    func testBuildsTranscriptFromHistory() throws {
        let json = """
        {"messages":[
          {"role":"user","text":"<jarvis-memory-context>\\nctx\\n\\nUser message:\\nping\\n\\nMemory rules:\\nrules"},
          {"role":"assistant","text":"pong<!-- jarvis-memory-citations: [] -->"},
          {"role":"tool","text":"ignored"},
          {"role":"assistant","text":"   "}
        ]}
        """
        let response = try JSONDecoder().decode(HistoryResponse.self, from: Data(json.utf8))
        let messages = TranscriptFormatter.messages(from: response)

        XCTAssertEqual(messages.count, 2, "tool turns and empty replies are not rendered")
        XCTAssertEqual(messages[0].role, .user)
        XCTAssertEqual(messages[0].text, "ping")
        XCTAssertEqual(messages[1].role, .agent)
        XCTAssertEqual(messages[1].text, "pong")
    }

    func testDecodesEveryMessageBodyShape() throws {
        let decoder = JSONDecoder()
        let asString = try decoder.decode(MessageBody.self, from: Data(#""just a string""#.utf8))
        XCTAssertEqual(asString.text, "just a string")

        let asText = try decoder.decode(MessageBody.self, from: Data(#"{"role":"user","text":"hi"}"#.utf8))
        XCTAssertEqual(asText.text, "hi")

        let asContentString = try decoder.decode(MessageBody.self, from: Data(#"{"content":"hi"}"#.utf8))
        XCTAssertEqual(asContentString.text, "hi")

        let asBlocks = try decoder.decode(
            MessageBody.self,
            from: Data(#"{"content":[{"text":"one "},{"text":"two"},{"type":"image"}]}"#.utf8)
        )
        XCTAssertEqual(asBlocks.text, "one two")

        let empty = try decoder.decode(MessageBody.self, from: Data(#"{"role":"user"}"#.utf8))
        XCTAssertEqual(empty.text, "")
    }

    func testFinalMessagePrefersTheMessageBody() throws {
        let event = try JSONDecoder().decode(
            ChatEvent.self,
            from: Data(#"{"state":"final","message":{"text":"complete answer"}}"#.utf8)
        )
        let message = TranscriptFormatter.finalMessage(for: event, accumulated: "partial")
        XCTAssertEqual(message.text, "complete answer")
        XCTAssertEqual(message.role, .agent)
    }

    func testFinalMessageFallsBackToAccumulatedDeltas() throws {
        // A final event without a body is normal; the deltas already carry the reply.
        let event = try JSONDecoder().decode(ChatEvent.self, from: Data(#"{"state":"final"}"#.utf8))
        XCTAssertEqual(
            TranscriptFormatter.finalMessage(for: event, accumulated: "streamed text").text,
            "streamed text"
        )
    }

    func testFailureStateUsesTheErrorMessageAndFailureRole() throws {
        let event = try JSONDecoder().decode(
            ChatEvent.self,
            from: Data(#"{"state":"error","errorMessage":"model refused"}"#.utf8)
        )
        let message = TranscriptFormatter.finalMessage(for: event, accumulated: "")
        XCTAssertEqual(message.role, .failure)
        XCTAssertEqual(message.text, "model refused")
    }

    func testEmptyTerminalEventStillRendersSomething() throws {
        let event = try JSONDecoder().decode(ChatEvent.self, from: Data(#"{"state":"aborted"}"#.utf8))
        XCTAssertEqual(TranscriptFormatter.finalMessage(for: event, accumulated: "").text, "(no reply)")
    }

    func testCarriesMemoryCitations() throws {
        let event = try JSONDecoder().decode(
            ChatEvent.self,
            from: Data(#"{"state":"final","message":"ok","memoryCitations":[{"id":"m1","title":"Deploy notes"},{"id":"m2"}]}"#.utf8)
        )
        let message = TranscriptFormatter.finalMessage(for: event, accumulated: "")
        XCTAssertEqual(message.citedMemories, ["Deploy notes", "m2"])
    }

    func testChatEventStateHelpers() throws {
        func event(_ json: String) throws -> ChatEvent {
            try JSONDecoder().decode(ChatEvent.self, from: Data(json.utf8))
        }
        XCTAssertTrue(try event(#"{"state":"delta"}"#).isDelta)
        XCTAssertTrue(try event(#"{"state":"final"}"#).isTerminal)
        XCTAssertTrue(try event(#"{"state":"aborted"}"#).isFailure)
        XCTAssertTrue(try event(#"{"state":"error"}"#).isFailure)
        XCTAssertFalse(try event(#"{"state":"final"}"#).isFailure)
        XCTAssertFalse(try event(#"{"state":"thinking"}"#).isTerminal)
    }
}
