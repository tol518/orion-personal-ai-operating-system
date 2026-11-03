import Foundation
import Observation

@MainActor
@Observable
public final class FileBrowserStore {
    public private(set) var devices: [FileDevice] = []
    public private(set) var deviceId = "local"
    public private(set) var roots: [FileRoot] = []
    public private(set) var rootId = ""
    public private(set) var path = ""
    public private(set) var entries: [DeviceFile] = []
    public private(set) var offset = 0
    public private(set) var nextOffset: Int?
    public private(set) var scanTruncated = false
    public private(set) var loading = false
    public private(set) var error: String?
    public private(set) var transferring = false
    public private(set) var transferMessage: String?
    public private(set) var transferFileName: String?
    public var previewURL: URL?
    private var previewFiles: [URL] = []
    private var generation = 0
    private var transferGeneration = 0
    private var transferTask: Task<Void, Never>?
    private let client: OrionClient

    public init(client: OrionClient) { self.client = client }
    public var device: FileDevice? { devices.first { $0.id == deviceId } }
    public var root: FileRoot? { roots.first { $0.id == rootId } }
    public func entryPath(_ file: DeviceFile) -> String { path.isEmpty ? file.name : "\(path)/\(file.name)" }

    public func refreshDevices() async {
        do {
            let result = try await client.fileDevices()
            try Task.checkCancellation()
            devices = result
            if rootId.isEmpty { await selectDevice(deviceId) }
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }

    public func selectDevice(_ id: String) async {
        generation += 1
        let ticket = generation
        cancelTransfer()
        deviceId = id
        roots = []; rootId = ""; path = ""; entries = []; nextOffset = nil
        loading = true; error = nil
        defer { if ticket == generation { loading = false } }
        guard device?.available == true else {
            error = device?.connected == true ? "Connect an OpenClaw Node host with Node.js and execution permission to read files." : "This computer is offline. Reconnect it to browse its files."
            return
        }
        do {
            let result = try await client.fileRoots(deviceId: id)
            try Task.checkCancellation()
            guard ticket == generation else { return }
            roots = result
            if let first = result.first { await open(root: first.id, path: "") }
        } catch is CancellationError {} catch {
            if ticket == generation { self.error = error.localizedDescription }
        }
    }

    public func open(root: String, path: String, offset: Int = 0) async {
        generation += 1
        let ticket = generation
        cancelTransfer()
        rootId = root; self.path = path; self.offset = offset
        entries = []; nextOffset = nil; error = nil; loading = true
        defer { if ticket == generation { loading = false } }
        do {
            let result = try await client.fileList(deviceId: deviceId, root: root, path: path, offset: offset)
            try Task.checkCancellation()
            guard ticket == generation else { return }
            entries = result.entries
            nextOffset = result.nextOffset
            scanTruncated = result.scanTruncated
        } catch is CancellationError {} catch {
            if ticket == generation { self.error = error.localizedDescription }
        }
    }

    public func parent() async {
        await open(root: rootId, path: path.split(separator: "/").dropLast().joined(separator: "/"))
    }

    public func preview(_ file: DeviceFile) {
        transfer(file, preview: true, destination: nil)
    }

    public func download(_ file: DeviceFile, to destination: URL) {
        transfer(file, preview: false, destination: destination)
    }

    private func transfer(_ file: DeviceFile, preview: Bool, destination: URL?) {
        cancelTransfer()
        let ticket = transferGeneration
        let device = deviceId, root = rootId, target = entryPath(file)
        transferring = true; error = nil
        transferFileName = file.name
        transferMessage = preview ? "Preparing preview..." : "Downloading \(file.name)..."
        transferTask = Task { [weak self] in
            guard let self else { return }
            var downloaded: URL?
            defer {
                if let downloaded { try? FileManager.default.removeItem(at: downloaded.deletingLastPathComponent()) }
                if ticket == self.transferGeneration { self.transferring = false }
            }
            do {
                let info = try await self.client.fileInfo(deviceId: device, root: root, path: target, revision: file.revision)
                try Task.checkCancellation()
                if preview && info.previewKind == "unsupported" {
                    throw OrionClientError.server(status: 415, message: "No preview for this file type. Download it to open it locally.")
                }
                downloaded = try await self.client.downloadFile(deviceId: device, root: root, path: target, info: info, preview: preview)
                try Task.checkCancellation()
                guard ticket == self.transferGeneration, let temporary = downloaded else { return }
                if preview {
                    self.previewFiles.append(temporary)
                    self.previewURL = temporary
                    downloaded = nil
                    self.transferMessage = info.previewKind == "text" && info.sizeBytes > 262144 ? "Preview shows the first 256 KB. Download for the complete file." : nil
                } else if let destination {
                    try Self.saveDownloadedFile(temporary, to: destination)
                    self.transferMessage = "Saved \(file.name)."
                }
            } catch is CancellationError {} catch {
                if ticket == self.transferGeneration && !Task.isCancelled { self.error = error.localizedDescription; self.transferMessage = nil }
            }
        }
    }

    static func saveDownloadedFile(_ temporary: URL, to destination: URL) throws {
        let manager = FileManager.default
        // Atomic replacement requires staging on the destination's volume, not the system temp volume.
        let staging = try manager.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: destination, create: true)
        defer { try? manager.removeItem(at: staging) }
        let staged = staging.appendingPathComponent(temporary.lastPathComponent)
        try manager.copyItem(at: temporary, to: staged)
        if manager.fileExists(atPath: destination.path) {
            _ = try manager.replaceItemAt(destination, withItemAt: staged)
        } else {
            try manager.moveItem(at: staged, to: destination)
        }
    }

    public func cancelTransfer() {
        // Invalidate completion before cancellation, so an old response cannot replace a new selection.
        transferGeneration += 1
        transferTask?.cancel()
        transferTask = nil
        transferring = false
        transferFileName = nil
        transferMessage = nil
        previewURL = nil
        clearPreviews()
    }

    public func clearPreviews() {
        for file in previewFiles { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        previewFiles = []
    }

    public func stop() {
        generation += 1
        cancelTransfer()
        entries = []
        roots = []
        rootId = ""
        path = ""
    }
}
