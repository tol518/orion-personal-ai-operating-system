import Foundation

/// One rendered turn in a session transcript.
public struct ChatMessage: Identifiable, Sendable, Equatable {
    public enum Role: Sendable, Equatable {
        case user
        case agent
        case failure
    }

    public let id: UUID
    public let role: Role
    public let text: String
    public let citedMemories: [String]

    public init(id: UUID = UUID(), role: Role, text: String, citedMemories: [String] = []) {
        self.id = id
        self.role = role
        self.text = text
        self.citedMemories = citedMemories
    }
}

/// A `chat` event from the desktop stream, in the shape the BFF forwards from the gateway.
public struct ChatEvent: Decodable, Sendable {
    public let sessionKey: String?
    public let state: String?
    public let deltaText: String?
    public let errorMessage: String?
    public let message: MessageBody?
    public let memoryCitations: [Citation]?

    public struct Citation: Decodable, Sendable {
        public let id: String
        public let title: String?
    }

    public var isDelta: Bool { state == "delta" }
    public var isTerminal: Bool { state == "final" || state == "aborted" || state == "error" }
    public var isFailure: Bool { state == "aborted" || state == "error" }
}

/// A gateway message body, which arrives as a string, `{ text }`, or `{ content: [...] }`.
public struct MessageBody: Decodable, Sendable {
    public let role: String?
    public let text: String

    private enum CodingKeys: String, CodingKey { case role, text, content }

    public init(from decoder: Decoder) throws {
        // A bare string is a valid body, so try that before assuming an object.
        if let single = try? decoder.singleValueContainer(), let raw = try? single.decode(String.self) {
            role = nil
            text = raw
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = try? container.decode(String.self, forKey: .role)
        if let direct = try? container.decode(String.self, forKey: .text) {
            text = direct
        } else if let direct = try? container.decode(String.self, forKey: .content) {
            text = direct
        } else if let blocks = try? container.decode([ContentBlock].self, forKey: .content) {
            text = blocks.map(\.text).joined()
        } else {
            text = ""
        }
    }

    private struct ContentBlock: Decodable {
        let text: String

        init(from decoder: Decoder) throws {
            if let single = try? decoder.singleValueContainer(), let raw = try? single.decode(String.self) {
                text = raw
                return
            }
            let container = try decoder.container(keyedBy: Key.self)
            text = (try? container.decode(String.self, forKey: .text)) ?? ""
        }

        private enum Key: String, CodingKey { case text }
    }
}

public struct HistoryResponse: Decodable, Sendable {
    public let messages: [MessageBody]?
}

/// Strips the envelopes the BFF adds to a turn before it reaches the gateway.
///
/// The BFF wraps a user message in a memory-context envelope and appends hidden HTML comments to
/// assistant replies (citations, proposals, managed-memory upserts). The web client hides both;
/// this reproduces that behavior so the native transcript matches what the browser shows. The
/// markers are a BFF format, so these patterns must change with `buildMemoryAwareMessage`.
public enum TranscriptFormatter {
    static let memoryContextPrefix = "<jarvis-memory-context>"
    private static let userMarker = "\n\nUser message:\n"
    private static let rulesMarker = "\n\nMemory rules:\n"

    private static let hiddenMarkers = try! NSRegularExpression(
        pattern: "<!--\\s*jarvis-(?:memory-(?:citations|proposals)|managed-memory-upserts)\\s*:[\\s\\S]*?-->",
        options: [.caseInsensitive]
    )

    /// Recovers the text the user actually typed from a memory-enriched envelope.
    public static func unwrapUserMessage(_ text: String) -> String {
        guard text.hasPrefix(memoryContextPrefix),
              let userRange = text.range(of: userMarker),
              let rulesRange = text.range(of: rulesMarker, range: userRange.upperBound..<text.endIndex)
        else { return text }
        return String(text[userRange.upperBound..<rulesRange.lowerBound])
    }

    /// Removes hidden agent-side markers from an assistant reply.
    public static func stripHiddenMarkers(_ text: String) -> String {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let stripped = hiddenMarkers.stringByReplacingMatches(
            in: text,
            options: [],
            range: range,
            withTemplate: ""
        )
        // trimEnd only: leading whitespace can be meaningful in a code block.
        return String(stripped.reversed().drop { $0.isWhitespace }.reversed())
    }

    /// Turns a history payload into renderable turns, dropping anything that is not a visible turn.
    public static func messages(from response: HistoryResponse) -> [ChatMessage] {
        (response.messages ?? []).compactMap { body in
            switch body.role {
            case "user":
                let text = unwrapUserMessage(body.text)
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return ChatMessage(role: .user, text: text)
            case "assistant":
                let text = stripHiddenMarkers(body.text)
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return ChatMessage(role: .agent, text: text)
            default:
                // Tool and system turns are not part of the V1 native transcript.
                return nil
            }
        }
    }

    /// The turn to append when a run ends, using the accumulated deltas as a fallback.
    public static func finalMessage(for event: ChatEvent, accumulated: String) -> ChatMessage {
        let body = event.message.map { stripHiddenMarkers($0.text) } ?? ""
        let text = firstNonEmpty(body, accumulated, event.errorMessage) ?? "(no reply)"
        return ChatMessage(
            role: event.isFailure ? .failure : .agent,
            text: text,
            citedMemories: (event.memoryCitations ?? []).map { $0.title ?? $0.id }
        )
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        for value in values {
            guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            return value
        }
        return nil
    }
}
