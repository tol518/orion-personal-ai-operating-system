import XCTest
@testable import OrionKit

/// Address normalization. The plan forbids hardcoding hosts, so whatever the user types has to be
/// turned into a usable base URL without guessing at a default address.
final class BaseURLTests: XCTestCase {
    func testAddsSchemeAndDefaultPort() throws {
        let url = try OrionClient.resolveBaseURL(from: "mini.example-tailnet.ts.net")
        XCTAssertEqual(url.absoluteString, "http://mini.example-tailnet.ts.net:4820")
    }

    func testKeepsAnExplicitPort() throws {
        let url = try OrionClient.resolveBaseURL(from: "mini.example-tailnet.ts.net:9000")
        XCTAssertEqual(url.absoluteString, "http://mini.example-tailnet.ts.net:9000")
    }

    func testHonoursAnExplicitHttpsScheme() throws {
        // A user who has set up TLS on the Mini should not be downgraded, and should land on 443
        // rather than the BFF's own port — behind Tailscale Serve, 4820 is not listening.
        let url = try OrionClient.resolveBaseURL(from: "https://mini.example-tailnet.ts.net")
        XCTAssertEqual(url.absoluteString, "https://mini.example-tailnet.ts.net:443")
    }

    func testAnExplicitPortWinsOverTheSchemeDefault() throws {
        let url = try OrionClient.resolveBaseURL(from: "https://mini.example-tailnet.ts.net:8443")
        XCTAssertEqual(url.absoluteString, "https://mini.example-tailnet.ts.net:8443")
    }

    func testStripsPathAndQuery() throws {
        let url = try OrionClient.resolveBaseURL(from: "http://mini.example:4820/api/status?x=1")
        XCTAssertEqual(url.absoluteString, "http://mini.example:4820")
    }

    func testTrimsSurroundingWhitespace() throws {
        let url = try OrionClient.resolveBaseURL(from: "  mini.example  ")
        XCTAssertEqual(url.absoluteString, "http://mini.example:4820")
    }

    func testRejectsAnEmptyAddress() {
        XCTAssertThrowsError(try OrionClient.resolveBaseURL(from: "   ")) { error in
            XCTAssertEqual(error as? OrionClientError, .notConfigured)
        }
    }

    func testRejectsAnAddressWithNoHost() {
        XCTAssertThrowsError(try OrionClient.resolveBaseURL(from: "http://"))
    }
}

/// Failure mapping. The UI needs to tell "pair again" apart from "the Mini is down", so status
/// codes are translated into intent rather than shown as raw numbers.
final class FailureMappingTests: XCTestCase {
    private func response(status: Int, headers: [String: String] = [:]) -> HTTPURLResponse {
        HTTPURLResponse(
            url: URL(string: "http://mini.example:4820")!,
            statusCode: status,
            httpVersion: nil,
            headerFields: headers
        )!
    }

    func testUnauthorizedMeansPairAgain() {
        let error = OrionClient.mapFailure(status: 401, headers: response(status: 401), data: Data())
        XCTAssertEqual(error, .unauthorized)
        XCTAssertTrue(error.requiresPairing)
    }

    func testServiceUnavailableMeansDesktopAccessIsOff() {
        // The Mini answers 503 across the whole surface until a pairing secret is configured.
        let error = OrionClient.mapFailure(status: 503, headers: response(status: 503), data: Data())
        XCTAssertEqual(error, .desktopAccessDisabled)
        XCTAssertFalse(error.requiresPairing)
    }

    func testNotFoundMeansTheMiniHasNoDesktopAPI() {
        // Reachable and answering, but running a server from before native client support.
        // Reporting a bare "not found" sends the user hunting for a typo in a correct address.
        let error = OrionClient.mapFailure(status: 404, headers: response(status: 404), data: Data())
        XCTAssertEqual(error, .desktopAPIMissing)
        XCTAssertFalse(error.requiresPairing, "re-pairing cannot fix a missing endpoint")
        XCTAssertEqual(
            error.errorDescription?.contains("update the server on the Mini"),
            true
        )
    }

    func testThrottledCarriesRetryAfter() {
        let error = OrionClient.mapFailure(
            status: 429,
            headers: response(status: 429, headers: ["Retry-After": "42"]),
            data: Data()
        )
        XCTAssertEqual(error, .throttled(retryAfter: 42))
        XCTAssertEqual(error.errorDescription, "Too many attempts. Try again in 42s.")
    }

    func testThrottledWithoutAHeaderStillReads() {
        let error = OrionClient.mapFailure(status: 429, headers: response(status: 429), data: Data())
        XCTAssertEqual(error, .throttled(retryAfter: nil))
    }

    func testUsesTheServerSuppliedMessageWhenPresent() {
        let body = Data(#"{"ok":false,"error":"This device is not allowed to pair"}"#.utf8)
        let error = OrionClient.mapFailure(status: 403, headers: response(status: 403), data: body)
        XCTAssertEqual(error, .server(status: 403, message: "This device is not allowed to pair"))
    }

    func testFallsBackToAStatusDescriptionForANonJsonBody() {
        let error = OrionClient.mapFailure(
            status: 502,
            headers: response(status: 502),
            data: Data("<html>bad gateway</html>".utf8)
        )
        guard case .server(let status, let message) = error else { return XCTFail("expected .server") }
        XCTAssertEqual(status, 502)
        XCTAssertFalse(message.isEmpty)
    }
}

final class CredentialStoreTests: XCTestCase {
    func testStoresAndRemovesPerHost() throws {
        let store = InMemoryCredentialStore()
        try store.save(token: "token-a", forHost: "mini-a:4820")
        try store.save(token: "token-b", forHost: "mini-b:4820")

        XCTAssertEqual(store.token(forHost: "mini-a:4820"), "token-a")
        XCTAssertEqual(store.token(forHost: "mini-b:4820"), "token-b")
        XCTAssertNil(store.token(forHost: "unknown:4820"))

        try store.removeToken(forHost: "mini-a:4820")
        XCTAssertNil(store.token(forHost: "mini-a:4820"))
        XCTAssertEqual(store.token(forHost: "mini-b:4820"), "token-b", "one host's token is independent")
    }

    func testSavingReplacesRatherThanAppends() throws {
        let store = InMemoryCredentialStore()
        try store.save(token: "old", forHost: "mini:4820")
        try store.save(token: "new", forHost: "mini:4820")
        XCTAssertEqual(store.token(forHost: "mini:4820"), "new")
    }
}

/// Counts reads so the Keychain access pattern can be asserted.
private final class CountingCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String]
    private(set) var reads = 0

    init(tokens: [String: String] = [:]) {
        self.tokens = tokens
    }

    func token(forHost host: String) -> String? {
        lock.withLock {
            reads += 1
            return tokens[host]
        }
    }

    func save(token: String, forHost host: String) throws {
        lock.withLock { tokens[host] = token }
    }

    func removeToken(forHost host: String) throws {
        lock.withLock { tokens[host] = nil }
    }
}

/// The Keychain must be read once per host, not once per request.
///
/// Reading per request made macOS re-run its access check on every call. Unless the user chooses
/// "Always Allow", each read raises an authorization prompt — and with the event stream
/// reconnecting, the prompts arrived faster than they could be dismissed.
final class CredentialCachingTests: XCTestCase {
    func testTokenIsReadOnceAcrossManyRequests() async throws {
        let store = CountingCredentialStore(tokens: ["mini.example:4820": "token-a"])
        let client = OrionClient(credentials: store)
        try await client.configure(host: "mini.example")

        for _ in 0..<25 {
            let present = await client.hasStoredToken()
            XCTAssertTrue(present)
            // Builds an authenticated request, which is where the token is needed.
            _ = try? await client.eventStreamRequest()
        }
        XCTAssertEqual(store.reads, 1, "the Keychain should be consulted once, not once per call")
    }

    func testSwitchingMiniDoesNotReuseThePreviousToken() async throws {
        let store = CountingCredentialStore(tokens: [
            "mini-a.example:4820": "token-a",
            "mini-b.example:4820": "token-b",
        ])
        let client = OrionClient(credentials: store)

        try await client.configure(host: "mini-a.example")
        let first = try await client.eventStreamRequest()
        XCTAssertEqual(first.value(forHTTPHeaderField: "Authorization"), "Bearer token-a")

        try await client.configure(host: "mini-b.example")
        let second = try await client.eventStreamRequest()
        XCTAssertEqual(
            second.value(forHTTPHeaderField: "Authorization"),
            "Bearer token-b",
            "a different Mini must not reuse the previous host's token"
        )
        XCTAssertEqual(store.reads, 2, "one read per host")
    }

    func testForgettingPairingDropsTheCachedToken() async throws {
        let store = CountingCredentialStore(tokens: ["mini.example:4820": "token-a"])
        let client = OrionClient(credentials: store)
        try await client.configure(host: "mini.example")
        let before = await client.hasStoredToken()
        XCTAssertTrue(before)

        try await client.forgetPairing()
        let after = await client.hasStoredToken()
        XCTAssertFalse(after, "the in-memory copy must not outlive the stored one")
    }

    func testAnUnpairedHostReportsNoToken() async throws {
        let store = CountingCredentialStore()
        let client = OrionClient(credentials: store)
        try await client.configure(host: "mini.example")
        let missing = await client.hasStoredToken()
        XCTAssertFalse(missing)
        // A miss is not cached, so pairing later is picked up.
        try store.save(token: "fresh", forHost: "mini.example:4820")
        let found = await client.hasStoredToken()
        XCTAssertTrue(found)
    }
}

final class ClientIdentityTests: XCTestCase {
    func testGeneratedClientIdIsSafeAndSuffixed() {
        let id = SettingsStore.generateClientId()
        // The Mini validates client ids against /^[a-z0-9][a-z0-9_-]{0,63}$/i.
        XCTAssertNotNil(
            id.range(of: "^[a-z0-9][a-z0-9_-]{0,63}$", options: .regularExpression),
            "generated id \(id) would be rejected by the Mini"
        )
    }

    func testGeneratedClientIdsDifferBetweenRuns() {
        // Two Macs with the same name must not collide in the Mini's allowlist.
        XCTAssertNotEqual(SettingsStore.generateClientId(), SettingsStore.generateClientId())
    }
}

private final class ChatRequestStub: URLProtocol {
    static var status = 200
    static var respond: ((URLRequest) -> String)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let json = Self.respond?(request) ?? "{}"
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ChatRequestTests: XCTestCase {
    func testWorkspaceRequests() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatRequestStub.self]
        let credentials = InMemoryCredentialStore()
        try credentials.save(token: "test-token", forHost: "mini.example:4820")
        let client = OrionClient(credentials: credentials, session: URLSession(configuration: config))
        try await client.configure(host: "mini.example")
        defer { ChatRequestStub.respond = nil }
        func check(_ method: String, _ path: String, _ body: [String: Any]? = nil, reply: String = "{}",
                   action: () async throws -> Void) async throws {
            let received = expectation(description: path)
            ChatRequestStub.respond = { request in
                XCTAssertEqual(request.url?.absoluteString, "http://mini.example:4820/api/v1/desktop/" + path)
                XCTAssertEqual(request.httpMethod, method)
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
                var data = request.httpBody ?? Data()
                if let stream = request.httpBodyStream {
                    stream.open()
                    defer { stream.close() }
                    var buffer = [UInt8](repeating: 0, count: 1024)
                    while true {
                        let n = stream.read(&buffer, maxLength: buffer.count)
                        if n <= 0 { break }
                        data.append(contentsOf: buffer.prefix(n))
                    }
                }
                if let body {
                    let object = (try? JSONSerialization.jsonObject(with: data)) as? NSDictionary
                    XCTAssertEqual(object, body as NSDictionary)
                } else { XCTAssertTrue(data.isEmpty) }
                received.fulfill()
                return reply
            }
            try await action()
            await fulfillment(of: [received], timeout: 2)
        }

        let key = "agent:a/b"
        let route = "sessions/agent%3Aa%2Fb"
        try await check("GET", "sessions?limit=30&archived=1", reply: #"{"sessions":[]}"#) {
            _ = try await client.sessions(archived: true)
        }
        try await check("GET", route + "/history", reply: #"{"messages":[]}"#) { _ = try await client.transcript(key) }
        try await check("GET", "agents/a%2Fb/models", reply: #"{"models":[]}"#) { _ = try await client.models("a/b") }
        try await check("GET", route + "/execution-target", reply: #"{"target":"neutral","devices":{}}"#) {
            _ = try await client.target(key)
        }
        let changes: [(SessionChange, String, String, [String: Any]?)] = [
            (.rename("new"), "PATCH", "", ["label": "new"]),
            (.thinking("low"), "PUT", "/thinking", ["level": "low"]),
            (.model("m", agent: "a"), "PUT", "/model", ["model": "m", "agentId": "a"]),
            (.target("neutral", agent: "a"), "PUT", "/execution-target", ["target": "neutral", "agentId": "a"]),
            (.archive(true), "PUT", "/archive", ["archived": true]),
            (.archive(false), "PUT", "/archive", ["archived": false]),
            (.compact, "POST", "/compact", nil),
            (.reset("a"), "POST", "/reset", ["agentId": "a"]),
            (.delete("a"), "DELETE", "", ["agentId": "a"])
        ]
        for (change, method, suffix, body) in changes {
            try await check(method, route + suffix, body) { try await client.update(key, change) }
        }
        try await check("GET", "approvals", reply: #"{"approvals":[]}"#) { _ = try await client.approvals() }
        try await check("POST", "approvals/a%2Fb", ["decision": "allow-once"]) {
            try await client.resolve("a/b", decision: "allow-once")
        }
        try await check("POST", "chat/abort", ["sessionKey": key, "runId": "r"], reply: #"{"aborted":true}"#) {
            _ = try await client.abort(key, run: "r")
        }
        try await check("POST", "chat/abort", ["sessionKey": key], reply: #"{"ok":true,"aborted":false}"#) {
            let stopped = try await client.abort(key, run: nil)
            XCTAssertFalse(stopped)
        }
        try await check("POST", "attachments", ["attachments": [["fileName": "x.txt", "mimeType": "text/plain", "content": "eA=="]]],
                        reply: #"{"attachments":[{"id":"f"}]}"#) {
            let ids = try await client.upload([ChatAttachment(fileName: "x.txt", mimeType: "text/plain", content: Data("x".utf8))])
            XCTAssertEqual(ids, ["f"])
        }
        try await check("POST", "chat", ["message": "next", "sessionKey": key, "agentId": "a", "mode": "steer", "attachmentIds": ["f"]],
                        reply: #"{"delivered":"steer","ack":{"runId":"next"}}"#) {
            let result = try await client.sendChat(sessionKey: key, message: "next", agentId: "a", attachmentIds: ["f"], mode: "steer")
            XCTAssertEqual(result.ack?.runId, "next")
        }
    }
}

extension ChatRequestTests {
    @MainActor
    func testFailedSubmissionKeepsOriginalSessionDraftAndRunningReply() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatRequestStub.self]
        let credentials = InMemoryCredentialStore()
        try credentials.save(token: "token", forHost: "mini.example:4820")
        let client = OrionClient(credentials: credentials, session: URLSession(configuration: config))
        try await client.configure(host: "mini.example")
        let suite = "app.orion.tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = OrionStore(client: client, settingsStore: SettingsStore(defaults: defaults), notifier: SilentNotifier())
        store.selectedSessionKey = "s"
        store.handle(ServerSentEvent(name: "chat", data: #"{"runId":"r","sessionKey":"s","state":"delta","deltaText":"working"}"#))
        let file = ChatAttachment(fileName: "note.txt", mimeType: "text/plain", content: Data("one".utf8))
        store.drafts["s"] = ChatDraft(text: "follow", files: [file])
        defer { ChatRequestStub.respond = nil; ChatRequestStub.status = 200 }
        for failUpload in [true, false] {
            ChatRequestStub.respond = { request in
                if request.url?.lastPathComponent == "attachments", !failUpload {
                    ChatRequestStub.status = 200
                    return #"{"attachments":[{"id":"uploaded"}]}"#
                }
                ChatRequestStub.status = 400
                return #"{"ok":false,"error":"Request refused"}"#
            }
            await store.sendDraft(for: "s")
            XCTAssertEqual(store.drafts["s"]?.text, "follow")
            XCTAssertEqual(store.drafts["s"]?.files.map(\.id), [file.id])
            XCTAssertEqual(store.drafts["s"]?.error, "Request refused")
            XCTAssertTrue(store.messages.isEmpty)
            XCTAssertEqual(store.streamingReply, "working")
            XCTAssertEqual(store.conversation.current, "r")
            XCTAssertNil(store.conversation.steering)
        }
    }
}
