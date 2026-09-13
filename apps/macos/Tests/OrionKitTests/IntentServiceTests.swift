import XCTest
@testable import OrionKit

/// Logic behind the Siri and Shortcuts entry points.
///
/// The transport is shared with the windowed app, so what is worth testing here is the decision
/// making: which agent a spoken name refers to, which session an unqualified message lands in,
/// and whether an unconfigured or unpaired Mac says something useful instead of failing opaquely.
final class OrionIntentServiceTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "app.orion.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func service(host: String? = nil, token: String? = nil) -> OrionIntentService {
        if let host { defaults.set(host, forKey: "orion.host") }
        let credentials = InMemoryCredentialStore(tokens: token.map { ["mini.example:4820": $0] } ?? [:])
        return OrionIntentService(
            settingsStore: SettingsStore(defaults: defaults),
            makeClient: { OrionClient(credentials: credentials) }
        )
    }

    private func agent(_ id: String, _ name: String) throws -> DesktopAgent {
        let json = #"{"id":"\#(id)","name":"\#(name)","description":null,"currentModel":null,"models":[]}"#
        return try JSONDecoder().decode(DesktopAgent.self, from: Data(json.utf8))
    }

    private func session(_ key: String, agent: String, title: String, updatedAt: String?) throws -> DesktopSession {
        let updated = updatedAt.map { "\"\($0)\"" } ?? "null"
        let json = """
        {"key":"\(key)","agentId":"\(agent)","title":"\(title)","model":null,
         "lastMessagePreview":null,"hasActiveRun":false,"totalTokens":null,
         "contextTokens":null,"updatedAt":\(updated)}
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = ISO8601DateFormatter.orionFractional.date(from: text)
                ?? ISO8601DateFormatter.orionPlain.date(from: text)
            else { throw DecodingError.dataCorruptedError(in: try decoder.singleValueContainer(), debugDescription: "bad date") }
            return date
        }
        return try decoder.decode(DesktopSession.self, from: Data(json.utf8))
    }

    // MARK: Spoken state

    func testUnconfiguredMacSaysWhatToDo() async {
        let sentence = await service().statusSentence()
        XCTAssertTrue(sentence.contains("no Mini address"), "got: \(sentence)")
    }

    func testUnpairedMacSaysWhatToDo() async {
        let sentence = await service(host: "mini.example").statusSentence()
        XCTAssertTrue(sentence.contains("not paired"), "got: \(sentence)")
    }

    func testStatusNeverThrows() async {
        // Siri has no useful way to render a thrown error, so this always produces a sentence.
        let sentence = await service(host: "mini.example", token: "t").statusSentence()
        XCTAssertFalse(sentence.isEmpty)
    }

    func testSendRefusesAnEmptyMessage() async {
        do {
            _ = try await service(host: "mini.example", token: "t").send(message: "   ")
            XCTFail("an empty message should not be sent")
        } catch let error as OrionIntentService.IntentError {
            XCTAssertEqual(error, .failed("There was no message to send."))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testSendFromAnUnconfiguredMacExplainsWhy() async {
        do {
            _ = try await service().send(message: "status?")
            XCTFail("should not send")
        } catch let error as OrionIntentService.IntentError {
            XCTAssertEqual(error, .notConfigured)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: Agent matching

    func testMatchesAnAgentSpokenWithoutPunctuationOrCase() throws {
        let agents = [try agent("main", "J.A.R.V.I.S."), try agent("codex", "WALL-E")]
        XCTAssertEqual(OrionIntentService.matchAgent(named: "jarvis", in: agents)?.id, "main")
        XCTAssertEqual(OrionIntentService.matchAgent(named: "Wall E", in: agents)?.id, "codex")
        XCTAssertEqual(OrionIntentService.matchAgent(named: "walle", in: agents)?.id, "codex")
    }

    func testMatchesByAgentId() throws {
        let agents = [try agent("main", "J.A.R.V.I.S.")]
        XCTAssertEqual(OrionIntentService.matchAgent(named: "main", in: agents)?.id, "main")
    }

    func testRefusesAnAmbiguousAgentName() throws {
        // Sending a spoken message to the wrong agent is worse than declining to guess.
        let agents = [try agent("a", "Research Bot"), try agent("b", "Research Helper")]
        XCTAssertNil(OrionIntentService.matchAgent(named: "research", in: agents))
    }

    func testRefusesAnUnknownOrEmptyAgentName() throws {
        let agents = [try agent("main", "Orion")]
        XCTAssertNil(OrionIntentService.matchAgent(named: "nonexistent", in: agents))
        XCTAssertNil(OrionIntentService.matchAgent(named: "", in: agents))
        XCTAssertNil(OrionIntentService.matchAgent(named: "...", in: agents))
    }

    // MARK: Session selection

    func testUnqualifiedMessageGoesToTheMostRecentSession() throws {
        let sessions = [
            try session("agent:main:1", agent: "main", title: "Older", updatedAt: "2026-09-01T10:00:00.000Z"),
            try session("agent:main:2", agent: "main", title: "Newest", updatedAt: "2026-09-10T10:00:00.000Z"),
            try session("agent:main:3", agent: "main", title: "Middle", updatedAt: "2026-09-05T10:00:00.000Z"),
        ]
        XCTAssertEqual(OrionIntentService.mostRecent(of: sessions)?.title, "Newest")
    }

    func testSessionsWithoutATimestampSortLast() throws {
        let sessions = [
            try session("agent:main:1", agent: "main", title: "Undated", updatedAt: nil),
            try session("agent:main:2", agent: "main", title: "Dated", updatedAt: "2026-09-01T10:00:00.000Z"),
        ]
        XCTAssertEqual(OrionIntentService.mostRecent(of: sessions)?.title, "Dated")
    }

    func testNoSessionsYieldsNothingToPick() {
        XCTAssertNil(OrionIntentService.mostRecent(of: []))
    }

    func testEveryIntentErrorReadsAsASentence() {
        // These are spoken aloud, so each needs to stand on its own.
        let errors: [OrionIntentService.IntentError] = [
            .notConfigured, .notPaired, .noSessions, .failed("Something specific happened."),
        ]
        for error in errors {
            let text = try? XCTUnwrap(error.errorDescription)
            XCTAssertNotNil(text)
            XCTAssertTrue(text?.hasSuffix(".") ?? false, "“\(text ?? "")” should end as a sentence")
        }
    }
}
