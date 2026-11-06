import XCTest
@testable import OrionKit

final class DeviceFilesTests: XCTestCase {
    func testDeviceAndFolderResponsesDoNotNeedHostPaths() throws {
        let result = try JSONDecoder().decode(FileDevicesResponse.self, from: Data(#"{"devices":[{"id":"local","name":"Orion server","platform":"darwin","connected":true,"available":true,"local":true}],"gatewayUnavailable":false}"#.utf8))
        XCTAssertEqual(result.devices.first?.id, "local")
        let roots = try JSONDecoder().decode(FileRootsResponse.self, from: Data(#"{"roots":[{"id":"docs","label":"Documents"}]}"#.utf8))
        XCTAssertEqual(roots.roots.first?.label, "Documents")
    }

    func testPathsPreserveSpecialCharactersInsideQueryValues() throws {
        let path = DeviceFileRequest.path(deviceId: "node-1", action: "content", root: "docs", path: "Plans/a + b & c #1.txt", revision: "12:34:56", preview: true)
        let components = try XCTUnwrap(URLComponents(string: path))
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(components.path, "files/node-1/content")
        XCTAssertEqual(items["path"], "Plans/a + b & c #1.txt")
        XCTAssertTrue(path.contains("%2B"), "a plus must survive the server's form-query decoder")
        XCTAssertEqual(items["revision"], "12:34:56")
        XCTAssertEqual(items["preview"], "1")
        XCTAssertNil(components.fragment)
        XCTAssertNil(items["download"])
    }

    func testFolderPageAndDownloadUseDifferentParameters() throws {
        let listing = DeviceFileRequest.path(deviceId: "pc", action: "list", root: "docs", offset: 100)
        XCTAssertTrue(listing.contains("offset=100"))
        XCTAssertFalse(listing.contains("download="))
        let download = DeviceFileRequest.path(deviceId: "pc", action: "content", root: "docs", path: "file.txt")
        XCTAssertTrue(download.contains("download=1"))
    }

    func testOnlyTheDroppedFilesRootIsWritable() throws {
        let roots = try JSONDecoder().decode(FileRootsResponse.self, from: Data(#"{"roots":[{"id":"orion-drops","label":"Dropped files","writable":true},{"id":"home","label":"Home"}]}"#.utf8))
        XCTAssertEqual(roots.roots.map(\.writable), [true, false])
        let dropped = try JSONDecoder().decode(DroppedFile.self, from: Data(#"{"ok":true,"rootId":"orion-drops","path":"Photos/notes (2).txt","name":"notes (2).txt","sizeBytes":12}"#.utf8))
        XCTAssertEqual(dropped.name, "notes (2).txt")
    }

    func testDropPathCarriesOnlyTheRelativePathAndAlwaysTargetsTheServer() throws {
        let path = DeviceFileRequest.drop(path: "Photos/a + b & c #1.pdf")
        let components = try XCTUnwrap(URLComponents(string: path))
        XCTAssertEqual(components.path, "files/local/drops")
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "path", value: "Photos/a + b & c #1.pdf")])
        XCTAssertTrue(path.contains("%2B"), "a plus must survive the server's form-query decoder")
        XCTAssertNil(components.fragment)
        XCTAssertEqual(URLComponents(string: DeviceFileRequest.drop(path: "Photos", folder: true))?.path, "files/local/drops/folders")
    }

    func testAFolderPlanKeepsStructureAndLeavesHiddenFilesAndLinksBehind() throws {
        let fileManager = FileManager.default
        let base = fileManager.temporaryDirectory.appendingPathComponent("orion-plan-\(UUID().uuidString)")
        let photos = base.appendingPathComponent("Photos")
        try fileManager.createDirectory(at: photos.appendingPathComponent("Trips/Empty"), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: photos.appendingPathComponent(".git"), withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: base) }
        try Data("sand".utf8).write(to: photos.appendingPathComponent("Trips/beach.jpg"))
        try Data().write(to: photos.appendingPathComponent(".DS_Store"))
        try Data("secret".utf8).write(to: photos.appendingPathComponent(".git/config"))
        try fileManager.createSymbolicLink(at: photos.appendingPathComponent("home"), withDestinationURL: fileManager.homeDirectoryForCurrentUser)
        let other = base.appendingPathComponent("Other/Photos")
        try fileManager.createDirectory(at: other, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: other.appendingPathComponent("x.txt"))
        let note = base.appendingPathComponent("note.txt")
        try Data("n".utf8).write(to: note)

        let plan = try DropPlan.make([photos, note, other, base.appendingPathComponent("missing")])
        XCTAssertEqual(plan.folders.sorted(), ["Photos", "Photos (2)", "Photos/Trips", "Photos/Trips/Empty"])
        XCTAssertEqual(plan.files.map(\.path).sorted(), ["Photos (2)/x.txt", "Photos/Trips/beach.jpg", "note.txt"])
        XCTAssertEqual(plan.skipped, 4, ".DS_Store, .git, the link, and the missing item")
    }

    func testAFolderOverTheLimitIsRefusedBeforeAnythingIsSent() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("orion-plan-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        for index in 0...DropPlan.fileLimit {
            FileManager.default.createFile(atPath: base.appendingPathComponent("\(index).txt").path, contents: nil)
        }
        XCTAssertThrowsError(try DropPlan.make([base]))
    }

    func testDeviceSpecificErrorsAreNotMisreportedAsPairingProblems() {
        let response = HTTPURLResponse(url: URL(string: "http://mini.example")!, statusCode: 503, httpVersion: nil, headerFields: [:])!
        let offline = OrionClient.mapFailure(status: 503, headers: response, data: Data(#"{"ok":false,"error":"This computer is offline."}"#.utf8))
        XCTAssertEqual(offline, .server(status: 503, message: "This computer is offline."))
        let missing = OrionClient.mapFailure(status: 404, headers: response, data: Data(#"{"ok":false,"error":"This file is no longer available."}"#.utf8))
        XCTAssertEqual(missing, .server(status: 404, message: "This file is no longer available."))
    }
}

/// Runs against the isolated file fixture server, never against an operator's files.
@MainActor
final class DeviceFileIntegrationTests: XCTestCase {
    func testSavingACompletedDownloadCreatesAndReplacesDestination() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let temporary = directory.appendingPathComponent("download.txt")
        let destination = directory.appendingPathComponent("saved.txt")
        try Data("first".utf8).write(to: temporary)
        try FileBrowserStore.saveDownloadedFile(temporary, to: destination)
        XCTAssertEqual(try Data(contentsOf: destination), Data("first".utf8))
        try Data("replacement".utf8).write(to: temporary)
        try FileBrowserStore.saveDownloadedFile(temporary, to: destination)
        XCTAssertEqual(try Data(contentsOf: destination), Data("replacement".utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: temporary.path), "the transfer owns temporary-file cleanup")
    }

    private func client() async throws -> OrionClient {
        guard let host = ProcessInfo.processInfo.environment["ORION_FILES_TEST_HOST"] else {
            throw XCTSkip("Set ORION_FILES_TEST_HOST to the isolated file fixture server.")
        }
        let client = OrionClient(credentials: InMemoryCredentialStore())
        try await client.configure(host: host)
        _ = try await client.pair(pairingSecret: "test-pairing-secret", clientId: "file-tests-\(UUID().uuidString)", clientName: "File tests")
        return client
    }

    func testListsFoldersAndDownloadsPreviewAndOriginal() async throws {
        let client = try await client()
        defer { Task { try? await client.unpair() } }
        let devices = try await client.fileDevices()
        XCTAssertTrue(devices.contains { $0.id == "local" })
        let roots = try await client.fileRoots(deviceId: "local")
        let root = try XCTUnwrap(roots.first)
        let listing = try await client.fileList(deviceId: "local", root: root.id, path: "")
        let file = try XCTUnwrap(listing.entries.first { $0.name == "Welcome.md" })
        let info = try await client.fileInfo(deviceId: "local", root: root.id, path: file.name, revision: file.revision)
        let preview = try await client.downloadFile(deviceId: "local", root: root.id, path: file.name, info: info, preview: true)
        defer { try? FileManager.default.removeItem(at: preview.deletingLastPathComponent()) }
        XCTAssertEqual(preview.pathExtension, "txt")
        XCTAssertTrue(try String(contentsOf: preview, encoding: .utf8).contains("Shared workspace"))
        let original = try await client.downloadFile(deviceId: "local", root: root.id, path: file.name, info: info, preview: false)
        defer { try? FileManager.default.removeItem(at: original.deletingLastPathComponent()) }
        XCTAssertEqual(original.lastPathComponent, "Welcome.md")
        XCTAssertEqual(try Data(contentsOf: preview), try Data(contentsOf: original))
    }

    func testDroppingAFolderKeepsItsStructureAndRemovesAsAWhole() async throws {
        let client = try await client()
        defer { Task { try? await client.unpair() } }
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("orion-drop-\(UUID().uuidString)")
        let name = "Project \(UUID().uuidString.prefix(8))"
        let folder = base.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("src/empty"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        try Data("print(1)".utf8).write(to: folder.appendingPathComponent("src/main.py"))
        try Data("# Readme".utf8).write(to: folder.appendingPathComponent("README.md"))
        try Data("x".utf8).write(to: folder.appendingPathComponent(".env"))
        let browser = FileBrowserStore(client: client)
        await browser.refreshDevices()
        await browser.drop([folder])
        XCTAssertNil(browser.error)
        XCTAssertEqual(browser.dropMessage, "Sent 2 of 2 files to Orion. Folders keep their structure. Hidden files and links were left on this Mac.")
        let dropped = try XCTUnwrap(browser.entries.first { $0.name == name && $0.isDirectory })
        await browser.open(root: browser.rootId, path: "\(name)/src")
        XCTAssertEqual(browser.entries.map(\.name), ["empty", "main.py"])
        await browser.open(root: browser.rootId, path: "")
        await browser.drop([folder])
        XCTAssertTrue(browser.entries.contains { $0.name == "\(name) (2)" }, "a second drop never merges into the first")
        await browser.removeDropped(dropped)
        await browser.removeDropped(try XCTUnwrap(browser.entries.first { $0.name == "\(name) (2)" }))
        XCTAssertNil(browser.error)
        XCTAssertFalse(browser.entries.contains { $0.name.hasPrefix(name) })
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent("src/main.py").path), "the originals stay")
        browser.stop()
    }

    func testDroppingSendsOnlyChosenFilesShowsThemAndCanTakeThemBack() async throws {
        let client = try await client()
        defer { Task { try? await client.unpair() } }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("orion-drop-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("Folder"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let name = "Drop \(UUID().uuidString.prefix(8)) + notes.txt"
        let chosen = directory.appendingPathComponent(name)
        try Data("chosen on this Mac".utf8).write(to: chosen)
        let browser = FileBrowserStore(client: client)
        await browser.refreshDevices()
        await browser.drop([chosen])
        XCTAssertNil(browser.error)
        XCTAssertEqual(browser.dropMessage, "Sent 1 of 1 files to Orion.")
        XCTAssertTrue(browser.showingDrops, "the browser shows where the file went")
        let dropped = try XCTUnwrap(browser.entries.first { $0.name == name })
        let info = try await client.fileInfo(deviceId: "local", root: browser.rootId, path: name, revision: dropped.revision)
        let copy = try await client.downloadFile(deviceId: "local", root: browser.rootId, path: name, info: info, preview: false)
        defer { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }
        XCTAssertEqual(try Data(contentsOf: copy), Data("chosen on this Mac".utf8))
        await browser.removeDropped(dropped)
        XCTAssertNil(browser.error)
        XCTAssertFalse(browser.entries.contains { $0.name == name })
        XCTAssertTrue(FileManager.default.fileExists(atPath: chosen.path), "removing from Orion leaves the original")
        browser.stop()
    }

    func testStoreNavigatesAndHandlesOfflineDevices() async throws {
        let client = try await client()
        defer { Task { try? await client.unpair() } }
        let browser = FileBrowserStore(client: client)
        await browser.refreshDevices()
        XCTAssertFalse(browser.loading)
        XCTAssertFalse(browser.entries.isEmpty)
        XCTAssertNil(browser.error)
        let folder = try XCTUnwrap(browser.entries.first { $0.isDirectory })
        await browser.open(root: browser.rootId, path: browser.entryPath(folder))
        XCTAssertEqual(browser.path, folder.name)
        XCTAssertFalse(browser.loading)
        await browser.parent()
        XCTAssertEqual(browser.path, "")
        browser.stop()
        await browser.refreshDevices()
        XCTAssertFalse(browser.entries.isEmpty, "returning to Files reloads the folder")
        await browser.selectDevice("offline-pc")
        XCTAssertTrue(browser.entries.isEmpty)
        XCTAssertTrue(browser.error?.contains("offline") == true)
        browser.stop()
    }
}
