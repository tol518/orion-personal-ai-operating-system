import SwiftUI

public enum OrionScreen: String, CaseIterable, Identifiable, Hashable {
    case home, agents, chat, nodes, settings

    public var id: String { rawValue }

    var title: String {
        switch self {
        case .home: return "Home"
        case .agents: return "Agents"
        case .chat: return "Chat"
        case .nodes: return "Nodes"
        case .settings: return "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .home: return "gauge.with.dots.needle.33percent"
        case .agents: return "person.2.circle"
        case .chat: return "bubble.left.and.bubble.right"
        case .nodes: return "desktopcomputer.and.macbook"
        case .settings: return "gearshape"
        }
    }
}

/// The app shell. Until the Mac is connected to a Mini there is nothing real to show, so the
/// connection screen replaces the whole window rather than appearing as one tab among others.
public struct RootView: View {
    @Bindable var store: OrionStore
    @State private var screen: OrionScreen = .home

    public init(store: OrionStore) {
        self.store = store
    }

    public var body: some View {
        Group {
            if store.connection.isConnected {
                connectedBody
            } else {
                ConnectionView(store: store)
            }
        }
        .frame(minWidth: 860, minHeight: 560)
        .task { await store.start() }
    }

    private var connectedBody: some View {
        NavigationSplitView {
            List(OrionScreen.allCases, selection: $screen) { item in
                NavigationLink(value: item) {
                    Label(item.title, systemImage: item.symbol)
                }
            }
            .navigationSplitViewColumnWidth(min: 168, ideal: 184, max: 220)
            .safeAreaInset(edge: .bottom) {
                GatewayBadge(connected: store.gatewayConnected, reason: store.gatewayReason)
                    .padding(12)
            }
        } detail: {
            switch screen {
            case .home: HomeView(store: store)
            case .agents: AgentsView(store: store, onOpenChat: { screen = .chat })
            case .chat: ChatView(store: store)
            case .nodes: NodesView(store: store)
            case .settings: SettingsView(store: store)
            }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(get: { store.lastError != nil }, set: { if !$0 { store.clearError() } })
        ) {
            Button("OK") { store.clearError() }
        } message: {
            Text(store.lastError ?? "")
        }
    }
}

/// Gateway reachability, shown everywhere because every screen depends on it.
struct GatewayBadge: View {
    let connected: Bool
    let reason: String?

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(connected ? Color.green : Color.orange)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(connected ? "Gateway connected" : "Gateway unavailable")
                    .font(.caption.weight(.medium))
                if let reason, !connected {
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .background(.quinary, in: RoundedRectangle(cornerRadius: 8))
    }
}
