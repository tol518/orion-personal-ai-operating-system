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
            if store.nodes.isEmpty && store.miniRemoteAccess == nil && store.remoteMachines.isEmpty {
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
                        // The Mini first: it hosts the runtime, and it is the machine most likely
                        // to be wanted as a desktop. It is listed whether or not the gateway
                        // also registers it as an execution node.
                        if let mini = store.miniRemoteAccess {
                            MiniCard(
                                access: mini,
                                isLaunching: store.launchingNodeId == mini.nodeId,
                                onConnect: { kind in
                                    Task { await store.openRemoteSession(nodeId: mini.nodeId, kind: kind) }
                                }
                            )
                        }
                        ForEach(store.remoteMachines) { machine in
                            MachineCard(
                                machine: machine,
                                isLaunching: store.launchingNodeId == machine.nodeId,
                                onConnect: { kind in
                                    Task { await store.openRemoteSession(nodeId: machine.nodeId, kind: kind) }
                                }
                            )
                        }
                        if !store.nodes.isEmpty {
                            Text("Paired execution nodes")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                                .padding(.top, 4)
                        }
                        ForEach(store.nodes) { node in
                            NodeCard(
                                node: node,
                                access: store.remoteAccess(for: node.id),
                                isLaunching: store.launchingNodeId == node.id,
                                onConnect: { kind in
                                    Task { await store.openRemoteSession(nodeId: node.id, kind: kind) }
                                }
                            )
                        }
                        if let unavailable = store.remoteAccessUnavailable {
                            Label(unavailable, systemImage: "info.circle")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.top, 4)
                        }
                        Text("Connecting opens macOS Screen Sharing or the Windows App over your private network. Orion does not carry the screen itself — those handle video, audio, clipboard, and file transfer natively. Agent-driven execution and file access still require a separate authorization model.")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
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

/// The Mini's own card. Separate from NodeCard because the Mini is not a paired node: it has no
/// gateway capability list, and it is the runtime host rather than an execution target.
struct MiniCard: View {
    let access: RemoteAccessNode
    let isLaunching: Bool
    let onConnect: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "macmini.fill")
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text("Mac mini").font(.headline)
                    Text("runtime host")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.18), in: Capsule())
                        .foregroundStyle(Color.accentColor)
                }
                if let host = access.host {
                    Text(host)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }
                Text("Orion's agents, sessions, and memory all live here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if access.launchableServices.isEmpty {
                    Text(access.host == nil
                         ? (access.hint ?? "No address for this Mini.")
                         : "Screen Sharing is off. Turn it on in System Settings → General → Sharing on the Mini.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    HStack(spacing: 8) {
                        ForEach(access.launchableServices) { service in
                            Button {
                                onConnect(service.kind)
                            } label: {
                                if isLaunching {
                                    HStack(spacing: 6) {
                                        ProgressView().controlSize(.small)
                                        Text("Opening…")
                                    }
                                } else {
                                    Label("Open desktop", systemImage: "display")
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(isLaunching)
                            .help("Opens \(service.label) on \(access.host ?? "the Mini")")
                        }
                        Text("via Screen Sharing")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                ForEach(access.services.filter(\.isExposedBeyondTailnet)) { service in
                    ExposureWarning(service: service)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// A machine listed by configuration on the Mini. It has no gateway status, because it need not
/// be an execution node at all — being reachable for remote desktop is a separate relationship.
struct MachineCard: View {
    let machine: RemoteMachine
    let isLaunching: Bool
    let onConnect: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 6) {
                Text(machine.label).font(.headline)
                Text(machine.host)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)

                if machine.launchableServices.isEmpty {
                    Text(unavailableHint)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    HStack(spacing: 8) {
                        ForEach(machine.launchableServices) { service in
                            Button {
                                onConnect(service.kind)
                            } label: {
                                if isLaunching {
                                    HStack(spacing: 6) {
                                        ProgressView().controlSize(.small)
                                        Text("Opening…")
                                    }
                                } else {
                                    Label("Open desktop", systemImage: "display")
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(isLaunching)
                            .help("Opens \(service.label) on \(machine.host)")
                        }
                        if let first = machine.launchableServices.first {
                            Text("via \(first.label)")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                ForEach(machine.services.filter(\.isExposedBeyondTailnet)) { service in
                    ExposureWarning(service: service)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }

    private var symbol: String {
        switch machine.platform {
        case .macos: return "macmini"
        case .windows: return "pc"
        case .linux: return "server.rack"
        case .unknown: return "questionmark.square.dashed"
        }
    }

    /// Names the setting to change rather than only reporting absence.
    private var unavailableHint: String {
        switch machine.platform {
        case .windows:
            return "Remote Desktop is not answering. Enable Settings → System → Remote Desktop on this PC (needs Windows Pro), and check it is awake."
        case .macos:
            return "Screen Sharing is off. Turn it on in System Settings → General → Sharing."
        default:
            return "No remote-desktop service is answering on this machine."
        }
    }
}

struct NodeCard: View {
    let node: DesktopNode
    let access: RemoteAccessNode?
    let isLaunching: Bool
    let onConnect: (String) -> Void

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
                remoteAccessSection
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private var remoteAccessSection: some View {
        if let access {
            Divider().padding(.vertical, 2)
            if let host = access.host {
                Text(host)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
            if access.launchableServices.isEmpty {
                unavailableHint(for: access)
            } else {
                HStack(spacing: 8) {
                    ForEach(access.launchableServices) { service in
                        Button {
                            onConnect(service.kind)
                        } label: {
                            if isLaunching {
                                HStack(spacing: 6) {
                                    ProgressView().controlSize(.small)
                                    Text("Opening…")
                                }
                            } else {
                                Label("Connect", systemImage: "display")
                            }
                        }
                        .disabled(isLaunching)
                        .help("Opens \(service.label) on \(access.host ?? node.name)")
                    }
                    // Named so it is obvious which app is about to take over the screen.
                    if let first = access.launchableServices.first {
                        Text("via \(first.label)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            ForEach(access.services.filter(\.isExposedBeyondTailnet)) { service in
                ExposureWarning(service: service)
            }
        }
    }

    /// Says what to switch on, rather than only that nothing is available.
    @ViewBuilder
    private func unavailableHint(for access: RemoteAccessNode) -> some View {
        if let hint = access.hint {
            Text(hint)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        } else if node.platform == .macos {
            Text("Screen Sharing is off on this Mac. Turn it on in System Settings → General → Sharing.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        } else if node.platform == .windows {
            Text("Remote Desktop is not reachable. Enable it in Settings → System → Remote Desktop (needs Windows Pro).")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text("No remote-desktop service is reachable on this node.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
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

/// Shown under a service that answers beyond the tailnet, with the exact fix beside it.
///
/// Orion cannot close the port — that is the OS's job, and applying a firewall rule is a device
/// action that needs explicit consent first. What it can do is refuse to let this stay invisible.
struct ExposureWarning: View {
    let service: RemoteService

    var body: some View {
        if let exposure = service.exposure, service.isExposedBeyondTailnet {
            VStack(alignment: .leading, spacing: 6) {
                Label {
                    Text("\(service.label): \(exposure.summary)")
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.shield.fill")
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.orange)

                if let fix = exposure.fix {
                    Text(fix.summary)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let command = fix.command {
                        Text(command)
                            .font(.caption2.monospaced())
                            .textSelection(.enabled)
                            .padding(6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                        if let shell = fix.shell {
                            Text("Run in \(shell). Reconnect from Orion afterwards to confirm it still works.")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
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
