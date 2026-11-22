import SwiftUI
import WebKit

func copyChatText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

struct MarkdownReply: View {
    let text: String
    private func inline(_ source: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return Text((try? AttributedString(markdown: source, options: options)) ?? AttributedString(source))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let value): inline(value)
                case .heading(let level, let value):
                    inline(value).font(level == 1 ? .title2 : level == 2 ? .title3 : .headline).bold()
                case .listItem(let marker, let value):
                    HStack(alignment: .firstTextBaseline) { Text(marker); inline(value) }
                case .quote(let value):
                    HStack { Rectangle().fill(.secondary).frame(width: 2); inline(value).italic() }.fixedSize(horizontal: false, vertical: true)
                case .table(let rows):
                    ScrollView(.horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 5) {
                            ForEach(rows.indices, id: \.self) { row in
                                GridRow {
                                    ForEach(rows[row].indices, id: \.self) { col in
                                        inline(rows[row][col]).fontWeight(row == 0 ? .semibold : .regular)
                                    }
                                }
                                if row == 0 { Divider() }
                            }
                        }
                    }
                case .code(let language, let source):
                    CodeBlock(language: language, source: source).id(source)
                }
            }
        }
        .textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in
            ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
        })
    }
}

private struct CodeBlock: View {
    let language: String
    let source: String
    @State private var failed = false
    @State private var height: CGFloat = 100

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text(language.isEmpty ? "Code" : language).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Copy") { copyChatText(source) }.controlSize(.small)
            }
            if language.lowercased() == "mermaid" && !failed {
                DiagramView(source: source) { result in
                    if let result { height = min(700, max(36, result)) } else { failed = true }
                }.frame(height: height)
            } else {
                ScrollView(.horizontal) {
                    Text(verbatim: source).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                }
            }
        }
        .padding(8).background(.quinary, in: RoundedRectangle(cornerRadius: 6))
    }
}

private struct DiagramView: NSViewRepresentable {
    let source: String
    let completion: (CGFloat?) -> Void
    static let world = WKContentWorld.world(name: "OrionDiagram")
    static let script: String? = {
        let url = Bundle.module.url(forResource: "mermaid.min", withExtension: "js")
        return url.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    }()

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        if let script = Self.script {
            config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd,
                forMainFrameOnly: true, in: Self.world))
        }
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.loadHTMLString("""
        <!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
        <style>body{margin:4px}img{max-width:100%;height:auto}</style><main></main>
        """, baseURL: nil)
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: DiagramView
        private var initial = true
        init(_ parent: DiagramView) { self.parent = parent }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let allowed = initial && action.targetFrame?.isMainFrame == true && action.request.url?.absoluteString == "about:blank"
            initial = false
            decisionHandler(allowed ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            let render = """
            mermaid.initialize({startOnLoad:false,securityLevel:"strict",htmlLabels:false,
                flowchart:{htmlLabels:false},secure:["securityLevel","startOnLoad","htmlLabels","flowchart","secure"]});
            const {svg} = await mermaid.render("orionDiagram", source);
            const image = new Image();
            const url = URL.createObjectURL(new Blob([svg], {type:"image/svg+xml"}));
            try {
                image.src = url;
                await image.decode();
                document.querySelector("main").replaceChildren(image);
            } finally { URL.revokeObjectURL(url); }
            return document.querySelector("main").getBoundingClientRect().height + 8;
            """
            Task { @MainActor in
                let value = try? await webView.callAsyncJavaScript(render, arguments: ["source": parent.source], in: nil, contentWorld: DiagramView.world)
                parent.completion((value as? NSNumber).map { CGFloat($0.doubleValue) })
            }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.completion(nil)
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { parent.completion(nil) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.completion(nil) }
    }
}
