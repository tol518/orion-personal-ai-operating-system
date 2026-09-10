import Foundation

// Decodable mirrors of the /api/v1/desktop contract. Every type here corresponds to a projection
// the BFF performs on the Mini, so the native app never parses raw OpenClaw gateway shapes.
// See docs/architecture/desktop-api-contract.md.

/// Envelope every desktop route returns. Errors arrive as `{ ok: false, error: "..." }`.
struct DesktopEnvelope: Decodable {
    let ok: Bool
    let error: String?
}

public struct DesktopHealth: Decodable, Sendable, Equatable {
    public struct Gateway: Decodable, Sendable, Equatable {
        public let connected: Bool
        public let scopeCount: Int
        /// A mapped reason, never the gateway's raw error string or address.
        public let reason: String?
    }

    public struct Client: Decodable, Sendable, Equatable {
        public let clientId: String
        public let clientName: String
        public let expiresAt: Date
    }

    public let reachable: Bool
    public let gateway: Gateway
    public let client: Client
    public let serverTime: Date
}

public struct DesktopAgent: Decodable, Sendable, Identifiable, Equatable {
    public struct ModelOption: Decodable, Sendable, Identifiable, Equatable {
        public let id: String
        public let label: String
    }

    public let id: String
    public let name: String
    public let description: String?
    public let currentModel: String?
    public let models: [ModelOption]
}

public struct DesktopSession: Decodable, Sendable, Identifiable, Equatable {
    public var id: String { key }
    public let key: String
    public let agentId: String
    public let title: String
    public let model: String?
    public let lastMessagePreview: String?
    public let hasActiveRun: Bool
    public let totalTokens: Int?
    public let contextTokens: Int?
    public let updatedAt: Date?

    /// Percentage of the context window in use, when the gateway reported both figures.
    public var contextUsage: Double? {
        guard let contextTokens, contextTokens > 0, let totalTokens else { return nil }
        return min(1, Double(totalTokens) / Double(contextTokens))
    }
}

public struct DesktopNode: Decodable, Sendable, Identifiable, Equatable {
    public enum Status: String, Decodable, Sendable {
        case online, offline, unknown
    }

    public enum Platform: String, Decodable, Sendable {
        case macos, windows, linux, unknown
    }

    public let id: String
    public let name: String
    public let platform: Platform
    public let status: Status
    public let capabilities: [String]
    public let lastSeenAt: Date?
}

/// Result of a pairing exchange. The token is written straight to the Keychain and never logged.
public struct DesktopPairing: Decodable, Sendable {
    public struct Client: Decodable, Sendable {
        public let clientId: String
        public let clientName: String
        public let platform: String
    }

    public let token: String
    public let client: Client
}

public struct DesktopChatAck: Decodable, Sendable {
    public struct MemoryCandidate: Decodable, Sendable, Identifiable {
        public let id: String
        public let title: String
    }

    public let memoryCandidates: [MemoryCandidate]?
}

// MARK: - Wrappers for the collection routes

struct AgentsResponse: Decodable { let agents: [DesktopAgent] }
struct SessionsResponse: Decodable { let sessions: [DesktopSession] }
struct NodesResponse: Decodable { let nodes: [DesktopNode] }
struct CreatedSessionResponse: Decodable {
    /// sessions.create is passed through from the gateway, so the key can arrive at either depth.
    let session: Inner?
    let key: String?

    struct Inner: Decodable { let key: String? }

    var sessionKey: String? { session?.key ?? key }
}
