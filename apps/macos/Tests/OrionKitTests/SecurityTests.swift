import XCTest
@testable import OrionKit

final class SecurityFindingTests: XCTestCase {
    private func findings(_ json: String) throws -> [SecurityFinding] {
        try JSONDecoder().decode(SecurityResponse.self, from: Data(json.utf8)).findings
    }

    private let fixable = """
    {"findings":[{"id":"exposure:node-pc:remote-desktop","severity":"warning",
      "title":"Remote Desktop on Windows PC answers beyond your private network",
      "detail":"Port 3389 is listening on every network interface.",
      "target":{"nodeId":"node-pc","kind":"remote-desktop","port":3389,"platform":"windows","label":"Windows PC"},
      "remediation":{"id":"scope-rdp-to-tailnet","title":"Restrict Remote Desktop",
        "summary":"Scopes the firewall.","automatic":true,"shell":"powershell",
        "command":"Set-NetFirewallRule ...","rollback":"Set-NetFirewallRule -RemoteAddress Any","blocked":null}}]}
    """

    func testDecodesAFixableFinding() throws {
        let finding = try XCTUnwrap(try findings(fixable).first)
        XCTAssertEqual(finding.severity, .warning)
        XCTAssertTrue(finding.isFixable)
        XCTAssertTrue(finding.needsAttention)
        XCTAssertEqual(finding.target?.platform, "windows")
        XCTAssertEqual(finding.remediation?.command, "Set-NetFirewallRule ...")
    }

    func testAManualRemediationIsNotFixable() throws {
        // macOS Screen Sharing: reported, explained, but no button — there is no command.
        let list = try findings("""
        {"findings":[{"id":"exposure:orion-mini:screen-sharing","severity":"warning",
          "title":"Screen Sharing on this Mac mini answers beyond your private network","detail":"d",
          "target":{"nodeId":"orion-mini","kind":"screen-sharing","port":5900,"platform":"macos","label":"this Mac mini"},
          "remediation":{"id":"restrict-screen-sharing-manually","title":"t",
            "summary":"macOS Screen Sharing has no bind setting.","automatic":false,"shell":null,
            "command":null,"rollback":null,"blocked":null}}]}
        """)
        XCTAssertFalse(list[0].isFixable)
        XCTAssertTrue(list[0].needsAttention)
    }

    func testABlockedRemediationIsNotFixableAndSaysWhy() throws {
        let list = try findings("""
        {"findings":[{"id":"exposure:machine:pc:remote-desktop","severity":"warning","title":"t","detail":"d",
          "target":{"nodeId":"machine:pc","kind":"remote-desktop","port":3389,"platform":"windows","label":"PC"},
          "remediation":{"id":"scope-rdp-to-tailnet","title":"t","summary":"s","automatic":false,
            "shell":"powershell","command":"Set-NetFirewallRule ...","rollback":null,
            "blocked":"This machine is configured by address only."}}]}
        """)
        XCTAssertFalse(list[0].isFixable, "automatic:false wins even though a command is present")
        XCTAssertNotNil(list[0].remediation?.blocked)
    }

    func testAPassingCheckNeedsNoAttention() throws {
        let list = try findings("""
        {"findings":[{"id":"api-auth","severity":"ok","title":"Orion's API requires a password",
          "detail":"d","target":null,"remediation":null}]}
        """)
        XCTAssertFalse(list[0].needsAttention)
        XCTAssertFalse(list[0].isFixable)
    }

    func testACriticalFindingWithNoRemediationIsStillSurfaced() throws {
        // An ungated API is the worst finding, and deliberately has no button: Orion editing its
        // own .env and restarting itself is not a button press.
        let list = try findings("""
        {"findings":[{"id":"api-auth","severity":"critical",
          "title":"Orion's API accepts anyone who can reach it","detail":"d","target":null,"remediation":null}]}
        """)
        XCTAssertEqual(list[0].severity, .critical)
        XCTAssertTrue(list[0].needsAttention)
        XCTAssertFalse(list[0].isFixable)
    }

    func testDecodesARemediationResult() throws {
        let result = try JSONDecoder().decode(
            RemediationResult.self,
            from: Data(#"{"applied":true,"remediation":"scope-rdp-to-tailnet","rollback":"undo cmd","verified":"100.64.0.0/10"}"#.utf8)
        )
        XCTAssertTrue(result.applied)
        XCTAssertEqual(result.verified, "100.64.0.0/10")
    }

    func testAnUnverifiedResultIsRepresentable() throws {
        // Applied but unconfirmed must be distinguishable from applied and confirmed.
        let result = try JSONDecoder().decode(
            RemediationResult.self,
            from: Data(#"{"applied":true,"remediation":"r","rollback":null,"verified":null}"#.utf8)
        )
        XCTAssertTrue(result.applied)
        XCTAssertNil(result.verified)
    }
}

@MainActor
final class SecurityStoreTests: XCTestCase {
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

    private func makeStore() -> OrionStore {
        OrionStore(
            client: OrionClient(credentials: InMemoryCredentialStore()),
            settingsStore: SettingsStore(defaults: defaults),
            notifier: SilentNotifier(),
            opener: { _ in true }
        )
    }

    func testFindingsStartEmptyAndReportUnavailability() async {
        let store = makeStore()
        XCTAssertTrue(store.findings.isEmpty)
        await store.refreshSecurity()
        XCTAssertTrue(store.findings.isEmpty)
        XCTAssertNotNil(store.securityUnavailable)
        XCTAssertFalse(store.isLoadingFindings, "the loading flag must be cleared")
    }

    func testApplyingIsARequestNotALocalAction() async {
        // Nothing runs locally: the fix is a request to the Mini, which fails here with no host.
        let store = makeStore()
        let json = """
        {"id":"exposure:node-pc:remote-desktop","severity":"warning","title":"t","detail":"d",
         "target":{"nodeId":"node-pc","kind":"remote-desktop","port":3389,"platform":"windows","label":"PC"},
         "remediation":{"id":"scope-rdp-to-tailnet","title":"t","summary":"s","automatic":true,
           "shell":"powershell","command":"cmd","rollback":"undo","blocked":null}}
        """
        let finding = try! JSONDecoder().decode(SecurityFinding.self, from: Data(json.utf8))
        await store.applyRemediation(for: finding)
        XCTAssertNotNil(store.lastError)
        XCTAssertNil(store.lastRemediation)
        XCTAssertNil(store.remediatingFindingId, "the applying flag must be cleared")
    }

    func testANonFixableFindingIsNeverSubmitted() async {
        let store = makeStore()
        let json = """
        {"id":"api-auth","severity":"critical","title":"t","detail":"d","target":null,"remediation":null}
        """
        let finding = try! JSONDecoder().decode(SecurityFinding.self, from: Data(json.utf8))
        await store.applyRemediation(for: finding)
        XCTAssertNil(store.lastError, "nothing should have been attempted")
        XCTAssertNil(store.remediatingFindingId)
    }
}
