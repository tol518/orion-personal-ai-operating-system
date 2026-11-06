import AppKit
import QuickLook
import SwiftUI

struct FilesView: View {
    let store: OrionStore
    @State private var browser: FileBrowserStore?

    var body: some View {
        Group {
            if let browser { DeviceFilesWorkspace(browser: browser) }
            else { ProgressView("Loading files...") }
        }
        .navigationTitle("Files")
        .task {
            if browser == nil { browser = store.makeFileBrowser() }
            await browser?.refreshDevices()
        }
        .onDisappear { browser?.stop() }
    }
}

private struct DeviceFilesWorkspace: View {
    @Bindable var browser: FileBrowserStore
    @State private var selection: String?
    @State private var search = ""
    @State private var dropTargeted = false
    @State private var removing: DeviceFile?

    private var selectedFile: DeviceFile? { browser.entries.first { $0.name == selection } }
    private var visibleFiles: [DeviceFile] {
        search.isEmpty ? browser.entries : browser.entries.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        VStack(spacing: 0) {
            deviceBar
            Divider()
            folderBar
            if let error = browser.error {
                HStack {
                    Label(error, systemImage: "exclamationmark.triangle").font(.callout)
                    Spacer()
                    Button("Retry") { Task { await browser.selectDevice(browser.deviceId) } }
                }
                .foregroundStyle(.orange).padding()
            }
            HSplitView {
                fileList.frame(minWidth: 260)
                inspector.frame(minWidth: 210, idealWidth: 240, maxWidth: 320)
            }
            Divider()
            statusBar
        }
        .searchable(text: $search, prompt: "Filter this page")
        .quickLookPreview($browser.previewURL)
        .onChange(of: browser.previewURL) { _, url in if url == nil { browser.clearPreviews() } }
        .onChange(of: browser.path) { _, _ in selection = nil; search = "" }
        .onChange(of: browser.rootId) { _, _ in selection = nil; search = "" }
        .onChange(of: browser.deviceId) { _, _ in selection = nil; search = "" }
        .onChange(of: selection) { _, name in
            if browser.transferFileName != name { browser.cancelTransfer() }
        }
        .toolbar {
            Button("Send Files to Orion...", systemImage: "square.and.arrow.up") { chooseFilesToSend() }
                .help("Choose files or folders on this Mac to copy into the Orion server's Dropped files")
                .disabled(browser.dropping)
            Button("Refresh devices", systemImage: "arrow.clockwise") { Task { await browser.refreshDevices() } }
        }
        // Only what is dropped here leaves this Mac; nothing else on it is shared.
        .dropDestination(for: URL.self) { urls, _ in
            guard !browser.dropping else { return false }
            Task { await browser.drop(urls) }
            return true
        } isTargeted: { dropTargeted = $0 }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 3, dash: [8]))
                    .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .overlay {
                        VStack(spacing: 6) {
                            Label("Drop to send to Orion's Dropped files", systemImage: "tray.and.arrow.down")
                                .font(.title3.weight(.semibold))
                            Text("Files and folders. Hidden files and links stay on this Mac.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    .padding(8)
                    .allowsHitTesting(false)
            }
        }
        .confirmationDialog(
            "Remove \(removing?.name ?? "this file") from Orion?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { file in
            Button("Remove from Orion", role: .destructive) { Task { await browser.removeDropped(file) } }
        } message: { file in
            Text(file.isDirectory
                ? "The folder and everything in it are deleted from the Orion server. Originals on this Mac stay where they are."
                : "The copy on the Orion server is deleted. The original on this Mac stays where it is.")
        }
    }

    private var deviceBar: some View {
        HStack {
            Picker("Computer", selection: Binding(get: { browser.deviceId }, set: { id in Task { await browser.selectDevice(id) } })) {
                ForEach(browser.devices) { device in
                    Text("\(device.name)\(device.local ? " (Orion server)" : "")\(device.available ? "" : " - offline or unavailable")").tag(device.id)
                }
            }
            .frame(maxWidth: 400)
            Spacer()
            if browser.device?.available == true {
                Label("Connected", systemImage: "circle.fill").font(.caption).foregroundStyle(.green)
            }
        }
        .padding()
    }

    private var folderBar: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(browser.roots) { root in
                        Button { Task { await browser.open(root: root.id, path: "") } } label: {
                            Label(root.label, systemImage: browser.rootId == root.id ? "folder.fill" : "folder")
                        }
                        .buttonStyle(.bordered)
                        .tint(browser.rootId == root.id ? .accentColor : nil)
                    }
                }
            }
            HStack {
                Button("Up", systemImage: "arrow.up") { Task { await browser.parent() } }.disabled(browser.path.isEmpty)
                Text(browser.path.isEmpty ? (browser.root?.label ?? "Shared folders") : "\(browser.root?.label ?? "") / \(browser.path)")
                    .font(.callout).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Refresh folder", systemImage: "arrow.clockwise") {
                    Task { await browser.open(root: browser.rootId, path: browser.path, offset: browser.offset) }
                }.labelStyle(.iconOnly).disabled(browser.rootId.isEmpty)
            }
        }
        .padding(.horizontal).padding(.bottom, 12)
    }

    @ViewBuilder private var fileList: some View {
        if browser.loading {
            ProgressView("Reading device files...").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if visibleFiles.isEmpty {
            ContentUnavailableView(search.isEmpty ? "No visible files" : "No matching files", systemImage: "folder", description: Text(browser.roots.isEmpty ? "Shared folders will appear when the computer is connected and access is configured." : "Open another folder or refresh this one."))
        } else {
            List(visibleFiles, selection: $selection) { file in
                HStack(spacing: 10) {
                    Image(systemName: file.isDirectory ? "folder.fill" : "doc")
                        .foregroundStyle(file.isDirectory ? Color.accentColor : .secondary)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(file.name).lineLimit(1).truncationMode(.middle)
                        Text(file.sizeLabel).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(file.modifiedAt, style: .date).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4).tag(file.name)
                .contextMenu {
                    Button(file.isDirectory ? "Open folder" : "Preview") { open(file) }
                    if !file.isDirectory { Button("Download...") { save(file) } }
                    if browser.showingDrops {
                        Button("Remove from Orion...", role: .destructive) { removing = file }
                    }
                }
                .onTapGesture(count: 2) { open(file) }
            }
        }
    }

    private var inspector: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let file = selectedFile {
                Image(systemName: file.isDirectory ? "folder.fill" : "doc.text")
                    .font(.system(size: 36)).foregroundStyle(.secondary).padding(.top)
                Text(file.name).font(.headline).textSelection(.enabled)
                LabeledContent("Size", value: file.sizeLabel).font(.caption)
                LabeledContent("Modified") { Text(file.modifiedAt, style: .date) }.font(.caption)
                if file.isDirectory {
                    Button("Open folder") { open(file) }
                    if browser.showingDrops {
                        Button("Remove from Orion...", systemImage: "trash", role: .destructive) { removing = file }
                    }
                } else {
                    Button("Preview", systemImage: "eye") { browser.preview(file) }
                        .keyboardShortcut(.space, modifiers: []).disabled(browser.transferring)
                    Button("Download...", systemImage: "arrow.down.circle") { save(file) }
                        .disabled(browser.transferring)
                    if browser.showingDrops {
                        Button("Remove from Orion...", systemImage: "trash", role: .destructive) { removing = file }
                    }
                }
            } else {
                Label("Select a file", systemImage: "doc.viewfinder").foregroundStyle(.secondary).padding(.top)
                Text("Double-click a folder to browse, or a file to preview it.").font(.callout).foregroundStyle(.secondary)
            }
            if browser.transferring {
                ProgressView().controlSize(.small)
                Button("Cancel transfer") { browser.cancelTransfer() }
            }
            if let message = browser.transferMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
            Spacer()
            if browser.showingDrops {
                Label("Copies you sent to Orion", systemImage: "tray.and.arrow.down").font(.caption).foregroundStyle(.secondary)
            } else {
                Label("Read-only shared folders", systemImage: "lock.shield").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding()
    }

    private var statusBar: some View {
        HStack {
            Text("\(browser.entries.count) items on page \(browser.offset / 100 + 1)").font(.caption).foregroundStyle(.secondary)
            if browser.scanTruncated { Text("First 5,000 entries").font(.caption).foregroundStyle(.secondary) }
            Spacer()
            if browser.dropping { ProgressView().controlSize(.small) }
            if let message = browser.dropMessage { Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            Button("Previous") { Task { await browser.open(root: browser.rootId, path: browser.path, offset: max(0, browser.offset - 100)) } }.disabled(browser.offset == 0 || browser.loading)
            Button("Next") { Task { await browser.open(root: browser.rootId, path: browser.path, offset: browser.nextOffset ?? 0) } }.disabled(browser.nextOffset == nil || browser.loading)
        }
        .padding(10)
    }

    private func open(_ file: DeviceFile) {
        if file.isDirectory { Task { await browser.open(root: browser.rootId, path: browser.entryPath(file)) } }
        else { selection = file.name; browser.preview(file) }
    }

    private func chooseFilesToSend() {
        // An open panel grants access to exactly what was chosen, and nothing else on this Mac.
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Send to Orion"
        panel.message = "Choose files or folders to copy into the Orion server's Dropped files. Hidden files and links stay on this Mac."
        panel.begin { response in
            guard response == .OK else { return }
            let urls = panel.urls
            Task { await browser.drop(urls) }
        }
    }

    private func save(_ file: DeviceFile) {
        // A save panel grants one explicit destination; bytes stream to a temporary file first.
        let panel = NSSavePanel()
        panel.nameFieldStringValue = file.name
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            browser.download(file, to: url)
        }
    }
}
