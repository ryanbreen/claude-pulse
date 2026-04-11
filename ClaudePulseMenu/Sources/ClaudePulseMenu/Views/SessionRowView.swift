import SwiftUI

struct SessionRowView: View {
    let session: ClaudeSession

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                statusDot
                    .padding(.top, 1)

                agentTypeIcon

                Text(projectName)
                    .font(.system(.subheadline, design: .default))
                    .lineLimit(1)
                    .truncationMode(.middle)

                Text(formatDuration(session.elapsedSeconds))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(uptimeColor(session.elapsedSeconds))
                    .monospacedDigit()

                Spacer(minLength: 0)

                Text("↑ \(formatTokenRate(session.inputTokensPerMinute)) ↓ \(formatTokenRate(session.outputTokensPerMinute)) /min")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(tokenRateColor)
                    .monospacedDigit()
            }

            HStack(spacing: 8) {
                Text(session.workspaceID.map { "ws \($0)" } ?? "ws -")
                Text(formatTTY(session.tty))
                Text("pid \(String(session.pid))")

                if session.didCrash {
                    badge("CRASHED", color: .red)
                }

                if session.isSubagent {
                    Text("sub")
                        .foregroundStyle(.tertiary)
                }

                Spacer(minLength: 0)
            }
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .padding(.leading, 24)
        }
        .padding(.vertical, 4)
    }

    private var statusDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 8, height: 8)
    }

    private var agentTypeIcon: some View {
        Image(systemName: agentTypeSymbol)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(agentTypeColor)
            .frame(width: 14)
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

    private var agentTypeSymbol: String {
        switch session.agentType {
        case .claude:
            return "brain.head.profile"
        case .codex:
            return "chevron.left.forwardslash.chevron.right"
        case .gemini:
            return "sparkles"
        }
    }

    private var agentTypeColor: Color {
        switch session.agentType {
        case .claude:
            return .cyan
        case .codex:
            return .green
        case .gemini:
            return .purple
        }
    }

    private var projectName: String {
        let trimmed = session.cwd.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmed.isEmpty {
            return session.cwd
        }
        return URL(fileURLWithPath: session.cwd).lastPathComponent
    }

    private var tokenRateColor: Color {
        (session.inputTokensPerMinute + session.outputTokensPerMinute) > 0 ? .primary : .secondary
    }

    private func uptimeColor(_ seconds: Int) -> Color {
        if seconds > 43200 { return .red }
        if seconds > 3600 { return .orange }
        return .primary
    }

    @ViewBuilder
    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(
                Capsule()
                    .fill(color.opacity(0.12))
            )
    }
}
