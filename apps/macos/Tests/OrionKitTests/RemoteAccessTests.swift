import XCTest
@testable import OrionKit

/// URL construction from a session grant.
///
/// These matter more than most: the result is handed to the window server to launch an
/// application, so a compromised or buggy Mini must not be able to choose an arbitrary URL.
/// That is why the server returns parts and the client assembles and validates them.
final class RemoteLauncherTests: XCTestCase {
    /// Built directly rather than through JSON: a control character in a host makes the JSON
    /// fixture itself invalid, so the decoder would throw before validation ever ran.
    private func grant(
        host: String = "mac-mini.tail0000.ts.net",
        port: Int = 5900,
        scheme: String = "vnc"
    ) -> RemoteSessionGrant {
        RemoteSessionGrant(host: host, port: port, scheme: scheme, service: "screen-sharing")
    }

    func testBuildsAScreenSharingURL() throws {
        let url = try RemoteLauncher.url(for: grant())
        XCTAssertEqual(url.absoluteString, "vnc://mac-mini.tail0000.ts.net:5900")
    }

    func testBuildsAnRDPURL() throws {
        let url = try RemoteLauncher.url(for: grant(host: "pc.tail0000.ts.net", port: 3389, scheme: "rdp"))
        XCTAssertEqual(url.absoluteString, "rdp://pc.tail0000.ts.net:3389")
    }

    func testAcceptsAnIPAddress() throws {
        let url = try RemoteLauncher.url(for: grant(host: "100.64.1.5"))
        XCTAssertEqual(url.absoluteString, "vnc://100.64.1.5:5900")
    }

    func testSchemeMatchingIsCaseInsensitive() throws {
        XCTAssertEqual(try RemoteLauncher.url(for: grant(scheme: "VNC")).scheme, "vnc")
    }

    func testRejectsAnySchemeOutsideTheAllowlist() throws {
        // The dangerous cases: anything that could run code or exfiltrate rather than view a screen.
        for scheme in ["file", "ssh", "http", "javascript", "smb", "ftp", "x-apple-script", "shortcuts"] {
            XCTAssertThrowsError(try RemoteLauncher.url(for: grant(scheme: scheme))) { error in
                XCTAssertEqual(
                    error as? RemoteLauncher.LaunchError,
                    .unsupportedScheme(scheme),
                    "\(scheme) must not be launchable"
                )
            }
        }
    }

    func testRejectsAHostCarryingAPathQueryOrCredentials() throws {
        for host in [
            "host/../../etc/passwd",
            "host?x=1",
            "user:password@host",
            "host:22",
            "host evil",
            "host\nevil",
            "host\revil",
            "host\u{0}evil",
            "-leading-dash.example",
            "",
            "host..double-dot",
        ] {
            XCTAssertThrowsError(try RemoteLauncher.url(for: grant(host: host))) { error in
                XCTAssertEqual(
                    error as? RemoteLauncher.LaunchError,
                    .invalidHost(host),
                    "host “\(host)” must be refused"
                )
            }
        }
    }

    func testHostValidationRejectsControlCharactersAndOddLabels() {
        // Regression: an anchored regex let a value with an embedded newline through, because
        // ICU's `$` does not anchor a whole-string check when a line separator is present.
        for host in ["host\nevil", "host\revil", "host\u{0}evil", "host\tevil", "a..b", ".host", "host.", "-x.example", "x-.example"] {
            XCTAssertFalse(RemoteLauncher.isValidHost(host), "“\(host)” must be refused")
        }
        for host in ["mac-mini.tail0000.ts.net", "100.64.1.5", "localhost", "a"] {
            XCTAssertTrue(RemoteLauncher.isValidHost(host), "“\(host)” should be accepted")
        }
        XCTAssertFalse(RemoteLauncher.isValidHost(""), "an empty host is not valid")
        XCTAssertFalse(
            RemoteLauncher.isValidHost(String(repeating: "a", count: 254)),
            "an over-long host is not valid"
        )
        XCTAssertFalse(
            RemoteLauncher.isValidHost(String(repeating: "a", count: 64) + ".example"),
            "an over-long label is not valid"
        )
    }

    func testRejectsAnOutOfRangePort() throws {
        for port in [0, -1, 70_000] {
            XCTAssertThrowsError(try RemoteLauncher.url(for: grant(port: port))) { error in
                XCTAssertEqual(error as? RemoteLauncher.LaunchError, .invalidPort(port))
            }
        }
    }

    func testNamesTheApplicationAGivenSchemeOpens() {
        XCTAssertEqual(RemoteLauncher.targetApplication(forScheme: "vnc"), "Screen Sharing")
        XCTAssertEqual(RemoteLauncher.targetApplication(forScheme: "rdp"), "Windows App")
        XCTAssertNil(RemoteLauncher.targetApplication(forScheme: "ssh"))
    }

    func testAllowlistIsExactlyTheTwoViewerSchemes() {
        // A guard against quietly widening what this app will launch.
        XCTAssertEqual(Set(RemoteLauncher.allowedSchemes.keys), ["vnc", "rdp"])
    }
}

final class RemoteAccessDecodingTests: XCTestCase {
    func testDecodesNodesAndFiltersLaunchableServices() throws {
        let json = """
        {"nodes":[
          {"nodeId":"node-mini","host":"mac-mini.tail0000.ts.net","hostSource":"tailnet","hint":null,
           "services":[
             {"kind":"screen-sharing","label":"Screen Sharing","port":5900,"scheme":"vnc","launchable":true,"reachable":true},
             {"kind":"apple-remote-desktop","label":"Apple Remote Desktop","port":3283,"scheme":null,"launchable":false,"reachable":true}
           ]},
          {"nodeId":"node-ghost","host":null,"hostSource":"unresolved","hint":"No address for this node.","services":[]}
        ]}
        """
        let response = try JSONDecoder().decode(RemoteAccessResponse.self, from: Data(json.utf8))

        let mini = response.nodes[0]
        XCTAssertTrue(mini.hasAnyReachableService)
        // ARD is reachable but not launchable, so it must not become a Connect button.
        XCTAssertEqual(mini.launchableServices.map(\.kind), ["screen-sharing"])

        let ghost = response.nodes[1]
        XCTAssertNil(ghost.host)
        XCTAssertFalse(ghost.hasAnyReachableService)
        XCTAssertTrue(ghost.launchableServices.isEmpty)
        XCTAssertNotNil(ghost.hint)
    }

    func testAnUnreachableServiceIsNotLaunchable() throws {
        let json = """
        {"nodes":[{"nodeId":"n","host":"h.example","hostSource":"configured","hint":null,
          "services":[{"kind":"screen-sharing","label":"Screen Sharing","port":5900,"scheme":"vnc","launchable":true,"reachable":false}]}]}
        """
        let response = try JSONDecoder().decode(RemoteAccessResponse.self, from: Data(json.utf8))
        XCTAssertTrue(response.nodes[0].launchableServices.isEmpty, "an unreachable port offers no button")
        XCTAssertFalse(response.nodes[0].hasAnyReachableService)
    }
}

@MainActor
final class RemoteSessionStoreTests: XCTestCase {
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

    func testAFailedGrantSurfacesAnErrorAndOpensNothing() async {
        var opened: [URL] = []
        let store = OrionStore(
            client: OrionClient(credentials: InMemoryCredentialStore()),
            settingsStore: SettingsStore(defaults: defaults),
            notifier: SilentNotifier(),
            opener: { url in
                opened.append(url)
                return true
            }
        )
        // No host configured, so the grant request fails before anything could be launched.
        await store.openRemoteSession(nodeId: "node-mini", kind: "screen-sharing")

        XCTAssertTrue(opened.isEmpty, "nothing may be launched when the grant fails")
        XCTAssertNotNil(store.lastError)
        XCTAssertNil(store.launchingNodeId, "the launching flag must be cleared")
    }

    func testRemoteAccessStartsEmptyAndReportsUnavailability() async {
        let store = OrionStore(
            client: OrionClient(credentials: InMemoryCredentialStore()),
            settingsStore: SettingsStore(defaults: defaults),
            notifier: SilentNotifier(),
            opener: { _ in true }
        )
        XCTAssertTrue(store.remoteAccess.isEmpty)
        await store.refreshRemoteAccess()
        XCTAssertTrue(store.remoteAccess.isEmpty)
        XCTAssertNotNil(store.remoteAccessUnavailable)
        XCTAssertNil(store.remoteAccess(for: "node-mini"))
    }
}
