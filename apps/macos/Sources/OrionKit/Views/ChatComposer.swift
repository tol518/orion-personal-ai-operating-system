import SwiftUI
import UniformTypeIdentifiers
import ImageIO

struct ChatComposer: View {
    let store: OrionStore
    let key: String
    @State private var choosing = false
    private var draft: ChatDraft {
        get { store.drafts[key] ?? ChatDraft() }
        nonmutating set { store.drafts[key] = newValue }
    }
    private var pending: Bool { store.submitting.contains(key) }
    private var canSend: Bool {
        !pending && !store.isLoadingTranscript && (!draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draft.files.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !draft.files.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(draft.files) { file in
                            HStack {
                                AttachmentThumbnail(file: file)
                                Text(file.fileName).font(.caption).lineLimit(1)
                                Button { draft.files.removeAll { $0.id == file.id } } label: {
                                    Image(systemName: "xmark.circle")
                                }.buttonStyle(.plain).disabled(pending).help("Remove \(file.fileName)")
                            }.padding(5).background(.quinary, in: Capsule())
                        }
                    }
                }
            }
            HStack(alignment: .bottom) {
                Button { choosing = true } label: { Image(systemName: "paperclip") }.disabled(pending).help("Attach files")
                ComposerEditor(text: Binding(get: { draft.text }, set: { draft.text = $0 }),
                               editable: !pending, submit: send, stop: { Task { await store.stop() } }, paste: paste)
                    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 6))
                if store.isSending {
                    Button(store.conversation.stopping ? "Stopping…" : "Stop") { Task { await store.stop() } }
                        .disabled(store.conversation.stopping)
                }
                Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .buttonStyle(.plain).disabled(!canSend).keyboardShortcut(.return, modifiers: .command)
                    .help(store.isSending ? "Steer reply" : "Send message")
            }
            if let error = draft.error { Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if let note = store.conversation.note { Text(note).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(10)
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            do { add(urls: try result.get()) } catch { draft.error = error.localizedDescription }
        }
        .dropDestination(for: URL.self) { urls, _ in add(urls: urls); return true }
    }

    private func send() {
        guard canSend else { return }
        Task { await store.sendDraft(for: key) }
    }

    private func add(urls: [URL]) {
        guard !pending else { return }
        for url in urls where url.isFileURL {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey])
                guard values.isRegularFile == true else { draft.error = "Choose a regular file."; continue }
                guard accepts(size: values.fileSize ?? 0) else { return }
                let data = try Data(contentsOf: url)
                guard accepts(size: data.count) else { return }
                draft.files.append(ChatAttachment(fileName: url.lastPathComponent,
                    mimeType: values.contentType?.preferredMIMEType ?? "application/octet-stream", content: data))
                draft.error = nil
            } catch { draft.error = error.localizedDescription }
        }
    }

    private func accepts(size: Int) -> Bool {
        if draft.files.count >= 8 { draft.error = "Attach up to eight files per message."; return false }
        if size > 20 * 1024 * 1024 { draft.error = "Each attachment must be 20 MiB or smaller."; return false }
        return true
    }

    private func paste(_ board: NSPasteboard) -> Bool {
        guard !pending else { return true }
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            add(urls: urls)
            return true
        }
        guard let images = board.readObjects(forClasses: [NSImage.self]) as? [NSImage], !images.isEmpty else { return false }
        let date = Date()
        for image in images {
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]) else {
                draft.error = "Could not read the pasted image."; return true
            }
            guard accepts(size: png.count) else { break }
            draft.files.append(ChatAttachment(fileName: ChatFormatting.screenshotName(date, existing: draft.files.map(\.fileName)),
                                              mimeType: "image/png", content: png))
            draft.error = nil
        }
        return true
    }
}

private struct AttachmentThumbnail: View {
    let file: ChatAttachment
    @State private var image: CGImage?
    var body: some View {
        Group {
            if let image { Image(decorative: image, scale: 1).resizable().scaledToFit() }
            else { Image(systemName: "doc") }
        }.frame(width: 28, height: 28).task(id: file.id) {
            guard file.mimeType.hasPrefix("image/"), let source = CGImageSourceCreateWithData(file.content as CFData, nil) else { return }
            image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 64, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary)
        }
    }
}

/// AppKit's multiline text editor provides pasteboard access and preserves input-method composition.
private struct ComposerEditor: NSViewRepresentable {
    @Binding var text: String
    let editable: Bool
    let submit: () -> Void
    let stop: () -> Void
    let paste: (NSPasteboard) -> Bool

    final class Editor: NSTextView {
        var owner: ComposerEditor?
        override func paste(_ sender: Any?) {
            if owner?.paste(.general) != true { super.paste(sender) }
        }
        override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
            if sender.draggingPasteboard.availableType(from: [.fileURL]) != nil,
               owner?.paste(sender.draggingPasteboard) == true { return true }
            return super.performDragOperation(sender)
        }
        override func keyDown(with event: NSEvent) {
            if !hasMarkedText() {
                if event.keyCode == 53 { owner?.stop(); return }
                if [36, 76].contains(event.keyCode) {
                    if event.modifierFlags.contains(.shift) { insertNewline(nil) } else { owner?.submit() }
                    return
                }
            }
            super.keyDown(with: event)
        }
        override func didChangeText() { super.didChangeText(); owner?.text = string }
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        let editor = Editor()
        editor.isRichText = false
        editor.allowsUndo = true
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainerInset = NSSize(width: 4, height: 6)
        editor.font = .systemFont(ofSize: NSFont.systemFontSize)
        editor.drawsBackground = false
        editor.setAccessibilityLabel("Message")
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = editor
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let editor = scroll.documentView as? Editor else { return }
        editor.owner = self
        editor.isEditable = editable
        if editor.string != text { editor.string = text }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, let editor = nsView.documentView as? Editor,
              let layout = editor.layoutManager, let container = editor.textContainer else { return nil }
        container.containerSize.width = max(1, width - 14)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: min(140, max(34, ceil(layout.usedRect(for: container).height) + 16)))
    }
}
