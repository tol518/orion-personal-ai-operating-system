import SwiftUI

/// Screen 5: read-only status and capabilities for every node the gateway has paired.
///
/// V1 shows state only. Terminal execution, screen control, and file access are follow-on work
/// that needs its own authorization contract and audit trail — a node being online is not
/// permission to drive it.
struct NodesView: View {
    @Bindable var store: OrionStore

    var body: some View {
        Group {
            if store.nodes.isEmpty {
                ContentUnavailableView(
                    "No nodes",
                    systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                    description: Text(store.gatewayConnected
                        ? "The gateway has no paired nodes."
                        : "The Mini cannot reach the OpenClaw gateway, so nodes are not listed.")
                )
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(store.nodes) { node in
                            NodeCard(node: node)
                        }
                        Text("Read-only in this release. Remote execution, screen control, and file access require a separate authorization model.")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 4)
                    }
                    .padding(20)
                }
            }
        }
        .navigationTitle("Nodes")
        .toolbar {
            Button {
                Task { await store.refreshNodes() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
        }
    }
}

struct NodeCard: View {
    let node: DesktopNode

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(node.name).font(.headline)
                    StatusPill(status: node.status)
                }
                Text(node.id).font(.caption2).foregroundStyle(.tertiary).textSelection(.enabled)
                if node.capabilities.isEmpty {
                    Text("No capabilities reported")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                } else {
                    HStack(spacing: 6) {
                        ForEach(node.capabilities, id: \.self) { capability in
                            Text(capability)
                                .font(.caption2.weight(.medium))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(.quaternary, in: Capsule())
                        }
                    }
                }
                if let lastSeen = node.lastSeenAt {
                    Text("Last seen \(lastSeen.formatted(.relative(presentation: .numeric)))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }

    private var symbol: String {
        switch node.platform {
        case .macos: return "macmini"
        case .windows: return "pc"
        case .linux: return "server.rack"
        case .unknown: return "questionmark.square.dashed"
        }
    }
}

struct StatusPill: View {
    let status: DesktopNode.Status

    var body: some View {
        Text(status.rawValue)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case .online: return .green
        case .offline: return .secondary
        case .unknown: return .orange
        }
    }
}

/// Compact row used on the Home screen.
struct NodeRow: View {
    let node: DesktopNode

    var body: some View {
        HStack(spacing: 10) {
            StatusPill(status: node.status)
            Text(node.name).font(.callout)
            Spacer(minLength: 0)
            Text(node.capabilities.joined(separator: " · "))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }
}
