import Foundation
import SwiftUI

@Observable
class SessionManager {
    var sessions: [ClaudeSession] = []
    var activeCount: Int = 0
    var idleCount: Int = 0
    var stalledCount: Int = 0
    var totalCount: Int = 0
    var subagentCount: Int = 0
    var totalCpu: Double = 0
    var totalMemMB: Double = 0
    var longestSession: Int = 0

    private var timer: Timer?

    init() {
        startPolling()
    }

    func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        timer?.tolerance = 0.5
        refresh()
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    private func refresh() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let scanned = ProcessScanner.scan()

            let interactive = scanned.filter { !$0.isSubagent }
            let subagents = scanned.filter { $0.isSubagent }

            let active = interactive.filter { $0.isWorking }
            let stalled = interactive.filter { $0.turnState == .stalled }
            let idle = interactive.filter { !$0.isWorking && $0.turnState != .stalled }

            let totalCpu = scanned.reduce(0.0) { $0 + $1.cpuPercent }
            let totalMem = scanned.reduce(0.0) { $0 + $1.rssMB }
            let longest = interactive.map { $0.elapsedSeconds }.max() ?? 0

            let sortedInteractive = interactive.sorted { $0.cpuPercent > $1.cpuPercent }
            let sortedSubagents = subagents.sorted { $0.cpuPercent > $1.cpuPercent }
            let sorted = sortedInteractive + sortedSubagents

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.sessions = sorted
                self.activeCount = active.count
                self.idleCount = idle.count
                self.stalledCount = stalled.count
                self.totalCount = interactive.count
                self.subagentCount = subagents.count
                self.totalCpu = totalCpu
                self.totalMemMB = totalMem
                self.longestSession = longest
            }
        }
    }
}
