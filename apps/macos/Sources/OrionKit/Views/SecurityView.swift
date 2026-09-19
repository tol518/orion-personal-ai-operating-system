import SwiftUI

/// The security checklist.
///
/// Exists so that a user who never reads documentation still ends up secure. Each row says what
/// is wrong in plain language; where Orion can fix it, the button shows the exact command first
/// and asks before running anything.
struct SecurityView: View {
    @Bindable var store: OrionStore
    @State private var confirming: SecurityFinding?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if store.isLoadingFindings && store.findings.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Checking…").font(.callout).foregroundStyle(.secondary)
                    }
                } else if let unavailable = store.securityUnavailable {
                    EmptyHint(text: unavailable)
                } else {
                    summary
                    ForEach(store.findings) { finding in
                        FindingRow(
                            finding: finding,
                            isApplying: store.remediatingFindingId == finding.id,
                            onFix: { confirming = finding }
                        )
                    }
                }
            }
            .padding(20)
        }
        .navigationTitle("Security")
        .toolbar {
            Button {
                Task { await store.refreshSecurity() }
            } label: {
                Label("Re-check", systemImage: "arrow.clockwise")
            }
        }
        .task {
            if store.findings.isEmpty { await store.refreshSecurity() }
        }
        // The command is shown before it runs, never after.
        .confirmationDialog(
            confirming?.remediation?.title ?? "Apply this fix?",
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible,
            presenting: confirming
        ) { finding in
            Button("Apply on \(finding.target?.label ?? "this machine")") {
                let target = finding
                confirming = nil
                Task { await store.applyRemediation(for: target) }
            }
            Button("Cancel", role: .cancel) { confirming = nil }
        } message: { finding in
            Text(confirmationMessage(for: finding))
        }
        .alert(
            "Fix applied",
            isPresented: Binding(
                get: { store.lastRemediation != nil },
                set: { if !$0 { store.dismissRemediationResult() } }
            )
        ) {
            Button("OK") { store.dismissRemediationResult() }
        } message: {
            if let applied = store.lastRemediation {
                Text(appliedMessage(applied.finding, applied.result))
            }
        }
    }

    private var summary: some View {
        let open = store.openFindings.count
        return HStack(spacing: 10) {
            Image(systemName: open == 0 ? "checkmark.shield.fill" : "exclamationmark.shield.fill")
                .font(.title2)
                .foregroundStyle(open == 0 ? Color.green : Color.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(open == 0 ? "Nothing needs your attention" : "\(open) item\(open == 1 ? "" : "s") need your attention")
                    .font(.headline)
                Text("Orion checks its own API and the machines it connects to.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
    }

    private func confirmationMessage(for finding: SecurityFinding) -> String {
        var parts = [finding.remediation?.summary ?? ""]
        if let command = finding.remediation?.command {
            parts.append("Orion will run this on \(finding.target?.label ?? "the machine"):\n\n\(command)")
        }
        if let rollback = finding.remediation?.rollback {
            parts.append("You can undo it with:\n\n\(rollback)")
        }
        return parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    private func appliedMessage(_ title: String, _ result: RemediationResult) -> String {
        var message = "\(title) was applied."
        if let verified = result.verified, !verified.isEmpty {
            // Read back from the machine rather than assumed from an exit code.
            message += "\n\nConfirmed on the machine: \(verified)"
        } else {
            message += "\n\nOrion could not read the setting back to confirm it. Check it on the machine."
        }
        if let rollback = result.rollback {
            message += "\n\nTo undo:\n\(rollback)"
        }
        return message
    }
}

struct FindingRow: View {
    let finding: SecurityFinding
    let isApplying: Bool
    let onFix: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 6) {
                Text(finding.title)
                    .font(.callout.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                Text(finding.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let remediation = finding.remediation {
                    if finding.isFixable {
                        Button(action: onFix) {
                            if isApplying {
                                HStack(spacing: 6) {
                                    ProgressView().controlSize(.small)
                                    Text("Applying…")
                                }
                            } else {
                                Label("Fix this", systemImage: "wrench.adjustable")
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(isApplying)
                    } else {
                        // No button where Orion cannot act. Saying what to do beats a control
                        // that does nothing.
                        Text(remediation.blocked ?? remediation.summary)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: 10))
    }

    private var symbol: String {
        switch finding.severity {
        case .critical: return "exclamationmark.octagon.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .info: return "info.circle"
        case .ok: return "checkmark.circle.fill"
        }
    }

    private var tint: Color {
        switch finding.severity {
        case .critical: return .red
        case .warning: return .orange
        case .info: return .secondary
        case .ok: return .green
        }
    }

    private var background: some ShapeStyle {
        switch finding.severity {
        case .critical: return AnyShapeStyle(Color.red.opacity(0.08))
        case .warning: return AnyShapeStyle(Color.orange.opacity(0.08))
        default: return AnyShapeStyle(.background.secondary)
        }
    }
}
