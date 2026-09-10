// swift-tools-version: 6.0
import PackageDescription

// Orion.app is built as a Swift package rather than an Xcode project so it can be built, tested,
// and bundled from the command line. `make app` assembles the .app around the executable.
//
// OrionKit holds every testable piece — transport, transcript normalization, and view models —
// so the logic can be exercised by `swift test` without launching a UI.
let package = Package(
    name: "Orion",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "OrionApp", targets: ["OrionApp"]),
        .library(name: "OrionKit", targets: ["OrionKit"]),
    ],
    targets: [
        .target(
            name: "OrionKit",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "OrionApp",
            dependencies: ["OrionKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "OrionKitTests",
            dependencies: ["OrionKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
