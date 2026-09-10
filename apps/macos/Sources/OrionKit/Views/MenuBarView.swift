import SwiftUI

/// Menu-bar entry point (Phase 4). Status at a glance plus the two actions worth having without
/// bringing the whole window forward. It deliberately exposes no agent action of its own — every
/// entry point goes through the same client and API path as the main window.
struct MenuBarView: View {
    @Bindable var store: OrionStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(store.connection.isConnected && store.gatewayConnected ? Color.green : Color.orange)
                    .frame(width: 7, height: 7)
                Text(statusText).font(.callout.weight(.medium))
            }

            if store.connection.isConnected {
                Text("\(store.agents.count) agents · \(store.sessions.count) sessions · \(onlineNodes) nodes online")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            Button("Refresh") { Task { await store.refreshAll() } }
                .disabled(!store.connection.isConnected)
            Button("Reconnect") { Task { await store.connect() } }
            Divider()
            Button("Quit Orion") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
        .padding(12)
        .frame(width: 260)
    }

    private var statusText: String {
        switch store.connection {
        case .connected:
            return store.gatewayConnected ? "Orion connected" : "Mini reachable, gateway down"
        case .connecting: return "Connecting…"
        case .needsPairing: return "Not paired"
        case .unconfigured: return "No Mini address"
        case .failed: return "Mini unreachable"
        }
    }

    private var onlineNodes: Int {
        store.nodes.filter { $0.status == .online }.count
    }
}
