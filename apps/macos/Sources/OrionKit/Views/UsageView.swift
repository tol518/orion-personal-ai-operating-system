import SwiftUI

/// Token spend and the Codex weekly allowance.
///
/// The Mini already computes all of this for the web client; this screen is a second reader of
/// the same report, not a second calculation.
struct UsageView: View {
    @Bindable var store: OrionStore

    private static let ranges = [("1d", "Today"), ("7d", "7 days"), ("30d", "30 days")]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                rangePicker
                if let usage = store.usage {
                    totals(usage)
                    if let limit = usage.codexWeeklyLimit { codexAllowance(limit) }
                    agents(usage)
                    if usage.pricing.estimated { pricingCaveat(usage) }
                } else if store.isLoadingUsage {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading usage…").font(.callout).foregroundStyle(.secondary)
                    }
                } else {
                    EmptyHint(text: store.usageUnavailable ?? "No usage reported yet.")
                }
            }
            .padding(20)
        }
        .navigationTitle("Usage")
        .toolbar {
            Button {
                Task { await store.refreshUsage() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
        }
        .task {
            if store.usage == nil { await store.refreshUsage() }
        }
    }

    private var rangePicker: some View {
        Picker("Range", selection: Binding(
            get: { store.usageRange },
            set: { range in Task { await store.refreshUsage(range: range) } }
        )) {
            ForEach(Self.ranges, id: \.0) { range in
                Text(range.1).tag(range.0)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(maxWidth: 320)
    }

    private func totals(_ usage: UsageSummary) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 12)], spacing: 12) {
            StatTile(
                title: "Spend",
                value: UsageFormatter.cost(usage.total.totalCost),
                detail: usage.pricing.estimated ? "at least — some models unpriced" : usage.rangeLabel
            )
            StatTile(
                title: "Tokens",
                value: UsageFormatter.tokens(usage.total.totalTokens),
                detail: usage.rangeLabel
            )
            StatTile(
                title: "Input",
                value: UsageFormatter.tokens(usage.total.input),
                detail: usage.total.cacheRead > 0
                    ? "\(UsageFormatter.tokens(usage.total.cacheRead)) from cache"
                    : nil
            )
            StatTile(title: "Output", value: UsageFormatter.tokens(usage.total.output), detail: nil)
        }
    }

    private func codexAllowance(_ limit: CodexWeeklyLimit) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Codex weekly allowance", trailing: limit.planType?.capitalized)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(Int(limit.remainingPercent.rounded()))%")
                        .font(.title.weight(.semibold))
                        .foregroundStyle(remainingTint(limit.remainingPercent))
                    Text("remaining").font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    if let resets = limit.resetsAt {
                        Text("resets \(resets.formatted(.relative(presentation: .numeric)))")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                ProgressView(value: max(0, min(1, limit.usedPercent / 100)))
                    .tint(remainingTint(limit.remainingPercent))
                if let updated = limit.updatedAt {
                    Text("Read from the Codex desktop logs \(updated.formatted(.relative(presentation: .numeric)))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(14)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func agents(_ usage: UsageSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "By agent", trailing: nil)
            if usage.agents.isEmpty {
                EmptyHint(text: "No agent used tokens in this range.")
            } else {
                VStack(spacing: 0) {
                    ForEach(usage.agents) { agent in
                        HStack(spacing: 10) {
                            Text(agentName(agent.agentId)).font(.callout)
                            Spacer(minLength: 12)
                            Text(UsageFormatter.tokens(agent.totalTokens))
                                .font(.callout.monospacedDigit())
                                .foregroundStyle(.secondary)
                            Text(UsageFormatter.cost(agent.totalCost))
                                .font(.callout.monospacedDigit())
                                .frame(minWidth: 64, alignment: .trailing)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        if agent.id != usage.agents.last?.id { Divider() }
                    }
                }
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    /// Says plainly that the cost is a floor. A partial number presented as a total is the kind
    /// of figure people make decisions on.
    private func pricingCaveat(_ usage: UsageSummary) -> some View {
        Label(
            "Costs exclude \(usage.pricing.unpricedModels.count) model\(usage.pricing.unpricedModels.count == 1 ? "" : "s") with no known rate, so the real total is higher.",
            systemImage: "info.circle"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func remainingTint(_ remaining: Double) -> Color {
        if remaining <= 10 { return .red }
        if remaining <= 25 { return .orange }
        return .green
    }

    /// Prefers the agent's real name, falling back to the id the report carries.
    private func agentName(_ agentId: String) -> String {
        store.agents.first { $0.id == agentId }?.name ?? agentId
    }
}
