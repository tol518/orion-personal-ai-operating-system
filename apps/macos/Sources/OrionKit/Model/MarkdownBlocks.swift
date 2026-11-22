import Foundation

enum MarkdownBlock: Equatable {
    case paragraph(String), heading(Int, String), quote(String), listItem(String, String)
    case table([[String]]), code(language: String, source: String)

    static func parse(_ source: String) -> [Self] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var result: [Self] = []
        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { result.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph.removeAll() }
        }
        func cells(_ line: String) -> [String] {
            line.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "|"))
                .components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        var index = 0
        while index < lines.count {
            let raw = lines[index]
            let line = raw.trimmingCharacters(in: .whitespaces)
            index += 1
            let fence = line.prefix { $0 == line.first }
            if fence.count >= 3 && (line.first == "\u{60}" || line.first == "~") {
                flush()
                var body: [String] = []
                while index < lines.count {
                    let next = lines[index].trimmingCharacters(in: .whitespaces)
                    if next.count >= fence.count && next.allSatisfy({ $0 == fence.first }) { index += 1; break }
                    body.append(lines[index]); index += 1
                }
                result.append(.code(language: String(line.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces),
                                    source: body.joined(separator: "\n")))
            } else if line.isEmpty { flush() }
            else if let match = line.firstMatch(of: #/^(#{1,6})\s+(.+)$/#) {
                flush(); result.append(.heading(match.1.count, String(match.2)))
            } else if line.hasPrefix(">") {
                flush()
                var quotes = [String(line.dropFirst()).trimmingCharacters(in: .whitespaces)]
                while index < lines.count, lines[index].hasPrefix(">") {
                    quotes.append(String(lines[index].dropFirst()).trimmingCharacters(in: .whitespaces)); index += 1
                }
                result.append(.quote(quotes.joined(separator: "\n")))
            } else if let match = line.firstMatch(of: #/^([-*+]|\d+[.)])\s+(.+)$/#) {
                flush()
                var marker = match.1.count == 1 ? "•" : String(match.1)
                var value = String(match.2)
                if let task = value.firstMatch(of: #/^\[([ xX])\]\s+(.*)$/#) {
                    marker = task.1 == " " ? "☐" : "☑"
                    value = String(task.2)
                }
                result.append(.listItem(marker, value))
            } else if line.contains("|"), index < lines.count,
                      cells(lines[index]).allSatisfy({ $0.wholeMatch(of: #/:?-{3,}:?/#) != nil }) {
                flush()
                var rows = [cells(line)]
                index += 1
                while index < lines.count, lines[index].contains("|") {
                    rows.append(cells(lines[index])); index += 1
                }
                result.append(.table(rows))
            } else { paragraph.append(raw) }
        }
        flush()
        return result
    }
}
