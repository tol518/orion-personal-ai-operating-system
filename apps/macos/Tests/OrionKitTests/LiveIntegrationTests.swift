import XCTest
@testable import OrionKit

/// End-to-end exercise of the real Swift transport against a running BFF.
///
/// Skipped unless `ORION_TEST_HOST` and `ORION_TEST_PAIRING_SECRET` are set, so `swift test` stays
/// offline by default. Point it at a BFF with desktop access enabled — either the Mini or a local
/// instance in front of a stand-in gateway:
///
///     ORION_TEST_HOST=127.0.0.1:4899 \
///     ORION_TEST_PAIRING_SECRET=... \
///     swift test --filter LiveIntegrationTests
///
/// This is the acceptance check from the plan's First Vertical Slice: pair, list existing agents,
/// create a session, send a turn, and receive a streamed reply over the event stream.
final class LiveIntegrationTests: XCTestCase {
    private var host: String!
    private var secret: String!
    private var client: OrionClient!

    override func setUpWithError() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let host = environment["ORION_TEST_HOST"],
              let secret = environment["ORION_TEST_PAIRING_SECRET"]
        else {
            throw XCTSkip("Set ORION_TEST_HOST and ORION_TEST_PAIRING_SECRET to run the live slice.")
        }
        self.host = host
        self.secret = secret
        // An in-memory credential store, so a test run never writes to the real Keychain.
        client = OrionClient(credentials: InMemoryCredentialStore())
    }

    private func pairedClient() async throws -> OrionClient {
        try await client.configure(host: host)
        _ = try await client.pair(
            pairingSecret: secret,
            clientId: "macbook-orion",
            clientName: "Integration Test"
        )
        return client
    }

    func testPairsAndReportsHealth() async throws {
        let client = try await pairedClient()
        let health = try await client.health()
        XCTAssertTrue(health.reachable)
        XCTAssertTrue(health.gateway.connected, "the stack under test should have a connected gateway")
        XCTAssertEqual(health.client.clientId, "macbook-orion")
    }

    func testWrongSecretIsRejected() async throws {
        try await client.configure(host: host)
        do {
            _ = try await client.pair(
                pairingSecret: "definitely-not-the-secret",
                clientId: "macbook-orion",
                clientName: "Integration Test"
            )
            XCTFail("pairing should not succeed with a wrong secret")
        } catch let error as OrionClientError {
            // Throttling also counts: the point is that no token is issued.
            XCTAssertTrue(
                error == .unauthorized || error == .throttled(retryAfter: nil) || {
                    if case .throttled = error { return true } else { return false }
                }(),
                "unexpected error: \(error)"
            )
        }
    }

    func testReadsExistingAgentsAndNodes() async throws {
        let client = try await pairedClient()
        let agents = try await client.agents()
        XCTAssertFalse(agents.isEmpty, "the Mini should report its existing agents")

        let nodes = try await client.nodes()
        // Capability names are the BFF's coarsened set, never raw gateway command spellings.
        for node in nodes {
            for capability in node.capabilities {
                XCTAssertTrue(
                    ["exec", "screen", "browser", "canvas"].contains(capability),
                    "unexpected capability \(capability)"
                )
            }
        }
    }

    func testHistoryIsUnwrappedForDisplay() async throws {
        let client = try await pairedClient()
        guard let session = try await client.sessions().first else {
            throw XCTSkip("no sessions available on the stack under test")
        }
        let messages = try await client.history(sessionKey: session.key)
        for message in messages {
            // The BFF's envelopes and hidden markers must never reach the transcript.
            XCTAssertFalse(message.text.contains(TranscriptFormatter.memoryContextPrefix))
            XCTAssertFalse(message.text.contains("jarvis-memory-citations"))
        }
    }

    /// What Siri does: send a turn and speak the answer if it arrives quickly.
    func testIntentServiceSpeaksTheReply() async throws {
        // Pair once, then hand the same credential to the intent service, which builds its own
        // client exactly as it does when Siri launches the app in the background.
        let credentials = InMemoryCredentialStore()
        let paired = OrionClient(credentials: credentials)
        try await paired.configure(host: host)
        _ = try await paired.pair(pairingSecret: secret, clientId: "siri-probe", clientName: "Siri")

        let defaults = UserDefaults(suiteName: "app.orion.tests.\(UUID().uuidString)")!
        defaults.set(host, forKey: "orion.host")
        defer { defaults.removePersistentDomain(forName: defaults.description) }

        let service = OrionIntentService(
            settingsStore: SettingsStore(defaults: defaults),
            makeClient: { OrionClient(credentials: credentials) }
        )

        let agents = try await paired.agents()
        let agentName = try XCTUnwrap(agents.first?.name)
        let spoken = try await service.sendAwaitingReply(
            message: "Are both machines up?",
            toAgentNamed: agentName,
            timeout: 15
        )

        XCTAssertFalse(spoken.isEmpty)
        XCTAssertFalse(
            spoken.contains("still working"),
            "the reply should have arrived inside the window, got: \(spoken)"
        )
        // The agent's actual words, not just a confirmation that something was sent.
        XCTAssertTrue(spoken.lowercased().contains("reachable"), "unexpected reply: \(spoken)")
    }

    /// The acceptance criterion: a turn sent from this Mac streams back into the native transcript.
    func testChatTurnStreamsBack() async throws {
        let client = try await pairedClient()
        let agents = try await client.agents()
        let agentId = try XCTUnwrap(agents.first?.id)
        let created = try await client.createSession(agentId: agentId, label: "Live integration")
        let sessionKey = try XCTUnwrap(created, "the BFF should return the created session key")

        // Subscribe before sending, so no early delta is missed.
        let stream = try await client.makeEventStream()
        let collector = Task { () -> (deltas: String, final: String?) in
            var deltas = ""
            for try await event in stream.events() {
                guard event.name == "chat", let chat = event.decode(ChatEvent.self),
                      chat.sessionKey == sessionKey
                else { continue }
                if chat.isDelta {
                    deltas += chat.deltaText ?? ""
                } else if chat.isTerminal {
                    let message = TranscriptFormatter.finalMessage(for: chat, accumulated: deltas)
                    return (deltas, message.text)
                }
            }
            return (deltas, nil)
        }
        // Give the stream a moment to establish before the turn is submitted.
        try await Task.sleep(nanoseconds: 400_000_000)

        _ = try await client.sendChat(sessionKey: sessionKey, message: "Are both machines up?", agentId: agentId)

        // Bound the wait by cancelling the stream, which ends the collector's iteration and lets
        // it return. Racing the collector inside a task group instead would deadlock: the group
        // awaits every child on throw, and a child awaiting an unstructured Task never unblocks.
        let watchdog = Task {
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            stream.cancel()
        }
        let outcome = try await collector.value
        watchdog.cancel()
        stream.cancel()

        let reply = try XCTUnwrap(outcome.final, "the run never reached a terminal state within 20s")
        XCTAssertFalse(reply.isEmpty)
        XCTAssertFalse(outcome.deltas.isEmpty, "the reply should have arrived incrementally")

        // The session must be visible to the other client too — same runtime, not a copy.
        let sessions = try await client.sessions()
        XCTAssertTrue(sessions.contains { $0.key == sessionKey }, "the new session should be listed")
    }
}
