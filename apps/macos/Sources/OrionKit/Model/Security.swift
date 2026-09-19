import Foundation

/// One thing that is not yet secure, with the fix attached where Orion has one.
///
/// The point of this list is that someone who never reads the documentation still ends up
/// secure: the app says what is wrong and offers to fix it, rather than leaving them to know
/// that a question needs asking.
public struct SecurityFinding: Decodable, Sendable, Identifiable, Equatable {
    public enum Severity: String, Decodable, Sendable {
        case critical, warning, info, ok
    }

    /// What Orion would do about it.
    public struct Remediation: Decodable, Sendable, Equatable {
        public let id: String
        public let title: String
        public let summary: String
        /// True when Orion can run it. False for OS privacy toggles and for machines it knows
        /// only by address, which have no agent to run anything on.
        public let automatic: Bool
        public let shell: String?
        /// Shown before applying, so the exact command is never a surprise.
        public let command: String?
        public let rollback: String?
        /// Why an otherwise-automatic fix cannot be applied here.
        public let blocked: String?
    }

    public struct Target: Decodable, Sendable, Equatable {
        public let nodeId: String
        public let kind: String
        public let port: Int
        public let platform: String
        public let label: String
    }

    public let id: String
    public let severity: Severity
    public let title: String
    public let detail: String
    public let target: Target?
    public let remediation: Remediation?

    /// Orion can apply this one itself.
    public var isFixable: Bool {
        remediation?.automatic == true && remediation?.command != nil
    }

    /// Something the user should act on, as opposed to a passing check.
    public var needsAttention: Bool { severity != .ok }
}

struct SecurityResponse: Decodable { let findings: [SecurityFinding] }

/// What came back from applying a fix.
public struct RemediationResult: Decodable, Sendable {
    public let applied: Bool
    public let remediation: String
    public let rollback: String?
    /// The rule read back from the machine, when it could be. Nil means applied but unconfirmed.
    public let verified: String?
}
