import SwiftUI

struct SessionRowView: View {
    let session: ClaudeSession
    var depth: Int = 0
    var childSummary: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: depth > 0 ? 8 : 0) {
            if depth > 0 {
                Rectangle()
                    .fill(Color.secondary.opacity(0.25))
                    .frame(width: 1)
                    .padding(.vertical, 4)
            }

            VStack(alignment: .leading, spacing: depth == 0 ? 4 : 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    statusDot
                        .padding(.top, 1)

                    agentTypeIcon

                    Text(projectName)
                        .font(.system(depth == 0 ? .subheadline : .footnote, design: .default))
                        .foregroundStyle(depth == 0 ? .primary : .secondary)
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
                    if depth == 0 {
                        Text(session.workspaceID.map { "ws \($0)" } ?? "ws -")
                        Text(formatTTY(session.tty))
                    }
                    Text("pid \(String(session.pid))")

                    if session.didCrash {
                        badge("CRASHED", color: .red)
                    }

                    if session.turnState == .working && (session.inputTokensPerMinute + session.outputTokensPerMinute) == 0 {
                        badge("waiting", color: .orange)
                    }

                    if let summary = childSummary {
                        badge(summary, color: .blue)
                    }

                    Spacer(minLength: 0)
                }
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .padding(.leading, 24)
            }
        }
        .padding(.vertical, depth == 0 ? 4 : 2)
        .padding(.leading, CGFloat(depth) * 16)
        .opacity(depth == 0 ? 1.0 : 0.85)
    }

    private var statusDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: depth == 0 ? 8 : 6, height: depth == 0 ? 8 : 6)
    }

    private var agentTypeIcon: some View {
        Image(systemName: agentTypeSymbol)
            .font(.system(size: depth == 0 ? 12 : 10, weight: .semibold))
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
