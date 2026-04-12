import SwiftUI

struct StatsBarView: View {
    let manager: SessionManager

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text("⚡ \(manager.activeCount) active")
                    .foregroundStyle(.primary)

                if manager.totalAgentCount > 0 {
                    Text("(\(manager.totalAgentCount) total)")
                        .foregroundStyle(.secondary)
                }

                Text("↑ \(formatTokenRate(manager.globalInputTokensPerMinute)) ↓ \(formatTokenRate(manager.globalOutputTokensPerMinute)) /min")
                    .foregroundStyle(.secondary)

                Spacer(minLength: 0)
            }
            .font(.subheadline)
            .monospacedDigit()

            if manager.stalledCount > 0 {
                Text("⚠ \(manager.stalledCount) stalled")
                    .font(.subheadline)
                    .foregroundStyle(.red)
                    .monospacedDigit()
            }
        }
    }
}
