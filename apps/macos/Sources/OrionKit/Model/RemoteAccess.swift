import Foundation

/// A native remote-desktop service the Mini reports as present on a node.
///
/// Orion never carries the session itself. macOS Screen Sharing and Windows RDP already do that
/// with hardware video decode, audio, clipboard sync, file drag-and-drop, and multiple displays;
/// this type exists only so the app can say what is available and hand off to the real client.
public struct RemoteService: Decodable, Sendable, Identifiable, Equatable {
    public var id: String { kind }
    public let kind: String
    public let label: String
    public let port: Int
    /// Nil for services that are informational only, such as the ARD management channel.
    public let scheme: String?
    public let launchable: Bool
    public let reachable: Bool
    /// Which interfaces the port is bound to. Absent on Minis older than this check.
    public let exposure: ServiceExposure?

    /// True when the service answers on networks beyond the tailnet — the office LAN, say.
    public var isExposedBeyondTailnet: Bool { exposure?.scope == "lan" }
}

/// How a remote-desktop port is bound, as reported by the machine itself.
///
/// Reachability over the tailnet is not the whole story: a port that answers everywhere is also
/// reachable from whatever network the machine sits on. macOS Screen Sharing and Windows RDP both
/// bind that way by default, and nothing in either OS points it out.
public struct ServiceExposure: Decodable, Sendable, Equatable {
    /// The exact remediation, or an honest note when none exists.
    public struct Fix: Decodable, Sendable, Equatable {
        public let summary: String
        public let command: String?
        public let shell: String?
        public let rollback: String?
    }

    /// all-interfaces | specific | tailnet-only | loopback-only | not-listening | unknown
    public let bind: String
    /// lan | private | local, or nil when not listening or unknown
    public let scope: String?
    public let fix: Fix?

    public var summary: String {
        switch bind {
        case "all-interfaces": return "Answers on every network interface, not just your tailnet."
        case "specific": return "Bound to a non-tailnet address — reachable from that network."
        case "tailnet-only": return "Bound to Tailscale only."
        case "loopback-only": return "Bound to this machine only."
        case "not-listening": return "Not listening."
        default: return "Interface exposure could not be checked."
        }
    }
}

public struct RemoteAccessNode: Decodable, Sendable, Identifiable, Equatable {
    public var id: String { nodeId }
    public let nodeId: String
    public let host: String?
    public let hostSource: String
    public let services: [RemoteService]
    /// Present when no address could be resolved; says what to configure.
    public let hint: String?

    public init(
        nodeId: String,
        host: String?,
        hostSource: String,
        services: [RemoteService],
        hint: String?
    ) {
        self.nodeId = nodeId
        self.host = host
        self.hostSource = hostSource
        self.services = services
        self.hint = hint
    }

    public var launchableServices: [RemoteService] {
        services.filter { $0.launchable && $0.reachable }
    }

    public var hasAnyReachableService: Bool {
        services.contains { $0.reachable }
    }
}

/// What the Mini returns when a session is opened: the parts to build a URL from, not a URL.
public struct RemoteSessionGrant: Decodable, Sendable {
    public let host: String
    public let port: Int
    public let scheme: String
    public let service: String

    public init(host: String, port: Int, scheme: String, service: String) {
        self.host = host
        self.port = port
        self.scheme = scheme
        self.service = service
    }
}

/// A machine offered by configuration rather than by the gateway's node list.
///
/// Reachability for remote desktop and OpenClaw node pairing are separate relationships: a PC can
/// be perfectly reachable for RDP without ever being an execution node, and an outbound gateway
/// channel gives no route back for a desktop session.
public struct RemoteMachine: Decodable, Sendable, Identifiable, Equatable {
    public var id: String { nodeId }
    public let nodeId: String
    public let label: String
    public let platform: DesktopNode.Platform
    public let host: String
    public let hostSource: String
    public let services: [RemoteService]

    public var launchableServices: [RemoteService] {
        services.filter { $0.launchable && $0.reachable }
    }
}

struct RemoteAccessResponse: Decodable {
    /// The Mini itself, reported separately because it need not be a paired execution node.
    let mini: RemoteAccessNode?
    let machines: [RemoteMachine]?
    let nodes: [RemoteAccessNode]
}

extension RemoteAccessNode {
    /// Node id the Mini reports itself under.
    public static let miniNodeId = "orion-mini"

    /// The same entry with a fallback address filled in.
    ///
    /// When the Mini cannot determine its own tailnet name, the address the user is already
    /// connected through is known-good — it is how this request reached the Mini at all.
    public func withFallbackHost(_ fallback: String?) -> RemoteAccessNode {
        guard host == nil, let fallback, RemoteLauncher.isValidHost(fallback) else { return self }
        return RemoteAccessNode(
            nodeId: nodeId,
            host: fallback,
            hostSource: "connected-address",
            services: services,
            hint: nil
        )
    }
}

/// Turns a grant into a URL for the system to open.
///
/// The scheme is checked against a fixed allowlist and the host against a strict pattern rather
/// than trusting the response: this URL is handed to the window server to launch an application,
/// so a compromised or buggy Mini must not be able to choose an arbitrary one. That is also why
/// the server returns parts instead of a finished URL.
public enum RemoteLauncher {
    /// Schemes this app is willing to open, and the app each one reaches.
    public static let allowedSchemes: [String: String] = [
        "vnc": "Screen Sharing",
        "rdp": "Windows App",
    ]

    /// Characters a hostname or IP literal may contain. Everything else is refused.
    private static let allowedHostCharacters = CharacterSet(
        charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"
    )

    /// Validates a hostname by inspecting it directly rather than with an anchored regex.
    ///
    /// An earlier version used `^...$` and let "host\nevil" through: ICU's `$` does not anchor the
    /// way a whole-string check needs when the value contains a line separator. Checking the
    /// character set and each label explicitly has no such edge case.
    static func isValidHost(_ host: String) -> Bool {
        guard (1...253).contains(host.count) else { return false }
        guard host.unicodeScalars.allSatisfy({ allowedHostCharacters.contains($0) }) else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard !labels.isEmpty else { return false }
        return labels.allSatisfy { label in
            // Rejects empty labels ("a..b", a leading or trailing dot) and dash-edged labels.
            (1...63).contains(label.count) && label.first != "-" && label.last != "-"
        }
    }

    public enum LaunchError: LocalizedError, Equatable {
        case unsupportedScheme(String)
        case invalidHost(String)
        case invalidPort(Int)
        case malformedURL

        public var errorDescription: String? {
            switch self {
            case .unsupportedScheme(let scheme):
                return "The Mini asked to open a “\(scheme)” session, which this app does not support."
            case .invalidHost(let host):
                return "The Mini returned an address this app will not open: \(host)"
            case .invalidPort(let port):
                return "The Mini returned an invalid port: \(port)"
            case .malformedURL:
                return "Could not build a connection address for that node."
            }
        }
    }

    /// How a validated grant should be handed to the system.
    public enum LaunchTarget: Equatable {
        /// Opened directly, as Screen Sharing accepts vnc://host:port.
        case url(URL)
        /// Written to a temporary file and opened, which is how the Windows App takes a
        /// connection. Microsoft's documented rdp:// URI is a parameter list that Foundation
        /// cannot construct — `=` and `:` are not valid in a URL authority — and a bare
        /// rdp://host:port opens the app without connecting to anything.
        case connectionFile(contents: String, filename: String)
    }

    /// Validates a grant and returns how to launch it.
    public static func target(for grant: RemoteSessionGrant) throws -> LaunchTarget {
        let scheme = grant.scheme.lowercased()
        guard allowedSchemes[scheme] != nil else { throw LaunchError.unsupportedScheme(grant.scheme) }
        guard (1...65_535).contains(grant.port) else { throw LaunchError.invalidPort(grant.port) }
        guard isValidHost(grant.host) else { throw LaunchError.invalidHost(grant.host) }

        if scheme == "rdp" {
            // Only the destination. No credential is ever written to this file: the Windows App
            // prompts, and the user's password stays between them and Windows.
            let contents = [
                "full address:s:\(grant.host):\(grant.port)",
                "prompt for credentials:i:1",
                "administrative session:i:0",
                "screen mode id:i:2",
            ].joined(separator: "\n") + "\n"
            let safeName = grant.host.replacingOccurrences(of: ".", with: "-")
            return .connectionFile(contents: contents, filename: "orion-\(safeName).rdp")
        }
        return .url(try url(for: grant))
    }

    /// Validates a grant and returns the URL to hand to the system.
    public static func url(for grant: RemoteSessionGrant) throws -> URL {
        let scheme = grant.scheme.lowercased()
        guard allowedSchemes[scheme] != nil else { throw LaunchError.unsupportedScheme(grant.scheme) }
        guard (1...65_535).contains(grant.port) else { throw LaunchError.invalidPort(grant.port) }

        let host = grant.host
        guard isValidHost(host) else { throw LaunchError.invalidHost(host) }

        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = grant.port
        guard let url = components.url else { throw LaunchError.malformedURL }
        return url
    }

    /// The application a given scheme hands off to, for telling the user what will open.
    public static func targetApplication(forScheme scheme: String) -> String? {
        allowedSchemes[scheme.lowercased()]
    }
}
