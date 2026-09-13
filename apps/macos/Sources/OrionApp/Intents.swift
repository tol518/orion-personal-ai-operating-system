import AppIntents
import OrionKit
import SwiftUI

// Siri and Shortcuts entry points.
//
// These are deliberately thin: every one delegates to OrionIntentService, which uses the same
// transport, Keychain entry, and desktop API as the windowed app. A spoken request and a typed
// one take the same path to the Mini, so an agent cannot behave differently through Siri.
//
// Scope is limited to what the plan classes as safe — open the app, report status, send a chat
// turn. No device control, no node action, no memory access, and nothing destructive.

struct CheckOrionStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Orion Status"
    static let description = IntentDescription(
        "Reports whether the Mini and the OpenClaw gateway are reachable.",
        categoryName: "Status"
    )
    /// Runs in the background: asking whether something is up should not steal focus.
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let sentence = await OrionIntentService().statusSentence()
        return .result(dialog: IntentDialog(stringLiteral: sentence))
    }
}

struct SendToOrionIntent: AppIntent {
    static let title: LocalizedStringResource = "Send a Message to Orion"
    static let description = IntentDescription(
        "Sends a message to an Orion agent on the Mini. The run continues there whether or not this Mac stays awake.",
        categoryName: "Chat"
    )
    static let openAppWhenRun = false

    @Parameter(title: "Message", requestValueDialog: "What should I send to Orion?")
    var message: String

    @Parameter(title: "Agent", description: "Leave empty to continue the most recent session.")
    var agent: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$message) to Orion") {
            \.$agent
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            let confirmation = try await OrionIntentService().send(message: message, toAgentNamed: agent)
            return .result(dialog: IntentDialog(stringLiteral: confirmation))
        } catch {
            // Surfaced as speech rather than thrown, so Siri says something useful instead of
            // "something went wrong".
            let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return .result(dialog: IntentDialog(stringLiteral: reason))
        }
    }
}

struct CheckOrionUsageIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Orion Usage"
    static let description = IntentDescription(
        "Reports token spend and the Codex weekly allowance.",
        categoryName: "Usage"
    )
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let sentence = await OrionIntentService().usageSentence()
        return .result(dialog: IntentDialog(stringLiteral: sentence))
    }
}

struct CheckCodexAllowanceIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Codex Allowance"
    static let description = IntentDescription(
        "Reports how much of the Codex weekly allowance is left.",
        categoryName: "Usage"
    )
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let sentence = await OrionIntentService().codexAllowanceSentence()
        return .result(dialog: IntentDialog(stringLiteral: sentence))
    }
}

struct OpenOrionIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Orion"
    static let description = IntentDescription("Brings the Orion window to the front.", categoryName: "Status")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}

/// Phrases Siri recognises without the user configuring anything.
struct OrionShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CheckOrionStatusIntent(),
            // Several ways of asking the same thing. Without the bare "Check Orion" form, that
            // phrase falls through to the open-the-app shortcut, which is not what someone
            // asking about status wants.
            phrases: [
                "Check \(.applicationName)",
                "Check \(.applicationName) status",
                "Check on \(.applicationName)",
                "Is \(.applicationName) connected",
                "How is \(.applicationName)",
                "\(.applicationName) status",
            ],
            shortTitle: "Orion Status",
            systemImageName: "gauge.with.dots.needle.33percent"
        )
        AppShortcut(
            intent: SendToOrionIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Tell \(.applicationName)",
                "Message \(.applicationName)",
            ],
            shortTitle: "Message Orion",
            systemImageName: "bubble.left.and.bubble.right"
        )
        AppShortcut(
            intent: CheckOrionUsageIntent(),
            // Short phrases first. Siri's app-shortcut matching is unreliable with long
            // sentences — a full question falls through to "hasn't added support for that".
            phrases: [
                "\(.applicationName) usage",
                "Check \(.applicationName) usage",
                "\(.applicationName) spend",
                "\(.applicationName) tokens",
            ],
            shortTitle: "Orion Usage",
            systemImageName: "chart.bar"
        )
        AppShortcut(
            intent: CheckCodexAllowanceIntent(),
            phrases: [
                "\(.applicationName) Codex",
                "\(.applicationName) Codex allowance",
                "Check \(.applicationName) Codex",
                "\(.applicationName) Codex limit",
            ],
            shortTitle: "Codex Allowance",
            systemImageName: "gauge.with.needle"
        )
        AppShortcut(
            intent: OpenOrionIntent(),
            phrases: ["Open \(.applicationName)"],
            shortTitle: "Open Orion",
            systemImageName: "circle.hexagongrid"
        )
    }
}
