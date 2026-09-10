import Foundation
import Security

/// Where the desktop client credential lives.
///
/// The plan requires that Orion.app never embeds a gateway token, provider key, or `.env` value.
/// The one secret it holds is the revocable desktop token issued by the Mini at pairing time, and
/// it is kept in the login Keychain rather than in UserDefaults or a file in the bundle.
public protocol CredentialStore: Sendable {
    func token(forHost host: String) -> String?
    func save(token: String, forHost host: String) throws
    func removeToken(forHost host: String) throws
}

public struct KeychainStore: CredentialStore {
    /// Scoping by service keeps one Mini's token from being offered to another host.
    private static let service = "app.orion.desktop-client"

    public init() {}

    public func token(forHost host: String) -> String? {
        var query = Self.baseQuery(host: host)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func save(token: String, forHost host: String) throws {
        let data = Data(token.utf8)
        // Replace rather than merge: a re-pair must not leave the previous token behind.
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(Self.baseQuery(host: host) as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainError(status: status) }

        var insert = Self.baseQuery(host: host)
        insert[kSecValueData as String] = data
        // The app reads the token on launch to restore a connection, so it must be available
        // whenever the user is logged in — but it should never leave this Mac in a backup.
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(insert as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
    }

    public func removeToken(forHost host: String) throws {
        let status = SecItemDelete(Self.baseQuery(host: host) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private static func baseQuery(host: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: host,
        ]
    }
}

public struct KeychainError: LocalizedError {
    public let status: OSStatus

    public var errorDescription: String? {
        let detail = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
        return "Could not reach the Keychain: \(detail)"
    }
}

/// In-memory store used by tests and previews so they never touch the real Keychain.
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String] = [:]

    public init(tokens: [String: String] = [:]) {
        self.tokens = tokens
    }

    public func token(forHost host: String) -> String? {
        lock.withLock { tokens[host] }
    }

    public func save(token: String, forHost host: String) throws {
        lock.withLock { tokens[host] = token }
    }

    public func removeToken(forHost host: String) throws {
        lock.withLock { tokens[host] = nil }
    }
}
