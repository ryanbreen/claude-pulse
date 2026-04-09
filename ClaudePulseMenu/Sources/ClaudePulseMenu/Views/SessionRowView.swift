import SwiftUI

struct SessionRowView: View {
    let session: ClaudeSession

    var body: some View {
        HStack(spacing: 6) {
            statusDot
                .frame(width: 10)

            Text("\(session.pid)")
                .font(.system(.caption, design: .monospaced))
                .frame(width: 46, alignment: .leading)

            Text(formatTTY(session.tty))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 36, alignment: .leading)

            Text(formatDuration(session.elapsedSeconds))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(uptimeColor(session.elapsedSeconds))
                .frame(width: 48, alignment: .trailing)

            Text(String(format: "%.1f%%", session.cpuPercent))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(cpuColor(session.cpuPercent))
                .frame(width: 44, alignment: .trailing)

            Text(String(format: "%.0fM", session.rssMB))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .trailing)

            Text(modeLabel)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(session.isSubagent ? .tertiary : .secondary)
                .frame(width: 60, alignment: .leading)

            Text(truncatedPath(session.cwd))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(1)
                .truncationMode(.head)
        }
        .padding(.vertical, 1)
        .opacity(session.isSubagent ? 0.6 : 1.0)
    }

    private var statusDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 7, height: 7)
    }

    private var dotColor: Color {
        switch session.turnState {
        case .stalled:
            return .red
        case .working:
            return session.cpuPercent > 10.0 ? .green : .yellow
        case .idle:
            return .gray
        case .unknown:
            return session.cpuPercent > 3.0 ? .yellow : .gray
        }
    }

    private var modeLabel: String {
        if session.isSubagent { return "subagent" }
        if session.flags.isEmpty { return "new" }
        return session.flags.joined(separator: "+")
    }

    private func formatTTY(_ tty: String) -> String {
        if tty.hasPrefix("ttys") {
            return "s" + tty.dropFirst(4)
        }
        return tty
    }

    private func uptimeColor(_ seconds: Int) -> Color {
        if seconds > 43200 { return .red }
        if seconds > 3600 { return .orange }
        return .primary
    }

    private func cpuColor(_ cpu: Double) -> Color {
        if cpu > 10.0 { return .green }
        if cpu > 1.0 { return .yellow }
        return .secondary
    }

    private func truncatedPath(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }
}

func formatDuration(_ seconds: Int) -> String {
    if seconds >= 3600 {
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        return "\(h)h \(m)m"
    }
    if seconds >= 60 {
        let m = seconds / 60
        return "\(m)m"
    }
    return "\(seconds)s"
}
