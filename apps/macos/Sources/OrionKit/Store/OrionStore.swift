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

    // MARK: Usage
    public private(set) var usage: UsageSummary?
    public private(set) var usageRange = "7d"
    public private(set) var isLoadingUsage = false
    public private(set) var usageUnavailable: String?
    public private(set) var remoteAccessUnavailable: String?
    public private(set) var launchingNodeId: String?

    // MARK: Chat
    public internal(set) var selectedSessionKey: String?
    public private(set) var messages: [ChatMessage] = []
    /// The reply currently arriving as deltas, shown beneath the settled transcript.
    public private(set) var streamingReply: String?
    public private(set) var isSending = false
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
        usage = nil
        messages = []
        selectedSessionKey = nil
        streamingReply = nil
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
        messages = []
        streamingReply = nil
        isSending = false
        await loadTranscript(for: key)
    }

    private func loadTranscript(for key: String) async {
        transcriptGeneration += 1
        let generation = transcriptGeneration
        isLoadingTranscript = true
        defer { if generation == transcriptGeneration { isLoadingTranscript = false } }
        do {
            let loaded = try await client.history(sessionKey: key)
            // Discard a response for a session the user has already navigated away from.
            guard generation == transcriptGeneration, key == selectedSessionKey else { return }
            messages = loaded
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
            await refreshSessions()
            if let created {
                selectedSessionKey = created
                messages = []
                streamingReply = nil
                await loadTranscript(for: created)
            }
        } catch let error as OrionClientError {
            lastError = error.localizedDescription
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func refreshSessions() async {
        guard let loaded = try? await client.sessions() else { return }
        sessions = loaded
    }

    public func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sessionKey = selectedSessionKey else { return }
        let agentId = sessions.first { $0.key == sessionKey }?.agentId

        // Show the user's turn immediately; the BFF echoes it back inside a memory envelope that
        // only appears in later history reads.
        messages.append(ChatMessage(role: .user, text: trimmed))
        isSending = true
        streamingReply = ""
        do {
            _ = try await client.sendChat(sessionKey: sessionKey, message: trimmed, agentId: agentId)
        } catch let error as OrionClientError {
            isSending = false
            streamingReply = nil
            messages.append(ChatMessage(role: .failure, text: error.localizedDescription))
            if error.requiresPairing { handleConnectionFailure(error) }
        } catch {
            isSending = false
            streamingReply = nil
            messages.append(ChatMessage(role: .failure, text: error.localizedDescription))
        }
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
        case "gateway.disconnected":
            gatewayConnected = false
            gatewayReason = "The Mini lost its connection to the OpenClaw gateway."
        case "chat":
            guard let chat = event.decode(ChatEvent.self) else { return }
            handleChat(chat)
        case "sessions.changed":
            Task { await refreshSessions() }
        case "node.presence.alive":
            Task { await refreshNodes() }
        default:
            // session.tool / session.message / agent carry detail the V1 transcript does not show.
            break
        }
    }

    private func handleChat(_ chat: ChatEvent) {
        // Both clients read the same stream, so a turn from the web UI arrives here too. Only the
        // selected session may write into this transcript.
        if let key = chat.sessionKey, let selected = selectedSessionKey, key != selected { return }

        if chat.isDelta {
            streamingReply = (streamingReply ?? "") + (chat.deltaText ?? "")
            return
        }
        guard chat.isTerminal else { return }
        let message = TranscriptFormatter.finalMessage(for: chat, accumulated: streamingReply ?? "")
        messages.append(message)
        streamingReply = nil
        isSending = false
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
