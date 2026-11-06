import Foundation

public struct FileDevice: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
    public let connected: Bool
    public let available: Bool
    public let local: Bool
}

public struct FileRoot: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    /// True only for the Orion server's Dropped files, the one folder that accepts new files.
    public let writable: Bool

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decode(String.self, forKey: .label)
        writable = try container.decodeIfPresent(Bool.self, forKey: .writable) ?? false
    }

    private enum CodingKeys: String, CodingKey { case id, label, writable }
}

/// A file this Mac sent to the Orion server's Dropped files, under the name the server gave it.
public struct DroppedFile: Decodable, Sendable {
    public let rootId: String
    public let name: String
    public let sizeBytes: Int64
}

public struct DeviceFile: Decodable, Identifiable, Equatable, Sendable {
    public let name: String
    public let kind: String
    public let sizeBytes: Int64
    public let modifiedAt: Date
    public let revision: String
    public var id: String { name }
    public var isDirectory: Bool { kind == "directory" }
    public var sizeLabel: String {
        isDirectory ? "Folder" : ByteCountFormatter.string(fromByteCount: sizeBytes, countStyle: .file)
    }
}

public struct DeviceFileInfo: Decodable, Sendable {
    public let name: String
    public let sizeBytes: Int64
    public let revision: String
    public let previewKind: String
    public let mimeType: String
}

struct FileDevicesResponse: Decodable {
    let devices: [FileDevice]
    let gatewayUnavailable: Bool
}
struct FileRootsResponse: Decodable { let roots: [FileRoot] }
public struct FileListing: Decodable, Sendable {
    public let entries: [DeviceFile]
    public let nextOffset: Int?
    public let scanTruncated: Bool
}

enum DeviceFileRequest {
    static func path(deviceId: String, action: String, root: String? = nil, path: String = "", revision: String? = nil, offset: Int? = nil, preview: Bool = false) -> String {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))
        let encodedId = deviceId.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        var components = URLComponents()
        components.path = "files/\(encodedId)/\(action)"
        var items: [URLQueryItem] = []
        if let root {
            items.append(URLQueryItem(name: "root", value: root))
            items.append(URLQueryItem(name: "path", value: path))
        }
        if let revision { items.append(URLQueryItem(name: "revision", value: revision)) }
        if let offset { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        if action == "content" { items.append(URLQueryItem(name: preview ? "preview" : "download", value: "1")) }
        // Set the path as already encoded to avoid double-encoding a device id.
        components.percentEncodedPath = "files/\(encodedId)/\(action)"
        if !items.isEmpty { components.queryItems = items }
        // Express decodes query values as form data, where a literal plus means a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.string ?? ""
    }

    /// Sending a file to, or removing one from, the Orion server's Dropped files.
    static func drop(name: String) -> String {
        var components = URLComponents()
        components.percentEncodedPath = "files/local/drops"
        components.queryItems = [URLQueryItem(name: "name", value: name)]
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.string ?? ""
    }
}
