import Foundation
import UserNotifications

/// Local notifications for the two events the user cares about when the window is not focused:
/// an agent finished a reply, and the connection to the Mini dropped.
///
/// Nothing here reaches the network, and no prompt or reply text is included in a notification
/// body — a banner on a shared screen should not leak the contents of a session.
public protocol Notifying: Sendable {
    func requestAuthorizationIfNeeded() async
    func notify(title: String, body: String) async
}

public struct SystemNotifier: Notifying {
    public init() {}

    public func requestAuthorizationIfNeeded() async {
        // UNUserNotificationCenter traps when there is no bundle identifier, which is the case
        // when the executable is run directly instead of from the assembled .app.
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }

    public func notify(title: String, body: String) async {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        try? await center.add(request)
    }
}

/// No-op notifier for tests and for running outside an app bundle.
public struct SilentNotifier: Notifying {
    public init() {}
    public func requestAuthorizationIfNeeded() async {}
    public func notify(title: String, body: String) async {}
}
