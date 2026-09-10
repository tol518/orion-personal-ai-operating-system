import SwiftUI

/// Screen 6: trusted Mini address, connection controls, notifications, and what this app can see.
struct SettingsView: View {
    @Bindable var store: OrionStore
    @State private var host = ""
    @State private var showUnpairConfirmation = false

    var body: some View {
        Form {
            Section("Connection") {
                TextField("Mini address", text: $host)
                    .onSubmit { Task { await store.updateHost(host) } }
                HStack {
                    Button("Apply") { Task { await store.updateHost(host) } }
                        .disabled(host.trimmingCharacters(in: .whitespacesAndNewlines) == store.settings.host)
                    Button("Reconnect") { Task { await store.connect() } }
                    Spacer()
                }
                if let health = store.connection.health {
                    LabeledContent("Paired as", value: health.client.clientName)
                    LabeledContent("Client id", value: health.client.clientId)
                    LabeledContent("Pairing expires") {
                        Text(health.client.expiresAt, format: .dateTime.day().month().year())
                    }
                }
                LabeledContent("Gateway") {
                    Text(store.gatewayConnected ? "connected" : (store.gatewayReason ?? "unavailable"))
                        .foregroundStyle(store.gatewayConnected ? .green : .orange)
                }
            }

            Section("Notifications") {
                Toggle(
                    "Notify when an agent finishes or the connection drops",
                    isOn: Binding(
                        get: { store.settings.notificationsEnabled },
                        set: { store.setNotificationsEnabled($0) }
                    )
                )
                Text("Notifications never include message text.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("This Mac") {
                Button("Unpair this Mac", role: .destructive) { showUnpairConfirmation = true }
                Text("Revokes this Mac's token on the Mini and removes it from your Keychain. Your agents, sessions, and memory are unaffected — they live on the Mini.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("What this app can reach") {
                capability("Existing agents and their models", allowed: true)
                capability("Sessions, transcripts, and chat", allowed: true)
                capability("Paired node status", allowed: true)
                capability("Extraction, Hunting, Finance Lab, workflow learning", allowed: false)
                capability("Terminal, file browsing, screen control", allowed: false)
                Text("Excluded features still run on the Mini. They are simply not reachable from this app.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .onAppear { host = store.settings.host }
        .confirmationDialog(
            "Unpair this Mac?",
            isPresented: $showUnpairConfirmation,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive) { Task { await store.unpair() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You will need the pairing secret from the Mini to connect again.")
        }
    }

    private func capability(_ text: String, allowed: Bool) -> some View {
        Label {
            Text(text).font(.callout)
        } icon: {
            Image(systemName: allowed ? "checkmark.circle.fill" : "minus.circle")
                .foregroundStyle(allowed ? Color.green : Color.secondary)
        }
    }
}
