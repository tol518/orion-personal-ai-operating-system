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
}
