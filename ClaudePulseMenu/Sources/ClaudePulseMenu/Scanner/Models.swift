import Foundation

let activeCpuThreshold: Double = 3.0
let stalledAfterSeconds: TimeInterval = 60.0
let geminiResponseTimeoutSeconds: TimeInterval = 30.0
let recentLogPublishGraceSeconds: TimeInterval = 15.0

enum AgentType: String, Sendable {
    case claude, codex, gemini

    var displayName: String {
        rawValue.capitalized
    }

    var color: String {
        switch self {
        case .claude: return "cyan"
        case .codex: return "green"
        case .gemini: return "purple"
        }
    }
}

enum TurnState: String, Sendable {
    case working, idle, stalled, unknown
}

struct AgentSession: Identifiable, Sendable {
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
    var sessionId: String?
    let isSubagent: Bool
    var turnState: TurnState
    let agentType: AgentType
    var logPath: String?
    var lastLogEventAt: TimeInterval
    var lastLogMtime: TimeInterval
    var didCrash: Bool
    var hasCompletionEvent: Bool
    var inputTokens: Int
    var cacheCreationInputTokens: Int
    var cachedInputTokens: Int
    var outputTokens: Int
    var reasoningOutputTokens: Int
    var thoughtTokens: Int
    var toolTokens: Int
    var totalTokens: Int
    var tokensPerMinute: Double
    var inputTokensPerMinute: Double
    var outputTokensPerMinute: Double
    var workspaceID: Int?

    var isWorking: Bool {
        turnState == .working
    }

    var isInteractive: Bool {
        !isSubagent
    }
}

typealias ClaudeSession = AgentSession

struct ScanResult: Sendable {
    let sessions: [AgentSession]
    let parentMap: [Int: Int]
}

struct SessionNode: Identifiable, Sendable {
    let session: AgentSession
    var children: [SessionNode]

    var id: Int {
        session.id
    }
}

enum SessionSpeaker: String, Sendable {
    case user, assistant, gemini, system, unknown
}

struct TokenDelta: Sendable {
    let sessionKey: String
    let agentType: AgentType
    let timestamp: TimeInterval
    let inputTokens: Int
    let cacheCreationInputTokens: Int
    let cachedInputTokens: Int
    let outputTokens: Int
    let reasoningOutputTokens: Int
    let thoughtTokens: Int
    let toolTokens: Int

    var totalTokens: Int {
        totalInputTokens + totalOutputTokens
    }

    var totalInputTokens: Int {
        switch agentType {
        case .claude:
            return inputTokens + cacheCreationInputTokens + cachedInputTokens
        case .codex, .gemini:
            return inputTokens
        }
    }

    var totalOutputTokens: Int {
        switch agentType {
        case .claude, .codex:
            return outputTokens
        case .gemini:
            return outputTokens + thoughtTokens + toolTokens
        }
    }
}

struct SessionLogSnapshot: Sendable {
    let sessionKey: String
    let logPath: String
    let agentType: AgentType
    let sessionId: String?
    let cwd: String
    let isSubagent: Bool
    let lastEventAt: TimeInterval
    let lastModifiedAt: TimeInterval
    let lastHumanMessageAt: TimeInterval
    let lastAssistantMessageAt: TimeInterval
    let lastTurnCompleteAt: TimeInterval
    let lastToolUseAt: TimeInterval
    let lastToolResultAt: TimeInterval
    let lastTaskStartedAt: TimeInterval
    let lastTaskCompletedAt: TimeInterval
    let lastSpeaker: SessionSpeaker
    let pendingToolCallCount: Int
    let hasCompletionEvent: Bool
    let inputTokens: Int
    let cacheCreationInputTokens: Int
    let cachedInputTokens: Int
    let outputTokens: Int
    let reasoningOutputTokens: Int
    let thoughtTokens: Int
    let toolTokens: Int
    let totalTokens: Int

    func resolvedTurnState(cpuPercent: Double, isAlive: Bool, now: TimeInterval) -> TurnState {
        switch agentType {
        case .claude:
            return resolveClaudeTurnState(now: now)
        case .codex:
            return resolveCodexTurnState(cpuPercent: cpuPercent, isAlive: isAlive, now: now)
        case .gemini:
            return resolveGeminiTurnState(cpuPercent: cpuPercent, isAlive: isAlive, now: now)
        }
    }

    func didCrash(isAlive: Bool) -> Bool {
        guard !isAlive else { return false }

        switch agentType {
        case .claude:
            return lastHumanMessageAt > lastTurnCompleteAt
        case .codex:
            return !hasCompletionEvent && lastTaskStartedAt > 0
        case .gemini:
            return lastSpeaker != .gemini && lastSpeaker != .unknown
        }
    }

    func shouldPublishWithoutProcess(now: TimeInterval, hasRecentTokenTraffic: Bool = false) -> Bool {
        if didCrash(isAlive: false) {
            let crashedDisplaySeconds: TimeInterval = 300
            return now - lastModifiedAt <= crashedDisplaySeconds
        }

        return hasRecentTokenTraffic
    }

    /// The most recent conversation activity timestamp (excludes file-history-snapshot mtime).
    private var lastConversationAt: TimeInterval {
        max(lastHumanMessageAt, lastAssistantMessageAt, lastTurnCompleteAt,
            lastToolUseAt, lastToolResultAt)
    }

    private func resolveClaudeTurnState(now: TimeInterval) -> TurnState {
        if lastHumanMessageAt == 0,
           lastAssistantMessageAt == 0,
           lastTurnCompleteAt == 0,
           lastToolUseAt == 0,
           lastToolResultAt == 0 {
            return .unknown
        }

        if now - lastConversationAt <= recentLogPublishGraceSeconds {
            return .working
        }

        if lastTurnCompleteAt >= lastHumanMessageAt {
            return .idle
        }

        if lastToolUseAt > lastToolResultAt && lastToolUseAt > lastTurnCompleteAt {
            if now - lastToolUseAt < 90 {
                return .working
            }
            return .stalled
        }

        if lastAssistantMessageAt <= lastHumanMessageAt {
            if now - lastHumanMessageAt > 120 {
                return .stalled
            }
            return .working
        }

        if now - lastConversationAt > stalledAfterSeconds {
            return .stalled
        }

        return .working
    }

    private func resolveCodexTurnState(cpuPercent: Double, isAlive: Bool, now: TimeInterval) -> TurnState {
        if hasCompletionEvent && lastTaskCompletedAt >= lastTaskStartedAt {
            return .idle
        }

        if pendingToolCallCount > 0 {
            return .working
        }

        if isAlive,
           lastEventAt > 0,
           now - lastEventAt > stalledAfterSeconds,
           cpuPercent < activeCpuThreshold {
            return .stalled
        }

        if lastTaskStartedAt > 0 || lastEventAt > 0 {
            return .working
        }

        return .unknown
    }

    private func resolveGeminiTurnState(cpuPercent: Double, isAlive: Bool, now: TimeInterval) -> TurnState {
        if lastSpeaker == .unknown {
            return .unknown
        }

        if isAlive,
           now - lastModifiedAt <= recentLogPublishGraceSeconds {
            return .working
        }

        if lastSpeaker == .gemini {
            return .idle
        }

        if lastSpeaker == .user,
           now - lastHumanMessageAt > geminiResponseTimeoutSeconds,
           cpuPercent < activeCpuThreshold {
            return .stalled
        }

        if lastSpeaker == .user {
            return .working
        }

        return .unknown
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
