import SwiftUI

struct ChatSessions: View {
    let store: OrionStore
    @State private var editing: String?
    @State private var name = ""
    @FocusState private var renaming: Bool
    @State private var deleting: DesktopSession?

    private struct Row: Identifiable {
        var id: String { session.key }
        let session: DesktopSession
        let group: String
        let depth: Int
    }

    private var rows: [Row] {
        let sorted = store.visibleSessions.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
        let keys = Set(sorted.map(\.key))
        var result: [Row] = []
        var visited = Set<String>()
        func append(_ s: DesktopSession, group: String, depth: Int) {
            guard visited.insert(s.key).inserted else { return }
            result.append(Row(session: s, group: group, depth: depth))
            for child in sorted where child.parentKey == s.key { append(child, group: group, depth: depth + 1) }
        }
        for s in sorted where !keys.contains(s.parentKey ?? "") { append(s, group: s.agentId, depth: 0) }
        for s in sorted where !visited.contains(s.key) { append(s, group: s.agentId, depth: 0) }
        return result
    }

    var body: some View {
        VStack(spacing: 0) {
            List(selection: Binding(get: { store.selectedSessionKey }, set: { key in
                if let key { Task { await store.selectSession(key) } }
            })) {
                let grouped = Dictionary(grouping: rows, by: \.group)
                ForEach(grouped.keys.sorted(), id: \.self) { group in
                    Section(store.agentName(group)) {
                        ForEach(grouped[group] ?? []) { row in
                            sessionRow(row.session).padding(.leading, CGFloat(row.depth * 12)).tag(row.id)
                        }
                    }
                }
            }.listStyle(.sidebar)
            Divider()
            Toggle("Show archived", isOn: Binding(get: { store.showingArchived }, set: { show in
                Task { await store.showArchived(show) }
            })).toggleStyle(.checkbox).padding(8)
        }
        .toolbar {
            Menu {
                ForEach(store.agents) { agent in
                    Button(store.agentName(agent.id)) { Task { await store.startSession(agentId: agent.id) } }
                }
            } label: { Label("New conversation", systemImage: "square.and.pencil") }
            .help("New conversation — choose an agent")
        }
        .alert("Delete conversation and transcript?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
               presenting: deleting) { session in
            Button("Delete", role: .destructive) { Task { await store.changeSession(session.key, .delete(session.agentId)) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text($0.displayTitle) }
    }

    private func sessionRow(_ s: DesktopSession) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if editing == s.key {
                TextField("Conversation title", text: $name)
                    .focused($renaming)
                    .onAppear {
                        renaming = true
                        DispatchQueue.main.async {
                            (NSApp.keyWindow?.firstResponder as? NSTextView)?.selectAll(nil)
                        }
                    }
                    .onExitCommand { editing = nil }
                    .onSubmit {
                        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
                        editing = nil
                        if !title.isEmpty { Task { await store.changeSession(s.key, .rename(title)) } }
                    }
            } else {
                HStack {
                    Text(s.displayTitle).lineLimit(1)
                    Spacer()
                    let pending = store.inbox.items.filter { $0.sessionKey == s.key && $0.status == "pending" }.count
                    if pending > 0 { Text("\(pending)").font(.caption.bold()).padding(3).background(.orange, in: Capsule()).help("Pending approvals") }
                }
                if let time = s.updatedAt { Text(time, style: .relative).font(.caption2).foregroundStyle(.secondary) }
                if let preview = s.lastMessagePreview { Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            }
        }
        .contextMenu {
            Button("Rename") { name = s.displayTitle; editing = s.key }
            if s.isMain {
                Button("Start fresh") { Task { await store.changeSession(s.key, .reset(s.agentId)) } }
            } else {
                Button(store.showingArchived ? "Restore" : "Archive") {
                    let archive = !store.showingArchived
                    Task { await store.changeSession(s.key, .archive(archive)) }
                }
                Button("Delete…", role: .destructive) { deleting = s }
            }
        }
    }
}

struct ChatControls: View {
    let store: OrionStore
    let session: DesktopSession
    @AppStorage("orion.chat.controls") private var expanded = true
    @State private var compact = false
    var body: some View {
        DisclosureGroup("Conversation controls", isExpanded: $expanded) {
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    Menu(store.agentName(session.agentId)) {
                        ForEach(store.agents) { agent in
                            Button(store.agentName(agent.id)) {
                                Task {
                                    if let next = store.sessions.first(where: { $0.agentId == agent.id }) {
                                        await store.selectSession(next.key)
                                    } else { await store.startSession(agentId: agent.id) }
                                }
                            }
                        }
                    }
                    Menu(session.model ?? store.chatModels?.current ?? "Model") {
                        ForEach(store.chatModels?.models ?? []) { model in
                            Button(model.label) { change(.model(model.id, agent: session.agentId)) }
                        }
                    }.disabled(store.chatModels?.models.isEmpty != false)
                    if let options = session.thinkingOptions, !options.isEmpty {
                        Menu(session.thinkingLevel ?? "Thinking") {
                            ForEach(options, id: \.self) { level in Button(level) { change(.thinking(level)) } }
                        }.help("Thinking level")
                    }
                    Menu(targetName(store.executionTarget?.target ?? "neutral")) {
                        ForEach(["mac", "neutral", "windows"], id: \.self) { target in
                            Button(targetName(target)) { change(.target(target, agent: session.agentId)) }
                                .disabled(target != "neutral" && store.executionTarget?.devices[target]?.available != true)
                        }
                    }.disabled(store.executionTarget == nil)
                    if let usage = session.contextUsage {
                        ProgressView(value: usage) { Text("Context \(Int(usage * 100))%") }.frame(width: 85)
                            .help("\(session.totalTokens ?? 0) of \(session.contextTokens ?? 0) tokens")
                    } else { Text("Context —").foregroundStyle(.secondary) }
                    Button("Compact…") { compact = true }.disabled(store.isSending || store.isLoadingTranscript)
                }.controlSize(.small).font(.caption).padding(.vertical, 3)
            }
        }
        .padding(8)
        .disabled(store.changingSessions.contains(session.key))
        .confirmationDialog("Replace this transcript with a summary?", isPresented: $compact) {
            Button("Compact conversation") { change(.compact) }
        }
    }

    private func targetName(_ value: String) -> String { value == "mac" ? "Mac" : value == "windows" ? "Windows" : "Both" }
    private func change(_ action: SessionChange) { Task { await store.changeSession(session.key, action) } }
}
