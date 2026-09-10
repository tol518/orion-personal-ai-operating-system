import Foundation

/// Non-secret connection settings. The token itself lives in the Keychain, never here.
public struct OrionSettings: Sendable, Equatable {
    public var host: String
    public var clientId: String
    public var clientName: String
    public var notificationsEnabled: Bool

    public init(host: String, clientId: String, clientName: String, notificationsEnabled: Bool) {
        self.host = host
        self.clientId = clientId
        self.clientName = clientName
        self.notificationsEnabled = notificationsEnabled
    }
}

/// Persists connection settings in UserDefaults.
///
/// The plan forbids hardcoding hosts, so there is no default address: an unconfigured app shows
/// the connection screen and asks for one. The client id is generated once and reused, because
/// the Mini's allowlist and revocation are keyed on it.
public struct SettingsStore {
    private enum Key {
        static let host = "orion.host"
        static let clientId = "orion.clientId"
        static let clientName = "orion.clientName"
        static let notifications = "orion.notificationsEnabled"
    }

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> OrionSettings {
        OrionSettings(
            host: defaults.string(forKey: Key.host) ?? "",
            clientId: existingOrNewClientId(),
            clientName: defaults.string(forKey: Key.clientName) ?? Self.defaultClientName,
            notificationsEnabled: defaults.object(forKey: Key.notifications) as? Bool ?? true
        )
    }

    public func save(_ settings: OrionSettings) {
        defaults.set(settings.host, forKey: Key.host)
        defaults.set(settings.clientId, forKey: Key.clientId)
        defaults.set(settings.clientName, forKey: Key.clientName)
        defaults.set(settings.notificationsEnabled, forKey: Key.notifications)
    }

    private func existingOrNewClientId() -> String {
        if let existing = defaults.string(forKey: Key.clientId), !existing.isEmpty { return existing }
        let generated = Self.generateClientId()
        defaults.set(generated, forKey: Key.clientId)
        return generated
    }

    /// A stable, safe identifier derived from the machine name, with a short random suffix so two
    /// Macs with the same name cannot collide in the Mini's allowlist.
    static func generateClientId() -> String {
        let raw = Host.current().localizedName ?? "macbook"
        let slug = raw.lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let base = slug.isEmpty ? "macbook" : String(slug.prefix(40))
        let suffix = String(UUID().uuidString.prefix(4)).lowercased()
        return "\(base)-\(suffix)"
    }

    static var defaultClientName: String {
        Host.current().localizedName ?? "MacBook"
    }
}
