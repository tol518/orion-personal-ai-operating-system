import Foundation

/// Errors the UI needs to tell apart, so it can offer the right recovery.
public enum OrionClientError: LocalizedError, Equatable {
    case notConfigured
    case notPaired
    case unauthorized
    case desktopAccessDisabled
    case desktopAPIMissing
    case throttled(retryAfter: Int?)
    case server(status: Int, message: String)
    case transport(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "No Mini address is set yet."
        case .notPaired:
            return "This Mac is not paired with the Mini yet."
        case .unauthorized:
            return "The pairing for this Mac is no longer valid. Pair again."
        case .desktopAccessDisabled:
            return "The Mini has not enabled desktop access. Set ORION_DESKTOP_PAIRING_SECRET on the Mini and restart the BFF."
        case .desktopAPIMissing:
            return "The Mini answered, but it has no desktop API. It is running a version of Orion from before native client support — update the server on the Mini and restart it."
        case .throttled(let retryAfter):
            guard let retryAfter else { return "Too many attempts. Try again shortly." }
            return "Too many attempts. Try again in \(retryAfter)s."
        case .server(_, let message):
            return message
        case .transport(let message):
            return "Could not reach the Mini: \(message)"
        case .decoding(let message):
            return "The Mini sent a response this app could not read: \(message)"
        }
    }

    /// True when re-pairing is the fix, so the UI can send the user back to the connection screen.
    public var requiresPairing: Bool {
        switch self {
        case .notPaired, .unauthorized, .notConfigured: return true
        default: return false
        }
    }
}

/// The transport for `/api/v1/desktop`.
///
/// Holds the base URL and the bearer token, and nothing else: no gateway address, no provider
/// credential, no direct gateway socket. Every call goes to the BFF on the Mini, which is the
/// only component allowed to talk to OpenClaw.
public actor OrionClient {
    private let session: URLSession
    private let credentials: CredentialStore
    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()
    private var baseURL: URL?
    // The Keychain is read once per host and then held here.
    //
    // Reading it per request made macOS re-run its access check constantly: unless the user picks
    // "Always Allow", every read raises an authorization prompt, and with the event stream
    // reconnecting the prompts arrive faster than they can be dismissed. The actor serializes
    // access, so this cache needs no lock of its own.
    private var cachedToken: String?
    private var cachedTokenHost: String?

    public init(credentials: CredentialStore = KeychainStore(), session: URLSession? = nil) {
        self.credentials = credentials
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 20
            // Deliberately false. waitsForConnectivity makes a request to an unreachable host
            // wait indefinitely instead of failing, and timeoutIntervalForRequest does not apply
            // while it waits — so a mistyped address hangs the UI rather than reporting an error.
            configuration.waitsForConnectivity = false
            // A hard ceiling regardless of activity, so nothing can wait forever.
            configuration.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: configuration)
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = ISO8601DateFormatter.orionFractional.date(from: text) { return date }
            if let date = ISO8601DateFormatter.orionPlain.date(from: text) { return date }
            throw DecodingError.dataCorruptedError(
                in: try decoder.singleValueContainer(),
                debugDescription: "Unrecognized date: \(text)"
            )
        }
        self.decoder = decoder
    }

    // MARK: - Configuration

    public func configure(host: String) throws {
        let resolved = try Self.resolveBaseURL(from: host)
        // Pointing at a different Mini must not reuse the previous one's token.
        if resolved != baseURL { clearTokenCache() }
        baseURL = resolved
    }

    private func clearTokenCache() {
        cachedToken = nil
        cachedTokenHost = nil
    }

    /// The stored token for the configured host, read from the Keychain at most once per host.
    private func storedToken() throws -> String? {
        let key = try credentialKey()
        if cachedTokenHost == key, let cachedToken { return cachedToken }
        guard let token = credentials.token(forHost: key) else { return nil }
        cachedToken = token
        cachedTokenHost = key
        return token
    }

    /// Normalizes what a user is likely to type: a MagicDNS name, a name with a port, or a URL.
    ///
    /// Defaults to `http` because a Tailscale MagicDNS name has no public certificate; the network
    /// itself is the encrypted transport. An explicit `https://` is honored when the user has set
    /// up TLS on the Mini.
    public static func resolveBaseURL(from host: String) throws -> URL {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw OrionClientError.notConfigured }
        let withScheme = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
        guard var components = URLComponents(string: withScheme), let hostName = components.host,
              !hostName.isEmpty
        else { throw OrionClientError.notConfigured }
        // The BFF's own port when spoken to directly, but 443 behind a TLS front such as
        // Tailscale Serve — which is the whole reason someone types https in the first place.
        // Defaulting to 4820 for an https address sends the app at a port that is not listening.
        if components.port == nil {
            components.port = components.scheme == "https" ? 443 : 4820
        }
        components.path = ""
        components.query = nil
        guard let url = components.url else { throw OrionClientError.notConfigured }
        return url
    }

    /// The Keychain account key for the configured host, so two Minis can be paired independently.
    private func credentialKey() throws -> String {
        guard let baseURL, let host = baseURL.host else { throw OrionClientError.notConfigured }
        return "\(host):\(baseURL.port ?? 4820)"
    }

    public func hasStoredToken() -> Bool {
        // `try?` flattens the nested optional, so this is nil both when the read throws and when
        // no token is stored.
        (try? storedToken()) != nil
    }

    public func forgetPairing() throws {
        clearTokenCache()
        try credentials.removeToken(forHost: try credentialKey())
    }

    // MARK: - Pairing

    /// Exchanges the pairing secret for a bearer token and stores it in the Keychain.
    ///
    /// The secret is used for this one request and never retained: only the issued token is kept,
    /// and the Mini can revoke it without rotating anything else.
    public func pair(pairingSecret: String, clientId: String, clientName: String) async throws -> DesktopPairing {
        struct Body: Encodable {
            let pairingSecret: String
            let clientId: String
            let clientName: String
            let platform = "macos"
        }
        let pairing: DesktopPairing = try await send(
            "pair",
            method: "POST",
            body: Body(pairingSecret: pairingSecret, clientId: clientId, clientName: clientName),
            authenticated: false
        )
        let key = try credentialKey()
        try credentials.save(token: pairing.token, forHost: key)
        // Seed the cache from the pairing response, so the first authenticated call after pairing
        // does not have to read back what was just written.
        cachedToken = pairing.token
        cachedTokenHost = key
        return pairing
    }

    /// Revokes this Mac's token on the Mini, then forgets it locally.
    public func unpair() async throws {
        defer { try? forgetPairing() }
        _ = try await sendIgnoringResponse("unpair", method: "POST")
    }

    // MARK: - Read models

    public func health() async throws -> DesktopHealth {
        try await send("health")
    }

    public func agents() async throws -> [DesktopAgent] {
        let response: AgentsResponse = try await send("agents")
        return response.agents
    }

    public func sessions(limit: Int = 30) async throws -> [DesktopSession] {
        let response: SessionsResponse = try await send("sessions?limit=\(limit)")
        return response.sessions
    }

    public func nodes() async throws -> [DesktopNode] {
        let response: NodesResponse = try await send("nodes")
        return response.nodes
    }

    /// Token and cost usage over a range such as "7d" or "30d".
    public func usage(range: String = "7d") async throws -> UsageSummary {
        try await send("usage?range=\(range)")
    }

    /// The security checklist: what is not yet secure, worst first.
    public func securityFindings() async throws -> [SecurityFinding] {
        let response: SecurityResponse = try await send("security")
        return response.findings
    }

    /// Asks the Mini to apply a known fix. The command lives on the Mini, keyed by finding —
    /// this sends only which finding to act on, so nothing from here reaches a shell.
    public func remediate(findingId: String, platform: String) async throws -> RemediationResult {
        struct Body: Encodable {
            let findingId: String
            let platform: String
        }
        return try await send(
            "security/remediate",
            method: "POST",
            body: Body(findingId: findingId, platform: platform)
        )
    }

    /// Which native remote-desktop services the Mini can see, for itself and for each node.
    ///
    /// The Mini's own entry gets the connected address as a fallback, so a Mini that cannot read
    /// its own tailnet name is still reachable at the address that is plainly working.
    public func remoteAccess() async throws -> (
        mini: RemoteAccessNode?,
        machines: [RemoteMachine],
        nodes: [RemoteAccessNode]
    ) {
        let response: RemoteAccessResponse = try await send("remote-access")
        return (
            response.mini?.withFallbackHost(baseURL?.host),
            response.machines ?? [],
            response.nodes
        )
    }

    /// Registers the intent to open a session and returns the parts to build a URL from.
    ///
    /// The Mini audits this call. It returns host, port, and scheme rather than a URL, so the
    /// client decides what it is willing to launch — see `RemoteLauncher`.
    public func openRemoteSession(nodeId: String, kind: String) async throws -> RemoteSessionGrant {
        struct Body: Encodable { let kind: String }
        let encoded = nodeId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? nodeId
        return try await send("remote-access/\(encoded)/session", method: "POST", body: Body(kind: kind))
    }

    public func history(sessionKey: String) async throws -> [ChatMessage] {
        let encoded = sessionKey.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? sessionKey
        let response: HistoryResponse = try await send("sessions/\(encoded)/history")
        return TranscriptFormatter.messages(from: response)
    }

    // MARK: - Writes

    public func createSession(agentId: String, label: String?) async throws -> String? {
        struct Body: Encodable {
            let agentId: String
            let label: String?
        }
        let response: CreatedSessionResponse = try await send(
            "sessions",
            method: "POST",
            body: Body(agentId: agentId, label: label)
        )
        return response.sessionKey
    }

    public func sendChat(sessionKey: String, message: String, agentId: String?) async throws -> DesktopChatAck {
        struct Body: Encodable {
            let sessionKey: String
            let message: String
            let agentId: String?
        }
        return try await send(
            "chat",
            method: "POST",
            body: Body(sessionKey: sessionKey, message: message, agentId: agentId)
        )
    }

    // MARK: - Event stream

    /// How long the event stream may go silent before it is treated as dead.
    ///
    /// This is an inactivity timeout, reset by every packet, and the BFF writes a keep-alive
    /// comment every 25 seconds — so anything comfortably above that detects a dead connection
    /// without cutting a healthy idle stream. It must be finite: `.infinity` makes URLSession
    /// complete the request immediately with an empty body rather than streaming it.
    static let eventStreamTimeout: TimeInterval = 60

    /// Builds the authenticated SSE request. The stream itself is driven by `EventStream`.
    public func eventStreamRequest() throws -> URLRequest {
        var request = try authorizedRequest(path: "events", method: "GET", authenticated: true)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // Overrides the session's shorter per-request timeout, which is sized for REST calls.
        request.timeoutInterval = Self.eventStreamTimeout
        return request
    }

    public func makeEventStream() throws -> EventStream {
        EventStream(request: try eventStreamRequest(), session: session)
    }

    // MARK: - Request plumbing

    private func authorizedRequest(path: String, method: String, authenticated: Bool) throws -> URLRequest {
        guard let baseURL else { throw OrionClientError.notConfigured }
        guard let url = URL(string: "\(baseURL.absoluteString)/api/v1/desktop/\(path)") else {
            throw OrionClientError.notConfigured
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated {
            guard let token = try storedToken() else { throw OrionClientError.notPaired }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func send<Response: Decodable>(
        _ path: String,
        method: String = "GET",
        body: (some Encodable)? = Optional<Never>.none,
        authenticated: Bool = true
    ) async throws -> Response {
        let data = try await perform(path, method: method, body: body, authenticated: authenticated)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw OrionClientError.decoding(String(describing: error))
        }
    }

    private func sendIgnoringResponse(
        _ path: String,
        method: String,
        authenticated: Bool = true
    ) async throws -> Data {
        try await perform(path, method: method, body: Optional<Never>.none, authenticated: authenticated)
    }

    private func perform(
        _ path: String,
        method: String,
        body: (some Encodable)?,
        authenticated: Bool
    ) async throws -> Data {
        var request = try authorizedRequest(path: path, method: method, authenticated: authenticated)
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw OrionClientError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw OrionClientError.transport("the Mini sent a malformed response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.mapFailure(status: http.statusCode, headers: http, data: data)
        }
        return data
    }

    /// Turns a BFF failure into something the UI can act on rather than just display.
    static func mapFailure(status: Int, headers: HTTPURLResponse, data: Data) -> OrionClientError {
        let message = (try? JSONDecoder().decode(DesktopEnvelope.self, from: data))?.error
            ?? HTTPURLResponse.localizedString(forStatusCode: status)
        switch status {
        case 401:
            return .unauthorized
        case 403:
            return .server(status: status, message: message)
        case 429:
            let retryAfter = headers.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init)
            return .throttled(retryAfter: retryAfter)
        case 404:
            return .desktopAPIMissing
        case 503:
            return .desktopAccessDisabled
        default:
            return .server(status: status, message: message)
        }
    }
}

extension ISO8601DateFormatter {
    /// The BFF emits `toISOString()`, which always carries milliseconds.
    static let orionFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// Gateway-passthrough fields are not guaranteed to include them.
    static let orionPlain = ISO8601DateFormatter()
}
