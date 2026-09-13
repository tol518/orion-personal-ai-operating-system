import XCTest
@testable import OrionKit

final class UsageDecodingTests: XCTestCase {
    private func summary(_ json: String) throws -> UsageSummary {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = ISO8601DateFormatter.orionFractional.date(from: text)
                ?? ISO8601DateFormatter.orionPlain.date(from: text)
            else { throw DecodingError.dataCorruptedError(in: try decoder.singleValueContainer(), debugDescription: "bad date") }
            return date
        }
        return try decoder.decode(UsageSummary.self, from: Data(json.utf8))
    }

    private let fullReport = """
    {"range":"7d",
     "total":{"totalTokens":1500000,"totalCost":12.3456,"input":1100000,"output":400000,"cacheRead":50000},
     "agents":[{"agentId":"main","totalTokens":1000000,"totalCost":10.0,"input":700000,"output":300000,"cacheRead":0}],
     "codexWeeklyLimit":{"usedPercent":42.6,"remainingPercent":57.4,"planType":"pro",
       "resetsAt":"2026-09-15T16:00:00.000Z","updatedAt":"2026-09-12T16:00:00.000Z"},
     "pricing":{"unpricedModels":["x/y"],"estimated":true}}
    """

    func testDecodesAFullReport() throws {
        let usage = try summary(fullReport)
        XCTAssertEqual(usage.total.totalTokens, 1_500_000)
        XCTAssertEqual(usage.agents.first?.agentId, "main")
        XCTAssertEqual(usage.codexWeeklyLimit?.planType, "pro")
        XCTAssertTrue(usage.pricing.estimated)
    }

    func testDecodesAReportWithNoCodexReading() throws {
        // The allowance comes from local Codex logs, which may simply not be there.
        let usage = try summary("""
        {"range":"1d","total":{"totalTokens":0,"totalCost":0,"input":0,"output":0,"cacheRead":0},
         "agents":[],"codexWeeklyLimit":null,"pricing":{"unpricedModels":[],"estimated":false}}
        """)
        XCTAssertNil(usage.codexWeeklyLimit)
        XCTAssertFalse(usage.pricing.estimated)
    }

    func testRangeLabels() throws {
        XCTAssertEqual(try summary(fullReport).rangeLabel, "Last 7 days")
        for (range, label) in [("1d", "Today"), ("30d", "Last 30 days"), ("90d", "Last 90 days")] {
            let usage = try summary("""
            {"range":"\(range)","total":{"totalTokens":0,"totalCost":0,"input":0,"output":0,"cacheRead":0},
             "agents":[],"codexWeeklyLimit":null,"pricing":{"unpricedModels":[],"estimated":false}}
            """)
            XCTAssertEqual(usage.rangeLabel, label)
        }
    }
}

final class UsageFormatterTests: XCTestCase {
    func testTokenCountsStayReadable() {
        XCTAssertEqual(UsageFormatter.tokens(0), "0")
        XCTAssertEqual(UsageFormatter.tokens(999), "999")
        XCTAssertEqual(UsageFormatter.tokens(1_500), "1.5k")
        XCTAssertEqual(UsageFormatter.tokens(48_200), "48k")
        XCTAssertEqual(UsageFormatter.tokens(1_482_913), "1.5M")
    }

    func testSubCentCostsStayVisible() {
        // Rounding a real charge to "$0.00" would read as free.
        XCTAssertEqual(UsageFormatter.cost(0), "$0.00")
        XCTAssertEqual(UsageFormatter.cost(0.004), "<$0.01")
        XCTAssertEqual(UsageFormatter.cost(1.239), "$1.24")
    }

    func testSpokenCostAvoidsSymbols() {
        XCTAssertEqual(UsageFormatter.spokenCost(0.004), "under one cent")
        XCTAssertEqual(UsageFormatter.spokenCost(0.42), "42 cents")
        XCTAssertEqual(UsageFormatter.spokenCost(12.5), "12.50 dollars")
    }

    func testSpokenTokensAvoidAbbreviations() {
        XCTAssertEqual(UsageFormatter.spokenTokens(500), "500 tokens")
        XCTAssertEqual(UsageFormatter.spokenTokens(48_200), "48 thousand tokens")
        XCTAssertEqual(UsageFormatter.spokenTokens(1_500_000), "1.5 million tokens")
    }

    private func makeSummary(
        cost: Double,
        tokens: Int,
        estimated: Bool,
        limit: CodexWeeklyLimit?
    ) -> UsageSummary {
        let json = """
        {"range":"7d",
         "total":{"totalTokens":\(tokens),"totalCost":\(cost),"input":0,"output":0,"cacheRead":0},
         "agents":[],
         "codexWeeklyLimit":\(limit.map { "{\"usedPercent\":\(100 - $0.remainingPercent),\"remainingPercent\":\($0.remainingPercent),\"planType\":null,\"resetsAt\":null,\"updatedAt\":null}" } ?? "null"),
         "pricing":{"unpricedModels":\(estimated ? "[\"x\"]" : "[]"),"estimated":\(estimated)}}
        """
        return try! JSONDecoder().decode(UsageSummary.self, from: Data(json.utf8))
    }

    private func limit(remaining: Double) -> CodexWeeklyLimit {
        try! JSONDecoder().decode(
            CodexWeeklyLimit.self,
            from: Data(#"{"usedPercent":\#(100 - remaining),"remainingPercent":\#(remaining),"planType":null,"resetsAt":null,"updatedAt":null}"#.utf8)
        )
    }

    func testSpokenSummaryStatesSpendAndAllowance() {
        let sentence = UsageFormatter.spokenSummary(
            makeSummary(cost: 12.5, tokens: 1_500_000, estimated: false, limit: limit(remaining: 57.4))
        )
        XCTAssertTrue(sentence.contains("12.50 dollars"), sentence)
        XCTAssertTrue(sentence.contains("57 percent"), sentence)
    }

    func testSpokenSummarySaysWhenTheCostIsAFloor() {
        // "at least" matters: an unpriced model means the real spend is higher.
        let sentence = UsageFormatter.spokenSummary(
            makeSummary(cost: 3, tokens: 100, estimated: true, limit: nil)
        )
        XCTAssertTrue(sentence.contains("at least"), sentence)
    }

    func testSpokenSummaryFallsBackToTokensThenToNothing() {
        let tokensOnly = UsageFormatter.spokenSummary(
            makeSummary(cost: 0, tokens: 48_200, estimated: false, limit: nil)
        )
        XCTAssertTrue(tokensOnly.contains("48 thousand tokens"), tokensOnly)

        let nothing = UsageFormatter.spokenSummary(
            makeSummary(cost: 0, tokens: 0, estimated: false, limit: nil)
        )
        XCTAssertTrue(nothing.contains("No usage recorded"), nothing)
    }

    func testSpokenCodexLimitExplainsAMissingReading() {
        let sentence = UsageFormatter.spokenCodexLimit(nil)
        XCTAssertTrue(sentence.contains("Codex desktop logs"), sentence)
    }

    func testEverySpokenSentenceEndsAsASentence() {
        // These are read aloud, so each has to stand on its own.
        let sentences = [
            UsageFormatter.spokenSummary(makeSummary(cost: 1, tokens: 1, estimated: false, limit: nil)),
            UsageFormatter.spokenCodexLimit(limit(remaining: 10)),
            UsageFormatter.spokenCodexLimit(nil),
        ]
        for sentence in sentences {
            XCTAssertTrue(sentence.hasSuffix("."), "“\(sentence)” should end as a sentence")
        }
    }
}
