import SwiftUI

@main
struct ClaudePulseMenuApp: App {
    @State private var manager = SessionManager()

    var body: some Scene {
        MenuBarExtra {
            MenuPopoverView(manager: manager)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: manager.activeCount > 0 ? "bolt.fill" : "bolt")
                Text("\(manager.activeCount)/\(manager.totalCount)")
                    .monospacedDigit()
            }
        }
        .menuBarExtraStyle(.window)
    }
}
