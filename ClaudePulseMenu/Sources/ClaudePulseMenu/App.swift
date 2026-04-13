import SwiftUI
import AppKit

@main
struct ClaudePulseMenuApp: App {
    @State private var manager = SessionManager()

    init() {
        // Single-instance guard: if another copy is already running, exit immediately.
        let dominated = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0 != NSRunningApplication.current }
        if !dominated.isEmpty {
            // Another instance is already running — terminate this one.
            NSApplication.shared.terminate(nil)
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuPopoverView(manager: manager)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "brain.head.profile")
                Text("\(manager.activeCount)")

                if manager.globalInputTokensPerMinute > 0 || manager.globalOutputTokensPerMinute > 0 {
                    Text("↑\(formatTokenRate(manager.globalInputTokensPerMinute)) ↓\(formatTokenRate(manager.globalOutputTokensPerMinute))")
                }
            }
            .monospacedDigit()
        }
        .menuBarExtraStyle(.window)
    }
}
