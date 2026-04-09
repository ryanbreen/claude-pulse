import SwiftUI

struct StatsBarView: View {
    let manager: SessionManager

    var body: some View {
        HStack(spacing: 6) {
            Text("Active:")
                .foregroundStyle(.secondary)
            Text("\(manager.activeCount)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.green)
            Text("⚡")
                .font(.caption)

            Text("Idle:")
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
            Text("\(manager.idleCount)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.yellow)

            if manager.stalledCount > 0 {
                Text("Stalled:")
                    .foregroundStyle(.secondary)
                    .padding(.leading, 4)
                Text("\(manager.stalledCount)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.red)
                Text("✕")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Text("|")
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 2)

            Text("CPU:")
                .foregroundStyle(.secondary)
            Text(String(format: "%.1f%%", manager.totalCpu))
                .font(.system(.caption, design: .monospaced))

            Text("MEM:")
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
            Text(formatMemory(manager.totalMemMB))
                .font(.system(.caption, design: .monospaced))

            Text("|")
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 2)

            Text("Longest:")
                .foregroundStyle(.secondary)
            Text(formatDuration(manager.longestSession))
                .font(.system(.caption, design: .monospaced))

            Spacer()
        }
        .font(.caption)
    }

    private func formatMemory(_ mb: Double) -> String {
        if mb >= 1024 {
            return String(format: "%.1f GB", mb / 1024)
        }
        return String(format: "%.0f MB", mb)
    }

    private func formatDuration(_ seconds: Int) -> String {
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        if h > 0 {
            return "\(h)h \(m)m"
        }
        return "\(m)m"
    }
}
