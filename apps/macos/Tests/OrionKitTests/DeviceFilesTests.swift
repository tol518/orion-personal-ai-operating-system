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
