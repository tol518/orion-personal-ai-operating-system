import SwiftUI

struct ChatView: View {
    let store: OrionStore
    var body: some View {
        HSplitView {
            ChatSessions(store: store).frame(minWidth: 195, idealWidth: 240, maxWidth: 340)
            if let key = store.selectedSessionKey {
                VStack(spacing: 0) {
                    if let session = store.selectedSession { ChatControls(store: store, session: session) }
                    if !store.gatewayConnected {
                        Label("The Mini lost its gateway connection.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    }
                    Divider()
                    ConversationTimeline(store: store, key: key)
                    Divider()
                    ChatComposer(store: store, key: key)
                }.id(key).frame(minWidth: 410)
            } else {
                ContentUnavailableView("Select a conversation", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("Choose a session or start a new conversation."))
            }
        }.navigationTitle("Chat")
    }
}

private struct ScrollBounds: PreferenceKey {
    static let defaultValue = CGRect.zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

private struct ConversationTimeline: View {
    let store: OrionStore
    let key: String
    @State private var following = true
    @State private var bounds = CGRect.zero

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { reader in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if store.isLoadingTranscript { ProgressView("Loading conversation…").controlSize(.small) }
                        ForEach(ChatItem.timeline(store.conversation, approvals: store.inbox.items.filter {
                            $0.sessionKey == nil || $0.sessionKey == key
                        })) { item in
                            switch item {
                            case .message(let message): MessageBubble(message: message)
                            case .run(let run): RunCard(run: run)
                            case .approval(let approval): ApprovalCard(store: store, approval: approval)
                            }
                        }
                        if let reply = store.streamingReply, !reply.isEmpty {
                            MessageBubble(message: ChatMessage(role: .agent, text: TranscriptFormatter.stripHiddenMarkers(reply),
                                                               time: store.conversation.current.flatMap { store.conversation.runs[$0]?.time } ?? Date()))
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(GeometryReader { content in
                        Color.clear.preference(key: ScrollBounds.self, value: content.frame(in: .named("chatViewport")))
                    })
                }
                .coordinateSpace(name: "chatViewport")
                .onPreferenceChange(ScrollBounds.self) { next in
                    let resized = next.height != bounds.height
                    bounds = next
                    if resized && following { reader.scrollTo("bottom", anchor: .bottom) }
                    else { following = ChatFormatting.followsBottom(distance: next.maxY - viewport.size.height) }
                }
                .overlay(alignment: .bottomTrailing) {
                    if !following {
                        Button("Jump to latest") { following = true; reader.scrollTo("bottom", anchor: .bottom) }
                            .buttonStyle(.borderedProminent).padding(12)
                    }
                }
            }
        }
    }
}

struct MessageBubble: View {
    let message: ChatMessage
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(message.role == .user ? "You" : message.role == .failure ? "Failed" : "Agent").fontWeight(.semibold)
                if message.time.timeIntervalSince1970 > 0 {
                    Text(ChatFormatting.timeLabel(message.time)).help(message.time.formatted(date: .complete, time: .complete))
                }
            }.font(.caption2).foregroundStyle(.secondary)
            if message.role == .agent { MarkdownReply(text: message.text) }
            else { Text(verbatim: message.text) }
            ForEach(Array(message.attachments.enumerated()), id: \.offset) { _, name in Label(name, systemImage: "paperclip") }
            memoryLine("Memories used", message.citedMemories)
            memoryLine("Memories saved", message.savedMemories)
            memoryLine("Lessons learned", message.learnedLessons)
        }.font(.callout).textSelection(.enabled)
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(message.role == .failure ? Color.orange.opacity(0.1) : Color.secondary.opacity(message.role == .user ? 0.12 : 0.06),
                    in: RoundedRectangle(cornerRadius: 9))
        .contextMenu { Button("Copy") { copyChatText(message.text) } }
    }
    @ViewBuilder private func memoryLine(_ label: String, _ items: [String]) -> some View {
        if !items.isEmpty { Text(label + " · " + items.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary) }
    }
}

private struct RunCard: View {
    let run: ChatRun
    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text(run.end == nil ? run.latest?.summary ?? run.latest?.name ?? "Working…" : "Run complete")
                    .lineLimit(1)
                Spacer()
                TimelineView(.animation(minimumInterval: 1, paused: run.end != nil)) { tick in
                    Text(Duration.seconds(max(0, Int((run.end ?? tick.date).timeIntervalSince(run.time)))).formatted(.time(pattern: .minuteSecond)))
                        .monospacedDigit()
                }
            }.font(.caption)
            if !run.tools.isEmpty {
                DisclosureGroup("Details") {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(run.tools) { tool in
                            VStack(alignment: .leading, spacing: 3) {
                                Text("\(tool.name) · \(tool.status)").fontWeight(.medium)
                                let details = [tool.command, tool.output].compactMap { $0 }.joined(separator: "\n")
                                if !details.isEmpty {
                                    Text(verbatim: details).font(.system(.caption, design: .monospaced))
                                        .padding(5).background(.quinary)
                                }
                                if let paths = tool.paths { Text(paths.joined(separator: "\n")).font(.caption.monospaced()) }
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }.font(.caption)
            }
        }.padding(8)
    }
}

private struct ApprovalCard: View {
    let store: OrionStore
    let approval: Approval
    @State private var working = false
    var body: some View {
        VStack(alignment: .leading) {
            if approval.status == "pending" {
                Label("Command approval", systemImage: "hand.raised")
                Text(verbatim: approval.command).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                let location = [approval.host, approval.cwd].compactMap { $0 }.joined(separator: " · ")
                if !location.isEmpty { Text(location).font(.caption).textSelection(.enabled) }
                HStack {
                    decision("Allow once", "allow-once")
                    decision("Always allow", "allow-always")
                    decision("Deny", "deny")
                }.disabled(working)
            } else { Text("Command \(approval.status) · \(approval.command)").lineLimit(1).help(approval.command) }
        }.padding(8).background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
    private func decision(_ label: String, _ value: String) -> some View {
        Button(label) {
            working = true
            Task { await store.resolve(approval.id, value); working = false }
        }
    }
}
