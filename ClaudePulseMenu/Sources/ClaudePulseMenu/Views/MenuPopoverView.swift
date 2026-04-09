import SwiftUI

struct MenuPopoverView: View {
    let manager: SessionManager

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            StatsBarView(manager: manager)
            Divider()
            if manager.sessions.isEmpty {
                Spacer()
                HStack {
                    Spacer()
                    Text("No active Claude sessions")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                    Spacer()
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(manager.sessions) { session in
                            SessionRowView(session: session)
                        }
                    }
                }
            }
            Divider()
            HStack {
                Text(manager.totalCount == 1 ? "1 session" : "\(manager.totalCount) sessions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.plain)
                .font(.caption)
            }
        }
        .padding(12)
        .frame(width: 420)
        .frame(maxHeight: 500)
    }
}
