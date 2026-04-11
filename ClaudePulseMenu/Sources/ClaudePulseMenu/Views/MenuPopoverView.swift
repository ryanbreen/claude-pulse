import SwiftUI

struct MenuPopoverView: View {
    let manager: SessionManager

    private var visibleSessions: [ClaudeSession] {
        let now = Date().timeIntervalSince1970
        let recentlyActiveCutoff: TimeInterval = 300  // 5 minutes
        return manager.sessions.filter { session in
            let hasRecentTokens = (session.inputTokensPerMinute + session.outputTokensPerMinute) > 0
            if hasRecentTokens { return true }

            // Stalled is only meaningful if the session was doing something recently.
            // A "stalled" session whose log hasn't been touched in hours is just dormant.
            let lastActivity = max(session.lastLogEventAt, session.lastLogMtime)
            let isRecent = lastActivity > 0 && (now - lastActivity) < recentlyActiveCutoff
            return session.turnState == .stalled && isRecent
        }
    }

    private var maxListHeight: CGFloat {
        let screenHeight = NSScreen.main?.frame.height ?? 1080
        return screenHeight * 0.5
    }

    private var estimatedListHeight: CGFloat {
        // ~46pt per row (two-line row + padding)
        let rowHeight: CGFloat = 46
        return CGFloat(visibleSessions.count) * rowHeight
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            StatsBarView(manager: manager)
            Divider()
            if visibleSessions.isEmpty {
                HStack {
                    Spacer()
                    Text("No active agent sessions")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                    Spacer()
                }
                .frame(height: 40)
            } else {
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(visibleSessions) { session in
                            SessionRowView(session: session)
                        }
                    }
                }
                .frame(height: min(estimatedListHeight, maxListHeight))
            }
            Divider()
            HStack {
                Spacer()
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.plain)
                .font(.caption)
            }
        }
        .padding(12)
        .frame(minWidth: 400, maxWidth: 700)
    }
}
