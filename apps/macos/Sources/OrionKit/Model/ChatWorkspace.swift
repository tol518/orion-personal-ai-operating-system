import Foundation

enum SessionChange {
    case rename(String), archive(Bool), thinking(String), model(String, agent: String)
    case target(String, agent: String), compact, reset(String), delete(String)
}

struct ChatTarget: Decodable {
    struct Device: Decodable { let available: Bool }
    let target: String
    let devices: [String: Device]
}

struct ChatModels: Decodable {
    let current: String?
    let models: [DesktopAgent.ModelOption]
}

struct ChatAttachment: Identifiable, Encodable {
    let id = UUID()
    let fileName: String
    let mimeType: String
    let content: Data
    enum CodingKeys: String, CodingKey { case fileName, mimeType, content }
}

struct Approval: Decodable, Equatable, Identifiable {
    let id: String
    var sessionKey: String?
    var command: String
    var host: String?
    var cwd: String?
    let requestedAt: Double
    let expiresAt: Double?
    var status: String
    var date: Date { Date(timeIntervalSince1970: requestedAt / 1000) }
}

struct ApprovalInbox {
    var items: [Approval] = []
    private(set) var revision = 0

    mutating func receive(_ item: Approval) {
        revision += 1
        if let i = items.firstIndex(where: { $0.id == item.id }) {
            var next = item
            next.sessionKey = item.sessionKey ?? items[i].sessionKey
            if next.command.isEmpty { next.command = items[i].command }
            items[i] = next
        } else {
            items.append(item)
        }
    }

    mutating func resolve(_ id: String, status: String) {
        guard let i = items.firstIndex(where: { $0.id == id && $0.status == "pending" }) else { return }
        revision += 1
        items[i].status = status
    }

    mutating func replay(_ snapshot: [Approval], since version: Int) {
        guard revision == version else { return }
        items.removeAll { $0.status == "pending" }
        for item in snapshot { receive(item) }
    }
}

struct ChatTool: Decodable, Equatable, Identifiable {
    let sessionKey: String
    var runId: String?
    let toolCallId: String
    var id: String { toolCallId }
    let name: String
    var status: String
    var startedAt: Double
    var endedAt: Double?
    var summary: String?
    var command: String?
    var output: String?
    var paths: [String]?
}

struct ChatRun: Identifiable, Equatable {
    var id: String
    var time: Date
    var end: Date?
    var tools: [ChatTool] = []
    var latest: ChatTool?

    mutating func fold(_ event: ChatTool) {
        var updated = event
        if let index = tools.firstIndex(where: { $0.id == event.id }) {
            let old = tools[index]
            updated.startedAt = old.startedAt
            updated.command = event.command ?? old.command
            updated.output = event.output ?? old.output
            updated.paths = Array(Set((old.paths ?? []) + (event.paths ?? []))).sorted()
            updated.summary = event.summary ?? old.summary
            tools[index] = updated
        } else {
            tools.append(updated)
        }
        latest = updated
    }
}

struct ConversationState {
    var messages: [ChatMessage] = []
    var runs: [String: ChatRun] = [:]
    var current: String?
    var partial: String?
    var steering: String?
    var stopping = false
    var queued: [String] = []
    var note: String?
    var followUpTime: Date?
    var busy: Bool { current != nil }

    mutating func start(_ id: String, at time: Date) {
        guard runs[id]?.end == nil else { return }
        if let old = current, old != id, old.hasPrefix("local:"), var run = runs.removeValue(forKey: old) {
            run.id = id
            runs[id] = run
        }
        current = id
        if runs[id] == nil { runs[id] = ChatRun(id: id, time: max(time, followUpTime ?? time)) }
    }

    mutating func begin(_ message: ChatMessage) {
        note = nil
        messages.append(message)
        steering = current
        followUpTime = message.time
        if current == nil { start("local:" + message.id.uuidString, at: message.time) }
    }

    mutating func redirect(_ id: String, at time: Date) {
        guard runs[id]?.end == nil else { return }
        runs[id]?.end = time
        if current == id {
            if let partial, !partial.isEmpty {
                messages.append(ChatMessage(role: .agent, text: TranscriptFormatter.stripHiddenMarkers(partial),
                                            time: followUpTime ?? time))
            }
            current = nil
            partial = nil
            stopping = false
        }
    }

    mutating func acknowledge(_ ack: DesktopChatAck, at time: Date) {
        defer { steering = nil }
        let previous = steering
        if ack.delivered == "turn", previous != nil { note = "Queued as the next turn" }
        guard let id = ack.ack?.runId else { return }
        if ack.delivered == "steer", let previous, previous != id { redirect(previous, at: time) }
        guard runs[id]?.end == nil else { return }
        if ack.delivered == "turn", let current, previous != nil, current != id {
            queued.append(id)
        } else {
            start(id, at: time)
        }
    }

    mutating func abortAcknowledged(_ aborted: Bool, for id: String, at time: Date) {
        guard current == id, !aborted else { return }
        finish(id, at: time)
    }

    mutating func finish(_ id: String, at time: Date) {
        runs[id]?.end = time
        queued.removeAll { $0 == id }
        guard current == id else { return }
        current = nil
        partial = nil
        stopping = false
        if !queued.isEmpty { let next = queued.removeFirst(); start(next, at: time) }
    }

    mutating func receive(_ event: ChatEvent, at time: Date) -> Bool {
        let id = event.runId ?? current ?? "local:" + UUID().uuidString
        guard runs[id]?.end == nil else { return false }
        if event.state == "aborted", let provisional = steering, provisional == current,
           provisional.hasPrefix("local:"), event.runId != nil {
            start(id, at: time)
            steering = id
        }
        if event.state == "aborted", id == steering {
            redirect(id, at: time)
            return false
        }
        guard event.isDelta || event.isTerminal else { return false }
        if let steering, steering == current, id != steering { redirect(steering, at: time) }
        if current == nil || current == id || current?.hasPrefix("local:") == true {
            start(id, at: time)
        }
        if event.isDelta {
            guard current == id else { return false }
            if let body = event.message?.text, !body.isEmpty { partial = body }
            else { partial = (event.replace == true ? "" : partial ?? "") + (event.deltaText ?? "") }
            return false
        }
        if runs[id] == nil { runs[id] = ChatRun(id: id, time: time) }
        var message = TranscriptFormatter.finalMessage(for: event, accumulated: current == id ? partial ?? "" : "")
        if event.state == "aborted" && message.text == "(no reply)" {
            message = ChatMessage(role: .agent, text: "Reply stopped.")
        }
        message.time = time
        messages.append(message)
        finish(id, at: time)
        return true
    }

    mutating func receive(_ tool: ChatTool) {
        let id = tool.runId ?? current ?? "local:" + UUID().uuidString
        let time = Date(timeIntervalSince1970: tool.startedAt / 1000)
        if let steering, steering == current, steering != id { redirect(steering, at: time) }
        if runs[id] == nil || current == nil { start(id, at: time) }
        runs[id]?.fold(tool)
    }
}

enum ChatItem: Identifiable {
    case message(ChatMessage), run(ChatRun), approval(Approval)
    var id: String {
        switch self {
        case .message(let m): return m.id.uuidString
        case .run(let r): return "run-" + r.id
        case .approval(let a): return "approval-" + a.id
        }
    }
    var time: Date {
        switch self {
        case .message(let m): return m.time
        case .run(let r): return r.time
        case .approval(let a): return a.date
        }
    }

    static func timeline(_ state: ConversationState, approvals: [Approval]) -> [Self] {
        let runs = state.runs.values.filter { $0.end == nil || !$0.tools.isEmpty }.sorted { $0.id < $1.id }
        return (state.messages.map(Self.message) + runs.map(Self.run) + approvals.map(Self.approval))
            .sorted { $0.time < $1.time }
    }
}

enum ChatFormatting {
    static func followsBottom(distance: CGFloat) -> Bool { distance <= 80 }

    static func formatted(_ date: Date, _ format: String, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = format
        return formatter.string(from: date)
    }

    static func timeLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let clock = formatted(date, "HH:mm", calendar: calendar)
        if calendar.isDate(date, inSameDayAs: now) { return clock }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday " + clock }
        return formatted(date, "d MMM HH:mm", calendar: calendar)
    }

    static func screenshotName(_ date: Date, existing: [String], calendar: Calendar = .current) -> String {
        let base = "screenshot-" + formatted(date, "yyyyMMdd-HHmmss", calendar: calendar)
        var name = base + ".png"
        var number = 2
        while existing.contains(name) { name = "\(base)-\(number).png"; number += 1 }
        return name
    }
}

struct ChatDraft {
    var text = ""
    var files: [ChatAttachment] = []
    var error: String?
}
