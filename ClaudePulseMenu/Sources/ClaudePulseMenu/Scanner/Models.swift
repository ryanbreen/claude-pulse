import Foundation

let activeCpuThreshold: Double = 3.0

enum TurnState: String, Sendable {
    case working, idle, stalled, unknown
}

struct ClaudeSession: Identifiable, Sendable {
    let id: Int
    let pid: Int
    let ppid: Int
    let tty: String
    let elapsed: String
    let elapsedSeconds: Int
    let cpuPercent: Double
    let rssMB: Double
    let command: String
    var cwd: String
    let flags: [String]
    let sessionId: String?
    let isSubagent: Bool
    var turnState: TurnState

    var isWorking: Bool {
        turnState == .working || (turnState == .unknown && cpuPercent > activeCpuThreshold)
    }

    var isInteractive: Bool {
        !isSubagent
    }
}

func parseElapsedTime(_ raw: String) -> Int {
    var s = raw.trimmingCharacters(in: .whitespaces)
    var days = 0

    // Strip optional leading DD- or D-
    if let dashRange = s.range(of: "-") {
        let dayStr = String(s[s.startIndex ..< dashRange.lowerBound])
        if let d = Int(dayStr) {
            days = d
            s = String(s[dashRange.upperBound...])
        }
    }

    let parts = s.split(separator: ":").compactMap { Int($0) }
    switch parts.count {
    case 2:
        return days * 86400 + parts[0] * 60 + parts[1]
    case 3:
        return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
    default:
        return days * 86400
    }
}
