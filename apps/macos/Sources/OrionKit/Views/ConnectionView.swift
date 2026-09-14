import SwiftUI

/// Screen 1: reachability, signed-in state, and retry.
///
/// This is also where pairing happens. The pairing secret is typed once, exchanged for a token,
/// and never stored — only the returned token is kept, in the Keychain.
struct ConnectionView: View {
    @Bindable var store: OrionStore
    @State private var host: String = ""
    @State private var secret: String = ""
    @State private var isWorking = false
    @FocusState private var secretFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 18) {
                header
                hostField
                if case .needsPairing = store.connection { pairingSection }
                statusRow
            }
            .frame(maxWidth: 460)
            .padding(28)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14))
            Spacer(minLength: 0)
            footer
        }
        .padding(24)
        .onAppear { host = store.settings.host }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Connect to Orion")
                .font(.title2.weight(.semibold))
            Text("Orion runs on your Mac mini. This Mac connects to it over your private network — it does not run agents itself.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var hostField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Mini address")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                TextField("mini.your-tailnet.ts.net:4820", text: $host)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await applyHost() } }
                Button("Use") { Task { await applyHost() } }
                    .disabled(host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
            }
            Text("A Tailscale MagicDNS name is preferred over an IP address. Port 4820 is assumed, or 443 if you start the address with https://.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var pairingSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().padding(.vertical, 4)
            Text("Pair this Mac")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                SecureField("Pairing secret from the Mini", text: $secret)
                    .textFieldStyle(.roundedBorder)
                    .focused($secretFocused)
                    .onSubmit { Task { await pair() } }
                Button("Pair") { Task { await pair() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(secret.isEmpty || isWorking)
            }
            Text("This is ORION_DESKTOP_PAIRING_SECRET from the Mini's server/.env. It is exchanged once for a token stored in your Keychain, and is not saved by this app.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            Text("This Mac will pair as “\(store.settings.clientId)”.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        switch store.connection {
        case .unconfigured:
            Label("Enter the Mini's address to begin.", systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .needsPairing:
            if let error = store.pairingError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .connecting:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Connecting…").font(.caption).foregroundStyle(.secondary)
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try again") { Task { await store.connect() } }
                    .controlSize(.small)
            }
        case .connected:
            Label("Connected.", systemImage: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(.green)
        }
    }

    private var footer: some View {
        Text("Orion.app holds no gateway token, provider key, or broker credential. It reads the Mini's runtime and nothing else.")
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 520)
    }

    private func applyHost() async {
        isWorking = true
        defer { isWorking = false }
        await store.updateHost(host)
        if case .needsPairing = store.connection { secretFocused = true }
    }

    private func pair() async {
        isWorking = true
        defer { isWorking = false }
        await store.pair(withSecret: secret)
        // Held only for the duration of the exchange.
        secret = ""
    }
}
