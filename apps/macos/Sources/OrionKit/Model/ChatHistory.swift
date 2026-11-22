import Foundation

extension HistoryResponse {
    func restored(key: String, active: Bool) -> ConversationState {
        var state = ConversationState()
        state.messages = TranscriptFormatter.messages(from: self)
        var turn = "history-0"
        var start: Date?
        var owners: [String: String] = [:]
        for (index, row) in (messages ?? []).enumerated() {
            guard let ms = row.timestamp else { continue }
            let time = Date(timeIntervalSince1970: ms / 1000)
            if row.role == "user" {
                turn = "history-\(index)"
                start = time
                continue
            }
            guard row.role == "assistant" || row.role == "toolResult" else { continue }
            let id = row.runId ?? row.toolCallId.flatMap { owners[$0] } ?? turn
            var run = state.runs[id] ?? ChatRun(id: id, time: start ?? time)
            if row.role == "toolResult", let call = row.toolCallId {
                run.fold(ChatTool(sessionKey: key, runId: id, toolCallId: call,
                                  name: row.toolName ?? run.tools.first { $0.id == call }?.name ?? "Tool",
                                  status: row.isError == true ? "error" : "done", startedAt: ms, endedAt: ms,
                                  output: String(decoding: row.text.utf8.prefix(4096), as: UTF8.self)))
            } else {
                for block in row.blocks where block.type == "toolCall" {
                    guard let call = block.id else { continue }
                    owners[call] = id
                    let path = block.arguments?.path ?? block.arguments?.file_path
                    run.fold(ChatTool(sessionKey: key, runId: id, toolCallId: call, name: block.name ?? "Tool",
                                      status: "running", startedAt: ms, command: block.arguments?.command,
                                      paths: path.map { [$0] }))
                }
            }
            run.end = time
            state.runs[id] = run
            if row.role == "assistant" { turn = id }
        }
        if hasActiveRun ?? active {
            let id = activeRunId ?? "local:" + turn
            var run = state.runs.removeValue(forKey: turn) ?? ChatRun(id: id, time: start ?? Date())
            run.id = id
            run.end = nil
            state.runs[id] = run
            state.current = id
        }
        return state
    }
}

extension ConversationState {
    /// A history read can finish after a delta, tool completion, or final message.
    /// Match live rows one at a time so identical prompts and final-event memory details survive.
    mutating func mergeHistory(_ history: ConversationState) {
        if runs.isEmpty && messages.isEmpty {
            self = history
            return
        }

        var remaining = messages
        let settled = history.messages.map { row in
            guard let index = remaining.firstIndex(where: {
                $0.role == row.role && $0.text == row.text && abs($0.time.timeIntervalSince(row.time)) < 2
            }) else { return row }
            return remaining.remove(at: index)
        }
        messages = settled + remaining

        for historical in history.runs.values {
            let ids = Set(historical.tools.map(\.id))
            let match = runs[historical.id] ?? runs.values.first { live in
                live.tools.contains { ids.contains($0.id) }
            }
            if var live = match {
                // Replay the live tool events over history so their status and output win.
                var merged = historical
                for tool in live.tools { merged.fold(tool) }
                live.time = min(historical.time, live.time)
                live.tools = merged.tools
                runs[live.id] = live
            } else if historical.end != nil {
                runs[historical.id] = historical
            }
        }
    }
}
