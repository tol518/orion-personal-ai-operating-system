import XCTest
@testable import OrionKit

final class ChatWorkspaceTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    private let now = Date(timeIntervalSince1970: 1_000_000)

    func testMarkdownBlocksKeepCodeLiteral() {
        let source = """
        ## Status
        **bold** and *italic*
        on two lines

        - one
        3. three
        - [x] finished
        * [ ] pending
        > quoted
        > lines

        | A | B |
        | :--- | ---: |
        | 1 | 2 |
        ~~~swift
          # literal

        ~~~
        """
        XCTAssertEqual(MarkdownBlock.parse(source), [
            .heading(2, "Status"), .paragraph("**bold** and *italic*\non two lines"), .listItem("•", "one"),
            .listItem("3.", "three"), .listItem("☑", "finished"), .listItem("☐", "pending"),
            .quote("quoted\nlines"), .table([["A", "B"], ["1", "2"]]), .code(language: "swift", source: "  # literal\n")
        ])
        let fence = String(repeating: "\u{60}", count: 3)
        XCTAssertEqual(MarkdownBlock.parse(fence + "mermaid\nA-->B"), [.code(language: "mermaid", source: "A-->B")])
    }

    func testLocalTimeLabelsScreenshotCollisionsAndScrollBoundary() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let date = Date(timeIntervalSince1970: 3600)
        XCTAssertEqual(ChatFormatting.timeLabel(date, now: date, calendar: calendar), "01:00")
        XCTAssertEqual(ChatFormatting.timeLabel(date, now: date.addingTimeInterval(86400), calendar: calendar), "Yesterday 01:00")
        XCTAssertEqual(ChatFormatting.timeLabel(date, now: date.addingTimeInterval(172800), calendar: calendar), "1 Jan 01:00")
        let first = "screenshot-19700101-010000.png"
        XCTAssertEqual(ChatFormatting.screenshotName(date, existing: [], calendar: calendar), first)
        XCTAssertEqual(ChatFormatting.screenshotName(date, existing: [first, "screenshot-19700101-010000-2.png"], calendar: calendar),
                       "screenshot-19700101-010000-3.png")
        XCTAssertTrue(ChatFormatting.followsBottom(distance: 80))
        XCTAssertFalse(ChatFormatting.followsBottom(distance: 81))
    }

    func testSteeringRedirectIsIndependentOfEventOrder() throws {
        let delta: ChatEvent = try decode(#"{"runId":"old","state":"delta","deltaText":"partial"}"#)
        let abort: ChatEvent = try decode(#"{"runId":"old","state":"aborted"}"#)
        let ack: DesktopChatAck = try decode(#"{"delivered":"steer","ack":{"runId":"new","interruptedActiveRun":true}}"#)
        for abortFirst in [true, false] {
            var state = ConversationState()
            _ = state.receive(delta, at: now)
            let follow = ChatMessage(role: .user, text: "follow", time: now.addingTimeInterval(2))
            state.begin(follow)
            if abortFirst { XCTAssertFalse(state.receive(abort, at: now.addingTimeInterval(3))) }
            state.acknowledge(ack, at: now.addingTimeInterval(4))
            XCTAssertFalse(state.receive(abort, at: now.addingTimeInterval(5)))
            XCTAssertEqual(state.messages.filter { $0.role == .agent }.map(\.text), ["partial"])
            XCTAssertNotNil(state.runs["old"]?.end)
            XCTAssertEqual(state.current, "new")
            XCTAssertGreaterThan(try XCTUnwrap(state.runs["new"]?.time), follow.time)
            XCTAssertNil(state.note)
        }
    }

    func testLateAckCannotRestartFinishedRun() throws {
        var state = ConversationState()
        state.begin(ChatMessage(role: .user, text: "hello"))
        let event: ChatEvent = try decode(#"{"runId":"r","state":"final","message":"hi","savedMemories":[{"title":"Notes"}],"learnedLessons":[{"title":"Lesson"}]}"#)
        XCTAssertTrue(state.receive(event, at: now))
        state.acknowledge(try decode(#"{"delivered":"turn","ack":{"runId":"r"}}"#), at: now)
        XCTAssertNil(state.current)
        XCTAssertEqual(state.messages.last?.savedMemories, ["Notes"])
        XCTAssertEqual(state.messages.last?.learnedLessons, ["Lesson"])
        XCTAssertNil(state.note)
        XCTAssertEqual(ChatItem.timeline(state, approvals: []).count, 2)
    }

    func testQueuedRunStartsWhenPreviousRunEnds() throws {
        var state = ConversationState()
        state.start("old", at: now)
        state.begin(ChatMessage(role: .user, text: "follow", time: now))
        state.acknowledge(try decode(#"{"delivered":"turn","ack":{"runId":"next"}}"#), at: now)
        XCTAssertNotNil(state.note)
        XCTAssertEqual(state.current, "old")
        state.stopping = true
        _ = state.receive(try decode(#"{"state":"aborted","runId":"old"}"#), at: now)
        XCTAssertEqual(state.current, "next")
        XCTAssertFalse(state.stopping)
        state.stopping = true
        state.abortAcknowledged(true, for: "next", at: now)
        XCTAssertTrue(state.stopping)
        state.abortAcknowledged(false, for: "old", at: now)
        XCTAssertTrue(state.busy)
        state.abortAcknowledged(false, for: "next", at: now)
        XCTAssertFalse(state.stopping)
        XCTAssertFalse(state.busy)
    }

    func testHistoryGroupsToolsAndHidesPrivateBlocks() throws {
        let history: HistoryResponse = try decode("""
        {"messages":[
          {"role":"user","content":"first","timestamp":1000},
          {"role":"assistant","timestamp":1100,"content":[{"type":"thinking","thinking":"private","text":"private"},
            {"type":"toolCall","id":"a","name":"read","arguments":{"file_path":"notes","command":"read notes"}}]},
          {"role":"toolResult","toolCallId":"a","content":"result","timestamp":1200},
          {"role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":1300},
          {"role":"user","content":"second","timestamp":2000},
          {"role":"assistant","content":"response","timestamp":2100}]}
        """)
        let state = history.restored(key: "chat", active: false)
        XCTAssertEqual(state.messages.map(\.text), ["first", "done", "second", "response"])
        let run = try XCTUnwrap(state.runs["history-0"])
        XCTAssertEqual(run.time.timeIntervalSince1970, 1)
        XCTAssertEqual(run.end, Date(timeIntervalSince1970: 1.3))
        let tool = try XCTUnwrap(run.tools.first)
        XCTAssertEqual(tool.command, "read notes")
        XCTAssertEqual(tool.paths, ["notes"])
        XCTAssertEqual(tool.status, "done")
        XCTAssertEqual(tool.startedAt, 1100)
        XCTAssertEqual(tool.output, "result")
        let approval: Approval = try decode(#"{"id":"a","status":"pending","command":"echo","requestedAt":1150}"#)
        let timeline = ChatItem.timeline(state, approvals: [approval])
        XCTAssertEqual(timeline.map(\.time), [1, 1, 1.15, 1.3, 2, 2.1].map(Date.init(timeIntervalSince1970:)))
        XCTAssertEqual(timeline[2].id, "approval-a")
    }

    func testApprovalReplayCannotOverwriteLiveResolution() throws {
        let a: Approval = try decode(#"{"id":"a","sessionKey":"k","status":"pending","command":"echo","requestedAt":1}"#)
        var inbox = ApprovalInbox()
        inbox.receive(a)
        let version = inbox.revision
        inbox.resolve("a", status: "approved")
        inbox.replay([a], since: version)
        XCTAssertEqual(inbox.items.map(\.status), ["approved"])
        inbox.replay([], since: inbox.revision)
        XCTAssertEqual(inbox.items.map(\.id), ["a"])
    }
}
