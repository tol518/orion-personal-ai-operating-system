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
        // A user who has set up TLS on the Mini should not be downgraded.
        let url = try OrionClient.resolveBaseURL(from: "https://mini.example-tailnet.ts.net")
        XCTAssertEqual(url.absoluteString, "https://mini.example-tailnet.ts.net:4820")
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
