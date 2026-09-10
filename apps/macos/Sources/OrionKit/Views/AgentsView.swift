import SwiftUI

/// Screen 3: the existing agents on the Mini and the models available to each.
///
/// This screen is read-only by design. Creating agents, changing default models, and editing
/// appearance stay in the web client for V1 — the native app selects from what already exists.
struct AgentsView: View {
    @Bindable var store: OrionStore
    let onOpenChat: () -> Void
    @State private var startingAgentId: String?

    var body: some View {
        Group {
            if store.agents.isEmpty {
                ContentUnavailableView(
                    "No agents",
                    systemImage: "person.2.slash",
                    description: Text(store.gatewayConnected
                        ? "The gateway reported no agents."
                        : "The Mini cannot reach the OpenClaw gateway, so its agents are not listed.")
                )
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 12)], spacing: 12) {
                        ForEach(store.agents) { agent in
                            AgentCard(
                                agent: agent,
                                sessionCount: store.sessions.filter { $0.agentId == agent.id }.count,
                                isStarting: startingAgentId == agent.id,
                                onStart: { Task { await start(agent) } }
                            )
                        }
                    }
                    .padding(20)
                }
            }
        }
        .navigationTitle("Agents")
        .toolbar {
            Button {
                Task { await store.refreshAll() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
        }
    }

    private func start(_ agent: DesktopAgent) async {
        startingAgentId = agent.id
        defer { startingAgentId = nil }
        await store.startSession(agentId: agent.id)
        // The new session is selected by the store; move the user to where they can use it.
        if store.selectedSessionKey != nil { onOpenChat() }
    }
}

struct AgentCard: View {
    let agent: DesktopAgent
    let sessionCount: Int
    let isStarting: Bool
    let onStart: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "person.crop.circle")
                    .font(.title2)
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(agent.name).font(.headline).lineLimit(1)
                    Text(agent.id).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }

            if let description = agent.description, !description.isEmpty {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 3) {
                LabeledContent("Model") {
                    Text(agent.currentModel ?? "gateway default")
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                LabeledContent("Available") { Text("\(agent.models.count)") }
                LabeledContent("Sessions") { Text("\(sessionCount)") }
            }
            .font(.caption)

            Button(action: onStart) {
                if isStarting {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Starting…")
                    }
                } else {
                    Text("Start a session")
                }
            }
            .disabled(isStarting)
            .frame(maxWidth: .infinity)
        }
        .padding(14)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }
}
