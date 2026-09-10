import SwiftUI

/// Screen 2: gateway/BFF status, active sessions, and a node summary.
struct HomeView: View {
    @Bindable var store: OrionStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                statusTiles
                activeSessions
                nodeSummary
            }
            .padding(20)
        }
        .navigationTitle("Home")
        .toolbar {
            Button {
                Task { await store.refreshAll() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
        }
    }

    private var statusTiles: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 12)], spacing: 12) {
            StatTile(
                title: "Mini",
                value: store.connection.isConnected ? "Reachable" : "Unreachable",
                detail: store.connection.health.map { "as \($0.client.clientName)" }
            )
            StatTile(
                title: "Gateway",
                value: store.gatewayConnected ? "Connected" : "Unavailable",
                detail: store.gatewayReason
            )
            StatTile(title: "Agents", value: "\(store.agents.count)", detail: "on the Mini")
            StatTile(
                title: "Nodes online",
                value: "\(store.nodes.filter { $0.status == .online }.count)",
                detail: "of \(store.nodes.count) paired"
            )
        }
    }

    private var activeSessions: some View {
        Section {
            if store.sessions.isEmpty {
                EmptyHint(text: "No sessions yet. Start one from the Agents screen.")
            } else {
                VStack(spacing: 0) {
                    ForEach(store.sessions.prefix(6)) { session in
                        SessionRow(session: session, agentName: agentName(for: session))
                        if session.id != store.sessions.prefix(6).last?.id { Divider() }
                    }
                }
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
            }
        } header: {
            SectionHeader(title: "Recent sessions", trailing: "\(store.sessions.count)")
        }
    }

    private var nodeSummary: some View {
        Section {
            if store.nodes.isEmpty {
                EmptyHint(text: "No paired nodes reported by the gateway.")
            } else {
                VStack(spacing: 0) {
                    ForEach(store.nodes) { node in
                        NodeRow(node: node)
                        if node.id != store.nodes.last?.id { Divider() }
                    }
                }
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
            }
        } header: {
            SectionHeader(title: "Nodes", trailing: nil)
        }
    }

    private func agentName(for session: DesktopSession) -> String {
        store.agents.first { $0.id == session.agentId }?.name ?? session.agentId
    }
}

struct StatTile: View {
    let title: String
    let value: String
    let detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.semibold))
            if let detail {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
    }
}

struct SectionHeader: View {
    let title: String
    let trailing: String?

    var body: some View {
        HStack {
            Text(title).font(.headline)
            Spacer()
            if let trailing {
                Text(trailing).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.bottom, 4)
    }
}

struct EmptyHint: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
    }
}

struct SessionRow: View {
    let session: DesktopSession
    let agentName: String

    var body: some View {
        HStack(spacing: 10) {
            if session.hasActiveRun {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "bubble.left")
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).font(.callout).lineLimit(1)
                HStack(spacing: 6) {
                    Text(agentName)
                    if let updated = session.updatedAt {
                        Text("·")
                        Text(updated, format: .relative(presentation: .numeric))
                    }
                    if let model = session.model {
                        Text("·")
                        Text(model).lineLimit(1)
                    }
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }
}
