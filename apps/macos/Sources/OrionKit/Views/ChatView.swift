import SwiftUI

/// Screen 4: select an agent/session, send a turn, stream the reply, surface failures.
///
/// This is the vertical slice the plan asks for. The session lives on the Mini, so closing this
/// window or quitting the app does not stop a run — it keeps going and the transcript catches up
/// on the next history read.
struct ChatView: View {
    @Bindable var store: OrionStore
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        HSplitView {
            sessionList
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 340)
            transcript
                .frame(minWidth: 420)
        }
        .navigationTitle("Chat")
    }

    // MARK: Sessions

    private var sessionList: some View {
        VStack(spacing: 0) {
            if store.sessions.isEmpty {
                EmptyHint(text: "No sessions. Start one from the Agents screen.")
                    .padding(12)
                Spacer()
            } else {
                List(selection: sessionSelection) {
                    ForEach(store.sessions) { session in
                        SessionRow(session: session, agentName: agentName(for: session))
                            .tag(session.key)
                    }
                }
                .listStyle(.sidebar)
            }
        }
    }

    private var sessionSelection: Binding<String?> {
        Binding(
            get: { store.selectedSessionKey },
            set: { key in
                guard let key else { return }
                Task { await store.selectSession(key) }
            }
        )
    }

    // MARK: Transcript

    @ViewBuilder
    private var transcript: some View {
        if store.selectedSessionKey == nil {
            ContentUnavailableView(
                "No session selected",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Pick a session on the left, or start one from the Agents screen.")
            )
        } else {
            VStack(spacing: 0) {
                if !store.gatewayConnected {
                    banner(
                        "The Mini cannot reach the OpenClaw gateway. Sending will fail until it reconnects.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                }
                messageScroll
                Divider()
                composer
            }
        }
    }

    private var messageScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if store.isLoadingTranscript {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Loading conversation…").font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.top, 8)
                    }
                    ForEach(store.messages) { message in
                        MessageBubble(message: message)
                    }
                    if let streaming = store.streamingReply {
                        MessageBubble(
                            message: ChatMessage(role: .agent, text: streaming.isEmpty ? "…" : streaming)
                        )
                        .id(Self.streamingAnchor)
                    }
                    // Anchor so a new turn scrolls into view without measuring content height.
                    Color.clear.frame(height: 1).id(Self.bottomAnchor)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: store.messages.count) { scrollToBottom(proxy) }
            .onChange(of: store.streamingReply) { scrollToBottom(proxy) }
            .onChange(of: store.selectedSessionKey) { scrollToBottom(proxy) }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    .padding(8)
                    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
                    .onSubmit { Task { await send() } }
                Button {
                    Task { await send() }
                } label: {
                    if store.isSending {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                }
                .buttonStyle(.plain)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isSending)
                .keyboardShortcut(.return, modifiers: [.command])
            }
            Text(store.isSending
                 ? "Waiting for the agent. The run continues on the Mini even if you close this window."
                 : "Runs execute on the Mini. This window is a view onto them.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(12)
    }

    private func banner(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption)
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(.orange.opacity(0.1))
    }

    private func send() async {
        let text = draft
        draft = ""
        composerFocused = true
        await store.send(text)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.18)) {
            proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
        }
    }

    private func agentName(for session: DesktopSession) -> String {
        store.agents.first { $0.id == session.agentId }?.name ?? session.agentId
    }

    private static let bottomAnchor = "orion.transcript.bottom"
    private static let streamingAnchor = "orion.transcript.streaming"
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: symbol).font(.caption2).foregroundStyle(tint)
                Text(label).font(.caption2.weight(.semibold)).foregroundStyle(tint)
            }
            Text(message.text)
                .textSelection(.enabled)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if !message.citedMemories.isEmpty {
                Text("Memory: \(message.citedMemories.joined(separator: ", "))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: 10))
    }

    private var label: String {
        switch message.role {
        case .user: return "You"
        case .agent: return "Agent"
        case .failure: return "Failed"
        }
    }

    private var symbol: String {
        switch message.role {
        case .user: return "person.fill"
        case .agent: return "sparkles"
        case .failure: return "exclamationmark.triangle.fill"
        }
    }

    private var tint: Color {
        switch message.role {
        case .user: return .secondary
        case .agent: return .accentColor
        case .failure: return .orange
        }
    }

    private var background: some ShapeStyle {
        switch message.role {
        case .user: return AnyShapeStyle(.quinary)
        case .agent: return AnyShapeStyle(.background.secondary)
        case .failure: return AnyShapeStyle(Color.orange.opacity(0.1))
        }
    }
}
