import SwiftUI

/// The app scene graph. Lives in OrionKit so the executable target is a single line and every
/// testable piece stays importable by `swift test`.
public struct OrionRootApp: App {
    @State private var store = OrionStore()

    public init() {}

    public var body: some Scene {
        WindowGroup("Orion") {
            RootView(store: store)
        }
        .defaultSize(width: 1040, height: 680)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Refresh") { Task { await store.refreshAll() } }
                    .keyboardShortcut("r", modifiers: [.command])
                Button("Reconnect") { Task { await store.connect() } }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
            }
        }

        // Phase 4: a menu-bar entry point that reuses the same store and API path.
        MenuBarExtra("Orion", systemImage: "circle.hexagongrid") {
            MenuBarView(store: store)
        }
        .menuBarExtraStyle(.window)
    }
}
