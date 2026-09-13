import Foundation

/// Headless operations behind Siri and the Shortcuts app.
///
/// These run without the UI — App Intents can launch the app in the background — so this type
/// builds its own client from stored settings rather than reaching into `OrionStore`. It shares
/// the same transport, the same Keychain entry, and the same desktop API as the windowed app, so
/// there is no second code path for an agent to behave differently through.
///
/// Every action here is one the plan classes as safe: report status, and send a chat turn. No
/// device control, no node action, no memory access.
public struct OrionIntentService: Sendable {
    public enum IntentError: LocalizedError, Equatable {
        case notConfigured
        case notPaired
        case noSessions
        case failed(String)

        public var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "Orion has no Mini address yet. Open Orion and enter one."
            case .notPaired:
                return "This Mac is not paired with Orion yet. Open Orion to pair it."
            case .noSessions:
                return "There are no Orion sessions yet. Start one in Orion first."
            case .failed(let message):
                return message
            }
        }
    }

    private let settingsStore: SettingsStore
    private let makeClient: @Sendable () -> OrionClient

    public init(
        settingsStore: SettingsStore = SettingsStore(),
        makeClient: @escaping @Sendable () -> OrionClient = { OrionClient() }
    ) {
        self.settingsStore = settingsStore
        self.makeClient = makeClient
    }

    /// A configured, paired client, or a specific reason why there is not one.
    private func connectedClient() async throws -> OrionClient {
        let settings = settingsStore.load()
        guard !settings.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw IntentError.notConfigured
        }
        let client = makeClient()
        do {
            try await client.configure(host: settings.host)
        } catch {
            throw IntentError.notConfigured
        }
        guard await client.hasStoredToken() else { throw IntentError.notPaired }
        return client
    }

    /// One spoken sentence describing the runtime. Phrased to be read aloud, not displayed.
    public func statusSentence() async -> String {
        do {
            let client = try await connectedClient()
            let health = try await client.health()
            guard health.gateway.connected else {
                return "Orion's Mini is reachable, but it cannot reach the gateway\(health.gateway.reason.map { ": \($0)" } ?? ".")"
            }
            let nodes = (try? await client.nodes()) ?? []
            let online = nodes.filter { $0.status == .online }.count
            let sessions = (try? await client.sessions())?.count ?? 0
            var sentence = "Orion is connected."
            if sessions > 0 {
                sentence += " \(sessions) session\(sessions == 1 ? "" : "s")."
            }
            if !nodes.isEmpty {
                sentence += " \(online) of \(nodes.count) node\(nodes.count == 1 ? "" : "s") online."
            }
            return sentence
        } catch let error as IntentError {
            return error.localizedDescription
        } catch let error as OrionClientError {
            return "Orion could not reach the Mini. \(error.localizedDescription)"
        } catch {
            return "Orion could not reach the Mini."
        }
    }

    /// Sends a turn to the most recent session, or to a new session on the named agent.
    ///
    /// Deliberately does not wait for the reply: a spoken request should confirm quickly, and the
    /// run continues on the Mini whether or not anything is listening.
    public func send(message: String, toAgentNamed agentName: String? = nil) async throws -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw IntentError.failed("There was no message to send.") }
        let client = try await connectedClient()

        if let agentName, !agentName.isEmpty {
            let agents = try await client.agents()
            guard let agent = Self.matchAgent(named: agentName, in: agents) else {
                throw IntentError.failed("Orion has no agent called \(agentName).")
            }
            let created = try await client.createSession(agentId: agent.id, label: "From Siri")
            guard let sessionKey = created else {
                throw IntentError.failed("Could not start a session with \(agent.name).")
            }
            _ = try await client.sendChat(sessionKey: sessionKey, message: trimmed, agentId: agent.id)
            return "Sent to \(agent.name)."
        }

        let sessions = try await client.sessions()
        guard let session = Self.mostRecent(of: sessions) else { throw IntentError.noSessions }
        _ = try await client.sendChat(
            sessionKey: session.key,
            message: trimmed,
            agentId: session.agentId
        )
        return "Sent to \(session.title)."
    }

    /// Names spoken aloud arrive without punctuation or casing, so matching is forgiving.
    static func matchAgent(named name: String, in agents: [DesktopAgent]) -> DesktopAgent? {
        let target = normalize(name)
        guard !target.isEmpty else { return nil }
        if let exact = agents.first(where: { normalize($0.name) == target || normalize($0.id) == target }) {
            return exact
        }
        let partial = agents.filter {
            normalize($0.name).contains(target) || target.contains(normalize($0.name))
        }
        // Ambiguity resolves to nothing: sending a message to the wrong agent is worse than asking.
        return partial.count == 1 ? partial[0] : nil
    }

    /// The session a spoken "send this to Orion" should land in.
    static func mostRecent(of sessions: [DesktopSession]) -> DesktopSession? {
        sessions.sorted { left, right in
            switch (left.updatedAt, right.updatedAt) {
            case let (l?, r?): return l > r
            case (nil, _?): return false
            case (_?, nil): return true
            case (nil, nil): return false
            }
        }.first
    }

    private static func normalize(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}
