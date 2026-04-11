import SwiftUI

@main
struct ClaudePulseMenuApp: App {
    @State private var manager = SessionManager()

    var body: some Scene {
        MenuBarExtra {
            MenuPopoverView(manager: manager)
        } label: {
            HStack(spacing: 5) {
                Text("⚡")
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
