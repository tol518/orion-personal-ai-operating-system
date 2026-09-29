import XCTest
@testable import OrionKit

final class TailnetPolicyModelTests: XCTestCase {
    private func finding(_ json: String) throws -> SecurityFinding {
        try JSONDecoder().decode(SecurityFinding.self, from: Data(json.utf8))
    }

    func testAnOpenTailnetOffersThePolicyAndNeverAButtonThatApplies() throws {
        let open = try finding("""
        {"id":"tailnet-open","severity":"warning","title":"Every device on your tailnet can reach this Mac mini",
         "detail":"d","target":null,
         "remediation":{"id":"restrict-tailnet-policy","title":"t","summary":"s","automatic":false,
           "shell":null,"command":null,"rollback":null}}
        """)
        XCTAssertTrue(open.offersTailnetPolicy)
        XCTAssertFalse(open.isFixable, "Orion writes the policy; it must never offer to apply it")
        XCTAssertTrue(open.needsAttention)
    }

    func testOtherFindingsDoNotOfferThePolicy() throws {
        let unchecked = try finding("""
        {"id":"tailnet-unchecked","severity":"info","title":"t","detail":"d","target":null,"remediation":null}
        """)
        XCTAssertFalse(unchecked.offersTailnetPolicy)
        XCTAssertTrue(unchecked.needsAttention, "a blind spot is not a clean result")
    }

    func testDecodesAGeneratedPolicy() throws {
        let policy = try JSONDecoder().decode(TailnetPolicy.self, from: Data("""
        {"ok":true,"policy":"// Orion tailnet policy\\n{}","requesterIdentified":false,
         "clients":["macbook","iphone"],"excluded":[{"name":"old-macbook","reason":"offline since 2026-08-01"}],
         "generatedAt":"2026-09-29T00:00:00.000Z"}
        """.utf8))
        XCTAssertFalse(policy.requesterIdentified)
        XCTAssertEqual(policy.clients, ["macbook", "iphone"])
        XCTAssertEqual(policy.excluded.first?.reason, "offline since 2026-08-01")
        XCTAssertTrue(policy.policy.hasPrefix("// Orion tailnet policy"))
    }
}

final class TailnetAddressTests: XCTestCase {
    func testRecognisesOnlyTailscaleRanges() {
        for address in ["100.64.0.1", "100.127.255.255", "100.100.12.34", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0::AB:CD"] {
            XCTAssertTrue(TailnetAddresses.isTailnet(address), address)
        }
        for address in [
            "100.63.255.255", "100.128.0.1", "10.0.0.1", "192.168.1.20", "127.0.0.1",
            "100.64.0", "100.64.0.1.5", "100.300.0.1", "fd7a:115c:a1e1::1", "fe80::1", "",
        ] {
            XCTAssertFalse(TailnetAddresses.isTailnet(address), address)
        }
    }

    func testKeepsTailnetAddressesOnceAndInOrder() {
        XCTAssertEqual(
            TailnetAddresses.tailnet(from: ["192.168.1.20", "100.64.10.20", "fe80::1", "fd7a:115c:a1e0::10:20", "100.64.10.20"]),
            ["100.64.10.20", "fd7a:115c:a1e0::10:20"]
        )
    }

    func testTheLiveReadingReturnsOnlyTailnetAddresses() {
        // Machine-dependent: may be empty without Tailscale, but must never include anything else.
        XCTAssertTrue(TailnetAddresses.current().allSatisfy(TailnetAddresses.isTailnet))
    }
}

@MainActor
final class TailnetPolicyStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var opened: [URL] = []

    override func setUp() {
        super.setUp()
        suiteName = "app.orion.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        opened = []
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
            opener: { [weak self] url in
                self?.opened.append(url)
                return true
            }
        )
    }

    func testAFailedRequestReportsWhyAndClearsTheLoadingFlag() async {
        let store = makeStore()
        await store.loadTailnetPolicy(addresses: ["100.64.0.2"])
        XCTAssertNil(store.tailnetPolicy)
        XCTAssertNotNil(store.tailnetPolicyError)
        XCTAssertFalse(store.isLoadingTailnetPolicy)

        store.dismissTailnetPolicy()
        XCTAssertNil(store.tailnetPolicyError)
    }

    func testOpensTheFixedAdminPageAndNothingElse() {
        let store = makeStore()
        store.openTailnetAccessControls()
        XCTAssertEqual(opened, [URL(string: "https://login.tailscale.com/admin/acls")!])
    }
}
