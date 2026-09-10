import XCTest
@testable import OrionKit

/// Store behavior driven by the event stream. These run without a network: events are handed to
/// the store the way the SSE transport hands them over, which is where the streaming, filtering,
/// and connection-state rules live.
@MainActor
final class OrionStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        // A private domain, so tests never read or write the user's real settings.
        suiteName = "app.orion.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func makeStore() -> OrionStore {
        OrionStore(
            client: OrionClient(credentials: InMemoryCredentialStore()),
            settingsStore: SettingsStore(defaults: defaults),
            notifier: SilentNotifier()
        )
    }

    private func event(_ name: String, _ data: String) -> ServerSentEvent {
        ServerSentEvent(name: name, data: data)
    }

    func testStartsUnconfiguredWithNoStoredHost() async {
        let store = makeStore()
        await store.start()
        XCTAssertEqual(store.connection, .unconfigured)
        XCTAssertFalse(store.connection.isConnected)
    }

    func testGeneratesAndReusesAClientId() {
        let first = makeStore().settings.clientId
        XCTAssertFalse(first.isEmpty)
        // A second store on the same defaults must pair as the same device.
        XCTAssertEqual(makeStore().settings.clientId, first)
    }

    func testGatewayStatusEventUpdatesTheBadge() {
        let store = makeStore()
        store.handle(event("gateway.status", #"{"connected":true,"scopeCount":5,"reason":null}"#))
        XCTAssertTrue(store.gatewayConnected)
        XCTAssertNil(store.gatewayReason)

        store.handle(event(
            "gateway.status",
            #"{"connected":false,"scopeCount":0,"reason":"gateway not reachable from the host"}"#
        ))
        XCTAssertFalse(store.gatewayConnected)
        XCTAssertEqual(store.gatewayReason, "gateway not reachable from the host")
    }

    func testGatewayDisconnectedEventClearsTheBadge() {
        let store = makeStore()
        store.handle(event("gateway.status", #"{"connected":true,"scopeCount":5}"#))
        store.handle(event("gateway.disconnected", #"{"code":1006}"#))
        XCTAssertFalse(store.gatewayConnected)
        XCTAssertNotNil(store.gatewayReason)
    }

    func testDeltasAccumulateIntoTheStreamingReply() {
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"

        store.handle(event("chat", #"{"sessionKey":"agent:main:1","state":"delta","deltaText":"Hel"}"#))
        store.handle(event("chat", #"{"sessionKey":"agent:main:1","state":"delta","deltaText":"lo"}"#))

        XCTAssertEqual(store.streamingReply, "Hello")
        XCTAssertTrue(store.messages.isEmpty, "a streaming reply is not a settled turn yet")
    }

    func testTerminalEventSettlesTheTurnAndClearsStreaming() {
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"

        store.handle(event("chat", #"{"sessionKey":"agent:main:1","state":"delta","deltaText":"Done"}"#))
        store.handle(event("chat", #"{"sessionKey":"agent:main:1","state":"final","message":{"text":"Done."}}"#))

        XCTAssertNil(store.streamingReply)
        XCTAssertEqual(store.messages.count, 1)
        XCTAssertEqual(store.messages.first?.text, "Done.")
        XCTAssertEqual(store.messages.first?.role, .agent)
        XCTAssertFalse(store.isSending)
    }

    func testEventsForAnotherSessionAreIgnored() {
        // Both clients read the same stream, so a turn driven from the web UI arrives here too.
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"

        store.handle(event("chat", #"{"sessionKey":"agent:codex:9","state":"delta","deltaText":"other"}"#))
        store.handle(event("chat", #"{"sessionKey":"agent:codex:9","state":"final","message":"other"}"#))

        XCTAssertNil(store.streamingReply)
        XCTAssertTrue(store.messages.isEmpty)
    }

    func testEventWithoutASessionKeyIsAccepted() {
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"
        store.handle(event("chat", #"{"state":"final","message":"unkeyed"}"#))
        XCTAssertEqual(store.messages.count, 1)
    }

    func testFailureStateIsRenderedAsAFailedTurn() {
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"
        store.handle(event(
            "chat",
            #"{"sessionKey":"agent:main:1","state":"error","errorMessage":"gateway not connected"}"#
        ))

        XCTAssertEqual(store.messages.first?.role, .failure)
        XCTAssertEqual(store.messages.first?.text, "gateway not connected")
        XCTAssertFalse(store.isSending)
    }

    func testHiddenMarkersDoNotReachTheTranscript() {
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"
        store.handle(event(
            "chat",
            #"{"sessionKey":"agent:main:1","state":"final","message":{"text":"Saved.<!-- jarvis-memory-citations: [\"m1\"] -->"}}"#
        ))
        XCTAssertEqual(store.messages.first?.text, "Saved.")
    }

    func testMalformedEventPayloadIsIgnored() {
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"
        store.handle(event("chat", "not json at all"))
        store.handle(event("gateway.status", "{"))
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertFalse(store.gatewayConnected)
    }

    func testUnknownEventNamesAreIgnored() {
        let store = makeStore()
        store.handle(event("memory.changed", #"{"count":3}"#))
        store.handle(event("session.tool", #"{"name":"bash"}"#))
        XCTAssertTrue(store.messages.isEmpty)
    }

    func testSendWithoutASelectedSessionDoesNothing() async {
        let store = makeStore()
        await store.send("hello")
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertFalse(store.isSending)
    }

    func testSendShowsTheUserTurnThenReportsTheFailure() async {
        // With no configured host the client throws, which is the same path a dropped Mini takes.
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"
        await store.send("status?")

        XCTAssertEqual(store.messages.count, 2)
        XCTAssertEqual(store.messages[0].role, .user)
        XCTAssertEqual(store.messages[0].text, "status?")
        XCTAssertEqual(store.messages[1].role, .failure, "the failure is shown in the transcript")
        XCTAssertFalse(store.isSending)
        XCTAssertNil(store.streamingReply)
    }

    func testBlankMessagesAreNotSent() async {
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"
        await store.send("   \n  ")
        XCTAssertTrue(store.messages.isEmpty)
    }

    func testEmptyHostReturnsToUnconfigured() async {
        let store = makeStore()
        await store.updateHost("")
        XCTAssertEqual(store.connection, .unconfigured)
    }

    func testHostWithNoStoredTokenNeedsPairing() async {
        let store = makeStore()
        await store.updateHost("mini.example-tailnet.ts.net")
        XCTAssertEqual(store.connection, .needsPairing)
        XCTAssertEqual(store.settings.host, "mini.example-tailnet.ts.net")
    }

    func testNotificationPreferenceIsPersisted() {
        let store = makeStore()
        XCTAssertTrue(store.settings.notificationsEnabled, "notifications default to on")
        store.setNotificationsEnabled(false)
        XCTAssertFalse(makeStore().settings.notificationsEnabled)
    }

    func testUnpairClearsEveryRuntimeProjection() async {
        let store = makeStore()
        store.selectedSessionKey = "agent:main:1"
        store.handle(event("chat", #"{"sessionKey":"agent:main:1","state":"final","message":"hi"}"#))
        store.handle(event("gateway.status", #"{"connected":true,"scopeCount":5}"#))
        XCTAssertFalse(store.messages.isEmpty)

        await store.unpair()

        XCTAssertEqual(store.connection, .needsPairing)
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertTrue(store.agents.isEmpty)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertTrue(store.nodes.isEmpty)
        XCTAssertNil(store.selectedSessionKey)
        XCTAssertFalse(store.gatewayConnected)
    }
}

/// Decoding of the desktop contract's projections.
final class DesktopModelDecodingTests: XCTestCase {
    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = ISO8601DateFormatter.orionFractional.date(from: text) { return date }
            if let date = ISO8601DateFormatter.orionPlain.date(from: text) { return date }
            throw DecodingError.dataCorruptedError(
                in: try decoder.singleValueContainer(),
                debugDescription: "bad date"
            )
        }
        return decoder
    }

    func testDecodesHealth() throws {
        let json = """
        {"ok":true,"reachable":true,
         "gateway":{"connected":true,"scopeCount":5,"reason":null},
         "client":{"clientId":"macbook-orion","clientName":"MacBook","expiresAt":"2026-10-10T18:00:29.324Z"},
         "serverTime":"2026-09-10T18:00:29.370Z"}
        """
        let health = try decoder().decode(DesktopHealth.self, from: Data(json.utf8))
        XCTAssertTrue(health.gateway.connected)
        XCTAssertEqual(health.gateway.scopeCount, 5)
        XCTAssertEqual(health.client.clientId, "macbook-orion")
    }

    func testDecodesNodesIncludingUnknownStatus() throws {
        let json = """
        {"nodes":[
          {"id":"n1","name":"Mac mini","platform":"macos","status":"online",
           "capabilities":["exec","screen"],"lastSeenAt":"2026-09-10T12:00:00.000Z"},
          {"id":"n2","name":"n2","platform":"windows","status":"offline","capabilities":[]},
          {"id":"n3","name":"n3","platform":"unknown","status":"unknown","capabilities":["browser"]}
        ]}
        """
        let response = try decoder().decode(NodesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.nodes.map(\.status), [.online, .offline, .unknown])
        XCTAssertEqual(response.nodes.map(\.platform), [.macos, .windows, .unknown])
        XCTAssertNil(response.nodes[1].lastSeenAt)
    }

    func testDecodesSessionsAndComputesContextUsage() throws {
        let json = """
        {"sessions":[
          {"key":"agent:codex:42","agentId":"codex","title":"Deploy review",
           "model":"anthropic/claude-opus-4","lastMessagePreview":"on it","hasActiveRun":true,
           "totalTokens":450,"contextTokens":900,"updatedAt":"2025-09-10T16:00:00.000Z"},
          {"key":"agent:main:1","agentId":"main","title":"Untitled session","model":null,
           "lastMessagePreview":null,"hasActiveRun":false,"totalTokens":null,"contextTokens":null}
        ]}
        """
        let response = try decoder().decode(SessionsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.sessions[0].contextUsage ?? 0, 0.5, accuracy: 0.001)
        XCTAssertNil(response.sessions[1].contextUsage, "usage is unknown, not zero")
        XCTAssertNil(response.sessions[1].updatedAt)
    }

    func testDecodesAgentsWithModelOptions() throws {
        let json = """
        {"agents":[{"id":"main","name":"Orion","description":null,
          "currentModel":"anthropic/claude-opus-4",
          "models":[{"id":"anthropic/claude-opus-4","label":"Opus"}]}]}
        """
        let response = try decoder().decode(AgentsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.agents.first?.models.first?.label, "Opus")
        XCTAssertNil(response.agents.first?.description)
    }

    func testCreatedSessionKeyIsFoundAtEitherDepth() throws {
        let nested = try decoder().decode(
            CreatedSessionResponse.self,
            from: Data(#"{"session":{"key":"agent:main:7"}}"#.utf8)
        )
        XCTAssertEqual(nested.sessionKey, "agent:main:7")

        let flat = try decoder().decode(
            CreatedSessionResponse.self,
            from: Data(#"{"key":"agent:main:8"}"#.utf8)
        )
        XCTAssertEqual(flat.sessionKey, "agent:main:8")

        let neither = try decoder().decode(CreatedSessionResponse.self, from: Data("{}".utf8))
        XCTAssertNil(neither.sessionKey)
    }
}
