import AppKit
import Foundation
import Observation

public enum ConnectionState: Equatable, Sendable {
    /// No Mini address has been entered yet.
    case unconfigured
    /// An address is set but this Mac holds no valid desktop token.
    case needsPairing
    case connecting
    case connected(DesktopHealth)
    case failed(String)

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }

    public var health: DesktopHealth? {
        if case .connected(let health) = self { return health }
        return nil
    }
}

/// The app's single source of truth.
///
/// Everything the UI shows comes from the Mini through `OrionClient`; this type holds no runtime
/// state of its own beyond what is on screen. It does not cache agents or sessions to disk,
/// because the Mini is the authoritative runtime and a stale local copy would misrepresent it.
@MainActor
@Observable
public final class OrionStore {
    // MARK: Connection
    public private(set) var connection: ConnectionState = .unconfigured
    public private(set) var gatewayConnected = false
    public private(set) var gatewayReason: String?

    // MARK: Read models
    public private(set) var agents: [DesktopAgent] = []
    public private(set) var sessions: [DesktopSession] = []
    public private(set) var nodes: [DesktopNode] = []
    /// Remote-desktop availability per node. Empty when the Mini has no discovery configured.
    public private(set) var remoteAccess: [RemoteAccessNode] = []
    /// The Mini's own entry. Present even when it is not a paired execution node.
    public private(set) var miniRemoteAccess: RemoteAccessNode?
    /// Machines configured on the Mini, independent of the gateway's node list.
    public private(set) var remoteMachines: [RemoteMachine] = []

    // MARK: Security
    public private(set) var findings: [SecurityFinding] = []
    public private(set) var isLoadingFindings = false
    public private(set) var securityUnavailable: String?
    public private(set) var remediatingFindingId: String?
    /// Set after a fix lands, so the screen can say what happened and how to undo it.
    public private(set) var lastRemediation: (finding: String, result: RemediationResult)?
    public private(set) var tailnetPolicy: TailnetPolicy?
    public private(set) var isLoadingTailnetPolicy = false
    public private(set) var tailnetPolicyError: String?

    /// Findings the user should act on. The passing checks stay available for the full list.
    public var openFindings: [SecurityFinding] { findings.filter(\.needsAttention) }

    // MARK: Usage
    public private(set) var usage: UsageSummary?
    public private(set) var usageRange = "7d"
    public private(set) var isLoadingUsage = false
    public private(set) var usageUnavailable: String?
    public private(set) var remoteAccessUnavailable: String?
    public private(set) var launchingNodeId: String?

    // MARK: Chat
    public internal(set) var selectedSessionKey: String?
    var conversation = ConversationState()
    public var messages: [ChatMessage] { conversation.messages }
    public var streamingReply: String? { conversation.partial }
    public var isSending: Bool { conversation.busy }
    var inbox = ApprovalInbox()
    var archivedSessions: [DesktopSession] = []
    var showingArchived = false
    private var lastActiveSession: String?
    var visibleSessions: [DesktopSession] { showingArchived ? archivedSessions : sessions }
    var selectedSession: DesktopSession? { (sessions + archivedSessions).first { $0.key == selectedSessionKey } }
    var chatModels: ChatModels?
    var executionTarget: ChatTarget?
    var drafts: [String: ChatDraft] = [:]
    var submitting: Set<String> = []
    var changingSessions: Set<String> = []
    private var sessionRevision = 0
    private var approvalExpiry: Task<Void, Never>?
    public private(set) var isLoadingTranscript = false

    // MARK: Surfaced problems
    public private(set) var lastError: String?
    public private(set) var pairingError: String?

    public var settings: OrionSettings

    private let client: OrionClient
    private let settingsStore: SettingsStore
    private let notifier: Notifying
    private let opener: @MainActor (URL) -> Bool
    private var streamTask: Task<Void, Never>?
    private var reconnectAttempt = 0
    /// Guards against a late history load overwriting a newer session's transcript.
    private var transcriptGeneration = 0

    public init(
        client: OrionClient = OrionClient(),
        settingsStore: SettingsStore = SettingsStore(),
        notifier: Notifying = SystemNotifier(),
        opener: @escaping @MainActor (URL) -> Bool = { NSWorkspace.shared.open($0) }
    ) {
        self.client = client
        self.settingsStore = settingsStore
        self.notifier = notifier
        self.opener = opener
        self.settings = settingsStore.load()
    }

    public func makeFileBrowser() -> FileBrowserStore { FileBrowserStore(client: client) }

    // MARK: - Lifecycle

    /// Restores a previous connection on launch, or stops at the screen the user needs to act on.
    public func start() async {
        await notifier.requestAuthorizationIfNeeded()
        guard !settings.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            connection = .unconfigured
            return
        }
        do {
            try await client.configure(host: settings.host)
        } catch {
            connection = .failed(OrionClientError.notConfigured.localizedDescription)
            return
        }
        guard await client.hasStoredToken() else {
            connection = .needsPairing
            return
        }
        await connect()
    }

    /// Verifies the connection, loads the V1 read models, and starts the event stream.
    public func connect() async {
        connection = .connecting
        do {
            let health = try await client.health()
            connection = .connected(health)
            gatewayConnected = health.gateway.connected
            gatewayReason = health.gateway.reason
            reconnectAttempt = 0
            await refreshAll()
            startEventStream()
        } catch let error as OrionClientError {
            handleConnectionFailure(error)
        } catch {
            connection = .failed(error.localizedDescription)
        }
    }

    public func disconnect() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func handleConnectionFailure(_ error: OrionClientError) {
        // A revoked or expired pairing is not a transport failure: sending the user to the
        // pairing screen is the only useful response.
        connection = error.requiresPairing ? .needsPairing : .failed(error.localizedDescription)
        if case .needsPairing = connection { pairingError = error.localizedDescription }
    }

    // MARK: - Pairing

    public func updateHost(_ host: String) async {
        settings.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        settingsStore.save(settings)
        pairingError = nil
        guard !settings.host.isEmpty else {
            connection = .unconfigured
            return
        }
        do {
            try await client.configure(host: settings.host)
            connection = await client.hasStoredToken() ? .connecting : .needsPairing
            if connection == .connecting { await connect() }
        } catch {
            connection = .failed(OrionClientError.notConfigured.localizedDescription)
        }
    }

    /// Exchanges the pairing secret for a token. The secret is not retained after this call.
    public func pair(withSecret secret: String) async {
        pairingError = nil
        guard !settings.host.isEmpty else {
            pairingError = OrionClientError.notConfigured.localizedDescription
            return
        }
        do {
            try await client.configure(host: settings.host)
            _ = try await client.pair(
                pairingSecret: secret,
                clientId: settings.clientId,
                clientName: settings.clientName
            )
            settingsStore.save(settings)
            await connect()
        } catch let error as OrionClientError {
            pairingError = error.localizedDescription
        } catch {
            pairingError = error.localizedDescription
        }
    }

    /// Revokes this Mac's token on the Mini and returns to the pairing screen.
    public func unpair() async {
        disconnect()
        try? await client.unpair()
        agents = []
        sessions = []
        nodes = []
        remoteAccess = []
        miniRemoteAccess = nil
        remoteMachines = []
        findings = []
        lastRemediation = nil
        tailnetPolicy = nil
        tailnetPolicyError = nil
        usage = nil
        transcriptGeneration += 1
        conversation = ConversationState()
        drafts = [:]
        approvalExpiry?.cancel()
        inbox = ApprovalInbox()
        archivedSessions = []
        selectedSessionKey = nil
        gatewayConnected = false
        connection = .needsPairing
    }

    public func setNotificationsEnabled(_ enabled: Bool) {
        settings.notificationsEnabled = enabled
        settingsStore.save(settings)
    }

    // MARK: - Read models

    public func refreshAll() async {
        // Independent reads, so one slow or failing projection does not delay the others.
        async let agentList = try? client.agents()
        async let sessionList = try? client.sessions()
        async let nodeList = try? client.nodes()
        let (loadedAgents, loadedSessions, loadedNodes) = await (agentList, sessionList, nodeList)

        if let loadedAgents { agents = loadedAgents }
        if let loadedSessions { sessions = loadedSessions }
        if let loadedNodes { nodes = loadedNodes }
        await refreshRemoteAccess()
        // The gateway being down is the usual reason all three fail at once; the health check and
        // the event stream already report that, so this only surfaces a partial failure.
        if loadedAgents == nil && loadedSessions == nil && loadedNodes == nil && gatewayConnected {
            lastError = "The Mini answered but returned no agents, sessions, or nodes."
        }
    }

    public func refreshNodes() async {
        guard let loaded = try? await client.nodes() else { return }
        nodes = loaded
        await refreshRemoteAccess()
    }

    /// Reads remote-desktop availability. A Mini without discovery configured answers 503, which
    /// is a configuration state to explain rather than an error to alarm the user with.
    public func refreshRemoteAccess() async {
        do {
            let result = try await client.remoteAccess()
            miniRemoteAccess = result.mini
            remoteMachines = result.machines
            remoteAccess = result.nodes
            remoteAccessUnavailable = nil
        } catch let error as OrionClientError {
            remoteAccess = []
            miniRemoteAccess = nil
            remoteMachines = []
            switch error {
            case .desktopAccessDisabled, .desktopAPIMissing:
                remoteAccessUnavailable = "This Mini does not offer remote-desktop discovery yet."
            case .server(503, let message):
                remoteAccessUnavailable = message
            default:
                remoteAccessUnavailable = error.localizedDescription
            }
        } catch {
            remoteAccess = []
            miniRemoteAccess = nil
            remoteMachines = []
            remoteAccessUnavailable = error.localizedDescription
        }
    }

    /// Reads usage for the selected range.
    ///
    /// A Mini without usage reporting answers 503, which is a configuration state to explain
    /// rather than an error to alarm the user with.
    public func refreshUsage(range: String? = nil) async {
        if let range { usageRange = range }
        isLoadingUsage = true
        defer { isLoadingUsage = false }
        do {
            usage = try await client.usage(range: usageRange)
            usageUnavailable = nil
        } catch let error as OrionClientError {
            usage = nil
            switch error {
            case .desktopAPIMissing, .desktopAccessDisabled:
                usageUnavailable = "This Mini does not report usage yet."
            case .server(503, let message):
                usageUnavailable = message
            default:
                usageUnavailable = error.localizedDescription
            }
        } catch {
            usage = nil
            usageUnavailable = error.localizedDescription
        }
    }

    /// Reads the security checklist. A Mini without the review answers 503, which is a
    /// configuration state to explain rather than an error to alarm the user with.
    public func refreshSecurity() async {
        isLoadingFindings = true
        defer { isLoadingFindings = false }
        do {
            findings = try await client.securityFindings()
            securityUnavailable = nil
        } catch let error as OrionClientError {
            findings = []
            switch error {
            case .desktopAPIMissing, .desktopAccessDisabled:
                securityUnavailable = "This Mini does not run the security review yet."
            case .server(503, let message):
                securityUnavailable = message
            default:
                securityUnavailable = error.localizedDescription
            }
        } catch {
            findings = []
            securityUnavailable = error.localizedDescription
        }
    }

    /// Applies a fix, then re-reads the checklist so the result is the machine's actual state
    /// rather than an assumption that the command worked.
    public func applyRemediation(for finding: SecurityFinding) async {
        guard let platform = finding.target?.platform, finding.isFixable else { return }
        remediatingFindingId = finding.id
        defer { remediatingFindingId = nil }
        do {
            let result = try await client.remediate(findingId: finding.id, platform: platform)
            lastRemediation = (finding: finding.title, result: result)
            await refreshSecurity()
        } catch let error as OrionClientError {
            lastError = error.localizedDescription
            if error.requiresPairing { handleConnectionFailure(error) }
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func dismissRemediationResult() {
        lastRemediation = nil
    }

    /// The Tailscale admin page where a policy is saved. Fixed, never taken from the server.
    public static let tailnetAccessControlsURL = URL(string: "https://login.tailscale.com/admin/acls")!

    /// Asks the Mini to write a tailnet policy for this Mac's tailnet.
    public func loadTailnetPolicy(addresses: [String] = TailnetAddresses.current()) async {
        isLoadingTailnetPolicy = true
        tailnetPolicyError = nil
        defer { isLoadingTailnetPolicy = false }
        do {
            tailnetPolicy = try await client.tailnetPolicy(addresses: addresses)
        } catch let error as OrionClientError {
            tailnetPolicyError = error.localizedDescription
            if error.requiresPairing { handleConnectionFailure(error) }
        } catch {
            tailnetPolicyError = error.localizedDescription
        }
    }

    public func dismissTailnetPolicy() {
        tailnetPolicy = nil
        tailnetPolicyError = nil
    }

    @discardableResult
    public func openTailnetAccessControls() -> Bool {
        opener(Self.tailnetAccessControlsURL)
    }

    public func remoteAccess(for nodeId: String) -> RemoteAccessNode? {
        remoteAccess.first { $0.nodeId == nodeId }
    }

    /// Opens a remote session by handing a validated URL to the system.
    ///
    /// Orion does not display the remote screen itself: it launches Screen Sharing or the Windows
    /// App, which do it natively. The URL is built locally from validated parts, never taken
    /// whole from the server.
    public func openRemoteSession(nodeId: String, kind: String) async {
        launchingNodeId = nodeId
        defer { launchingNodeId = nil }
        do {
            let grant = try await client.openRemoteSession(nodeId: nodeId, kind: kind)
            let url = try Self.launchURL(for: grant)
            guard opener(url) else {
                let app = RemoteLauncher.targetApplication(forScheme: grant.scheme) ?? "the viewer"
                lastError = "macOS could not open \(app) for \(grant.host)."
                return
            }
        } catch let error as OrionClientError {
            lastError = error.localizedDescription
            if error.requiresPairing { handleConnectionFailure(error) }
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Sessions and chat

    public func selectSession(_ key: String) async {
        guard key != selectedSessionKey else { return }
        selectedSessionKey = key
        conversation = ConversationState()
        chatModels = nil
        executionTarget = nil
        async let preferences: Void = loadPreferences(key)
        await loadTranscript(for: key)
        await preferences
    }

    func agentName(_ id: String) -> String {
        switch id {
        case "main": return "J.A.R.V.I.S."
        case "codex": return "WALL-E"
        default: return agents.first { $0.id == id }?.name ?? id
        }
    }

    func loadPreferences(_ key: String) async {
        guard let agent = selectedSession?.agentId else { return }
        async let target = try? client.target(key)
        async let models = try? client.models(agent)
        let values = await (target, models)
        guard key == selectedSessionKey else { return }
        executionTarget = values.0
        chatModels = values.1
    }

    private func loadTranscript(for key: String) async {
        transcriptGeneration += 1
        let generation = transcriptGeneration
        isLoadingTranscript = true
        defer { if generation == transcriptGeneration { isLoadingTranscript = false } }
        do {
            let loaded = try await client.transcript(key)
            guard generation == transcriptGeneration, key == selectedSessionKey else { return }
            let history = loaded.restored(key: key, active: selectedSession?.hasActiveRun == true)
            conversation.mergeHistory(history)
        } catch let error as OrionClientError {
            guard generation == transcriptGeneration else { return }
            lastError = "Could not load this conversation: \(error.localizedDescription)"
        } catch {
            guard generation == transcriptGeneration else { return }
            lastError = error.localizedDescription
        }
    }

    /// Creates a session on the Mini for an existing agent and selects it.
    public func startSession(agentId: String) async {
        do {
            let created = try await client.createSession(agentId: agentId, label: "From \(settings.clientName)")
            showingArchived = false
            await refreshSessions()
            if let created { await selectSession(created) }
        } catch let error as OrionClientError {
            lastError = error.localizedDescription
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func refreshSessions() async {
        sessionRevision += 1
        let version = sessionRevision
        async let active = try? client.sessions()
        let archived = showingArchived ? try? await client.sessions(archived: true) : nil
        let activeList = await active
        guard version == sessionRevision else { return }
        if let activeList { sessions = activeList }
        if let archived { archivedSessions = archived }
    }

    func showArchived(_ show: Bool) async {
        guard showingArchived != show else { return }
        if show { lastActiveSession = selectedSessionKey }
        showingArchived = show
        await refreshSessions()
        guard showingArchived == show else { return }
        let rows = visibleSessions
        let preferred = show ? nil : lastActiveSession
        if let next = rows.first(where: { $0.key == preferred }) ?? rows.first {
            await selectSession(next.key)
        } else {
            transcriptGeneration += 1
            isLoadingTranscript = false
            selectedSessionKey = nil
            conversation = ConversationState()
        }
    }

    func changeSession(_ key: String, _ change: SessionChange) async {
        guard changingSessions.insert(key).inserted else { return }
        defer { changingSessions.remove(key) }
        do {
            try await client.update(key, change)
            await refreshSessions()
            guard selectedSessionKey == key else { return }
            switch change {
            case .compact, .reset:
                conversation = ConversationState()
                await loadTranscript(for: key)
            case .archive, .delete:
                selectedSessionKey = nil
                conversation = ConversationState()
            case .model, .target: await loadPreferences(key)
            default: break
            }
        } catch { lastError = error.localizedDescription }
    }

    public func send(_ text: String) async {
        guard let key = selectedSessionKey else { return }
        do { try await submit(ChatDraft(text: text), to: key) }
        catch {
            guard selectedSessionKey == key else { return }
            conversation.messages.append(ChatMessage(role: .user, text: text.trimmingCharacters(in: .whitespacesAndNewlines)))
            conversation.messages.append(ChatMessage(role: .failure, text: error.localizedDescription))
        }
    }

    /// Keep the draft under its session key through both requests. A failed attempt can be
    /// retried even if the user visits another conversation during the upload.
    func sendDraft(for key: String) async {
        guard let draft = drafts[key], !submitting.contains(key) else { return }
        do {
            try await submit(draft, to: key)
            if drafts[key]?.text == draft.text { drafts[key]?.text = "" }
            let ids = Set(draft.files.map(\.id))
            drafts[key]?.files.removeAll { ids.contains($0.id) }
            drafts[key]?.error = nil
        } catch {
            drafts[key]?.error = error.localizedDescription
        }
    }

    private func submit(_ draft: ChatDraft, to key: String) async throws {
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !draft.files.isEmpty else { return }
        guard selectedSessionKey == key, submitting.insert(key).inserted else { throw CancellationError() }
        let generation = transcriptGeneration
        defer { submitting.remove(key) }
        let agent = selectedSession?.agentId
        let ids = draft.files.isEmpty ? [] : try await client.upload(draft.files)
        guard selectedSessionKey == key, generation == transcriptGeneration else { throw CancellationError() }
        let busy = conversation.busy
        var message = ChatMessage(role: .user, text: text)
        message.attachments = draft.files.map(\.fileName)
        conversation.begin(message)
        do {
            let ack = try await client.sendChat(sessionKey: key, message: text, agentId: agent, attachmentIds: ids, mode: busy ? "steer" : nil)
            guard key == selectedSessionKey, generation == transcriptGeneration else { return }
            conversation.acknowledge(ack, at: Date())
        } catch {
            if key == selectedSessionKey, generation == transcriptGeneration {
                conversation.steering = nil
                conversation.messages.removeAll { $0.id == message.id }
                let provisional = "local:" + message.id.uuidString
                if conversation.current == provisional { conversation.finish(provisional, at: Date()) }
            }
            if let failure = error as? OrionClientError, failure.requiresPairing { handleConnectionFailure(failure) }
            throw error
        }
    }

    func stop() async {
        guard let key = selectedSessionKey, let id = conversation.current, !conversation.stopping else { return }
        conversation.stopping = true
        do {
            let aborted = try await client.abort(key, run: id.hasPrefix("local:") ? nil : id)
            if key == selectedSessionKey { conversation.abortAcknowledged(aborted, for: id, at: Date()) }
        } catch {
            if key == selectedSessionKey, conversation.current == id { conversation.stopping = false }
            lastError = error.localizedDescription
        }
    }

    func refreshApprovals() async {
        let version = inbox.revision
        if let pending = try? await client.approvals() {
            inbox.replay(pending, since: version)
            scheduleApprovalExpiry()
        }
    }

    private func scheduleApprovalExpiry() {
        approvalExpiry?.cancel()
        guard let next = inbox.items.filter({ $0.status == "pending" }).compactMap(\.expiresAt).min() else { return }
        approvalExpiry = Task { [weak self] in
            let delay = max(0, next / 1000 - Date().timeIntervalSince1970)
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self else { return }
            let now = Date().timeIntervalSince1970 * 1000
            for item in inbox.items where item.status == "pending" && (item.expiresAt ?? .infinity) <= now {
                inbox.resolve(item.id, status: "expired")
            }
            scheduleApprovalExpiry()
        }
    }

    func resolve(_ id: String, _ decision: String) async {
        do {
            try await client.resolve(id, decision: decision)
            inbox.resolve(id, status: decision == "deny" ? "denied" : "approved")
        } catch { lastError = error.localizedDescription }
    }

    public func clearError() {
        lastError = nil
    }

    // MARK: - Event stream

    private func startEventStream() {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            await self?.runEventStream()
        }
    }

    private func runEventStream() async {
        while !Task.isCancelled {
            do {
                let stream = try await client.makeEventStream()
                for try await event in stream.events() {
                    if Task.isCancelled { return }
                    handle(event)
                }
                // A clean end still means no events are arriving, so reconnect.
                if Task.isCancelled { return }
                await backOff()
            } catch let error as OrionClientError {
                if Task.isCancelled { return }
                if error.requiresPairing {
                    handleConnectionFailure(error)
                    return
                }
                gatewayConnected = false
                gatewayReason = error.localizedDescription
                await notifyIfEnabled(
                    title: "Orion disconnected",
                    body: "The connection to the Mini dropped. Reconnecting."
                )
                await backOff()
            } catch {
                if Task.isCancelled { return }
                await backOff()
            }
        }
    }

    /// Capped exponential backoff, so a Mini that is asleep is retried without a busy loop.
    private func backOff() async {
        reconnectAttempt = min(reconnectAttempt + 1, 6)
        let seconds = min(pow(1.7, Double(reconnectAttempt)), 30)
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    func handle(_ event: ServerSentEvent) {
        switch event.name {
        case "gateway.status":
            guard let status = event.decode(GatewayStatusEvent.self) else { return }
            gatewayConnected = status.connected
            gatewayReason = status.reason
            reconnectAttempt = 0
            if status.connected { Task { await refreshApprovals() } }
        case "gateway.disconnected":
            gatewayConnected = false
            gatewayReason = "The Mini lost its connection to the OpenClaw gateway."
        case "chat":
            guard let chat = event.decode(ChatEvent.self) else { return }
            handleChat(chat)
        case "chat.tool":
            if let tool = event.decode(ChatTool.self), tool.sessionKey == selectedSessionKey { conversation.receive(tool) }
        case "chat.approval":
            guard let approval = event.decode(Approval.self) else { return }
            let isNew = !inbox.items.contains { $0.id == approval.id }
            inbox.receive(approval)
            scheduleApprovalExpiry()
            if isNew && approval.status == "pending" && !NSApplication.shared.isActive {
                Task { await notifyIfEnabled(title: "Orion approval requested", body: "A command is waiting for your decision.") }
            }
        case "sessions.changed":
            Task { await refreshSessions() }
        case "node.presence.alive":
            Task {
                await refreshNodes()
                if let key = selectedSessionKey { await loadPreferences(key) }
            }
        default:
            break
        }
    }

    private func handleChat(_ chat: ChatEvent) {
        // Both clients read the same stream, so a turn from the web UI arrives here too. Only the
        // selected session may write into this transcript.
        if let key = chat.sessionKey, let selected = selectedSessionKey, key != selected { return }

        guard selectedSessionKey != nil, conversation.receive(chat, at: Date()) else { return }
        Task {
            await notifyIfEnabled(
                title: chat.isFailure ? "Orion run failed" : "Orion replied",
                // Deliberately no reply text: a banner should not leak session contents.
                body: chat.isFailure
                    ? "A run ended without completing."
                    : "An agent finished replying."
            )
        }
    }

    /// Resolves a grant to something the window server can open.
    ///
    /// RDP needs a connection file rather than a URL, so one is written to the caches directory
    /// and reused per host. It holds only the destination — the Windows App prompts for
    /// credentials, which never pass through Orion.
    static func launchURL(for grant: RemoteSessionGrant) throws -> URL {
        switch try RemoteLauncher.target(for: grant) {
        case .url(let url):
            return url
        case .connectionFile(let contents, let filename):
            let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Orion", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent(filename)
            try contents.write(to: file, atomically: true, encoding: .utf8)
            return file
        }
    }

    private func notifyIfEnabled(title: String, body: String) async {
        guard settings.notificationsEnabled else { return }
        await notifier.notify(title: title, body: body)
    }
}
