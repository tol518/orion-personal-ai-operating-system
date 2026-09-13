import Foundation

/// Token and cost totals for one scope.
public struct UsageTotals: Decodable, Sendable, Equatable {
    public let totalTokens: Int
    public let totalCost: Double
    public let input: Int
    public let output: Int
    public let cacheRead: Int

    public init(totalTokens: Int, totalCost: Double, input: Int, output: Int, cacheRead: Int) {
        self.totalTokens = totalTokens
        self.totalCost = totalCost
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
    }
}

public struct AgentUsage: Decodable, Sendable, Identifiable, Equatable {
    public var id: String { agentId }
    public let agentId: String
    public let totalTokens: Int
    public let totalCost: Double
    public let input: Int
    public let output: Int
    public let cacheRead: Int
}

/// The Codex weekly allowance, which is a percentage window rather than a token budget.
public struct CodexWeeklyLimit: Decodable, Sendable, Equatable {
    public let usedPercent: Double
    public let remainingPercent: Double
    public let planType: String?
    public let resetsAt: Date?
    public let updatedAt: Date?
}

public struct UsageSummary: Decodable, Sendable, Equatable {
    /// How complete the cost figures are.
    public struct Pricing: Decodable, Sendable, Equatable {
        public let unpricedModels: [String]
        /// True when some models have no known rate, so `totalCost` is a floor rather than a total.
        public let estimated: Bool
    }

    public let range: String
    public let total: UsageTotals
    public let agents: [AgentUsage]
    public let codexWeeklyLimit: CodexWeeklyLimit?
    public let pricing: Pricing

    /// A human range label, since the wire format is terse ("7d").
    public var rangeLabel: String {
        guard let days = Int(range.dropLast()), range.hasSuffix("d") else { return range }
        switch days {
        case 1: return "Today"
        case 7: return "Last 7 days"
        case 30: return "Last 30 days"
        default: return "Last \(days) days"
        }
    }
}

public enum UsageFormatter {
    /// Compact token counts: a screen showing 1,482,913 reads worse than 1.5M.
    public static func tokens(_ count: Int) -> String {
        switch count {
        case 1_000_000...:
            return String(format: "%.1fM", Double(count) / 1_000_000)
        case 10_000...:
            return String(format: "%.0fk", Double(count) / 1_000)
        case 1_000...:
            return String(format: "%.1fk", Double(count) / 1_000)
        default:
            return "\(count)"
        }
    }

    /// Costs are small, so sub-cent amounts still need to be visible rather than rounding to $0.
    public static func cost(_ amount: Double) -> String {
        if amount > 0 && amount < 0.01 { return "<$0.01" }
        return String(format: "$%.2f", amount)
    }

    /// One sentence for Siri. Spoken, so it avoids symbols and abbreviations.
    public static func spokenSummary(_ usage: UsageSummary) -> String {
        var parts: [String] = []
        let cost = usage.total.totalCost
        let spend = usage.pricing.estimated ? "at least " : ""
        if cost > 0 {
            parts.append("You have spent \(spend)\(spokenCost(cost)) over the \(usage.rangeLabel.lowercased()).")
        } else if usage.total.totalTokens > 0 {
            parts.append("\(spokenTokens(usage.total.totalTokens)) used over the \(usage.rangeLabel.lowercased()).")
        } else {
            parts.append("No usage recorded over the \(usage.rangeLabel.lowercased()).")
        }
        if let limit = usage.codexWeeklyLimit {
            parts.append("Codex has \(Int(limit.remainingPercent.rounded())) percent of its weekly allowance left.")
        }
        return parts.joined(separator: " ")
    }

    /// Just the Codex allowance, for the narrower question.
    public static func spokenCodexLimit(_ limit: CodexWeeklyLimit?) -> String {
        guard let limit else {
            return "Orion has no Codex allowance reading. That comes from the Codex desktop logs on the Mini."
        }
        var sentence = "Codex has \(Int(limit.remainingPercent.rounded())) percent of its weekly allowance left"
        if let resets = limit.resetsAt {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .full
            sentence += ", resetting \(formatter.localizedString(for: resets, relativeTo: Date()))"
        }
        return sentence + "."
    }

    static func spokenCost(_ amount: Double) -> String {
        if amount < 0.01 { return "under one cent" }
        if amount < 1 { return "\(Int((amount * 100).rounded())) cents" }
        return String(format: "%.2f dollars", amount)
    }

    static func spokenTokens(_ count: Int) -> String {
        switch count {
        case 1_000_000...:
            return String(format: "%.1f million tokens", Double(count) / 1_000_000)
        case 1_000...:
            return String(format: "%.0f thousand tokens", Double(count) / 1_000)
        default:
            return "\(count) tokens"
        }
    }
}
