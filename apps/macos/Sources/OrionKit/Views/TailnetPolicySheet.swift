import AppKit
import SwiftUI

/// Shows the tailnet policy Orion wrote, for the user to save in the Tailscale admin console.
///
/// There is no "apply" button on purpose. Saving a tailnet policy needs a key that can rewrite
/// access for every device on the tailnet; the user saves it themselves, and the tests inside it
/// make Tailscale refuse it if it would cut off anything Orion needs.
struct TailnetPolicySheet: View {
    @Bindable var store: OrionStore
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Tailnet access policy").font(.title3.weight(.semibold))
            Text(
                "Paste this into the Tailscale admin console under Access controls, replacing what is "
                    + "there. Tailscale checks the tests at the bottom and refuses the policy if any would "
                    + "fail, so a mistake is rejected rather than applied. You can revert from the "
                    + "console's history, which you reach over the internet rather than your tailnet."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            if store.isLoadingTailnetPolicy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Writing a policy for your devices…").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
            } else if let error = store.tailnetPolicyError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
            } else if let policy = store.tailnetPolicy {
                notes(for: policy)
                ScrollView {
                    Text(policy.policy)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                }
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
            }

            HStack {
                Button("Open Access Controls") { store.openTailnetAccessControls() }
                Spacer()
                Button(copied ? "Copied" : "Copy policy") {
                    guard let text = store.tailnetPolicy?.policy else { return }
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                    copied = true
                }
                .disabled(store.tailnetPolicy == nil)
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 620, minHeight: 520)
        .task { await store.loadTailnetPolicy() }
    }

    @ViewBuilder
    private func notes(for policy: TailnetPolicy) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !policy.requesterIdentified {
                Label(
                    "Orion could not tell which device this Mac is on your tailnet. Check it appears below as a client before saving.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .foregroundStyle(.orange)
            }
            Text("Allowed as your devices: \(policy.clients.joined(separator: ", "))")
            if !policy.excluded.isEmpty {
                Text("Left out — these lose all access when you save:")
                ForEach(policy.excluded, id: \.name) { entry in
                    Text("• \(entry.name): \(entry.reason)").foregroundStyle(.secondary)
                }
            }
        }
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
    }
}
