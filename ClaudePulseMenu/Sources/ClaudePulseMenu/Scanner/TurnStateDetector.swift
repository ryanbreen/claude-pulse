import Foundation

struct TurnStateDetector: Sendable {
    private struct TurnTimestamps: Sendable {
        var lastHumanMessageTs: TimeInterval = 0
        var lastAssistantAnyTs: TimeInterval = 0
        var lastTurnEndTs: TimeInterval = 0
        var lastToolUseTs: TimeInterval = 0
        var lastToolResultTs: TimeInterval = 0
    }

    private let path: String
    private let isSubagent: Bool
    private var tailer: LogTailer
    private var timestamps = TurnTimestamps()
    private var sessionId: String?
    private var cwd = "unknown"
    private var lastEventAt: TimeInterval = 0

    private var inputTokens = 0
    private var cacheCreationInputTokens = 0
    private var cachedInputTokens = 0
    private var outputTokens = 0
    private var reasoningOutputTokens = 0
    private var thoughtTokens = 0
    private var toolTokens = 0
    private var totalTokens = 0

    init(path: String) {
        self.path = path
        self.isSubagent = path.contains("/subagents/")
        self.tailer = LogTailer(path: path)
    }

    mutating func readUpdates() -> [TokenDelta] {
        let lines = tailer.readNewLines()
        guard !lines.isEmpty else { return [] }

        var deltas: [TokenDelta] = []

        for line in lines {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                continue
            }

            if let lineCwd = object["cwd"] as? String, !lineCwd.isEmpty {
                cwd = lineCwd
            }
            if let lineSessionId = object["sessionId"] as? String, !lineSessionId.isEmpty {
                sessionId = lineSessionId
            }

            guard let type = object["type"] as? String else { continue }

            // Only count conversation entries for lastEventAt — file-history-snapshot
            // entries can update file mtime without any actual conversation activity.
            let timestamp = Self.extractTimestamp(from: object)
            if (type == "user" || type == "assistant" || type == "system"),
               timestamp > lastEventAt {
                lastEventAt = timestamp
            }

            switch type {
            case "system":
                let subtype = object["subtype"] as? String ?? ""
                if subtype == "turn_duration" || subtype == "stop_hook_summary" {
                    timestamps.lastTurnEndTs = max(timestamps.lastTurnEndTs, timestamp)
                }

            case "assistant":
                timestamps.lastAssistantAnyTs = max(timestamps.lastAssistantAnyTs, timestamp)

                if let message = object["message"] as? [String: Any],
                   let content = message["content"] as? [[String: Any]],
                   content.contains(where: { $0["type"] as? String == "tool_use" }) {
                    timestamps.lastToolUseTs = max(timestamps.lastToolUseTs, timestamp)
                }

                if let usage = (object["message"] as? [String: Any])?["usage"] as? [String: Any] {
                    let delta = Self.makeClaudeTokenDelta(
                        sessionKey: path,
                        timestamp: timestamp,
                        usage: usage
                    )
                    apply(delta: delta)
                    deltas.append(delta)
                }

            case "user":
                let content = (object["message"] as? [String: Any])?["content"]

                if let contentArray = content as? [[String: Any]],
                   contentArray.contains(where: { $0["type"] as? String == "tool_result" }) {
                    timestamps.lastToolResultTs = max(timestamps.lastToolResultTs, timestamp)
                    continue
                }

                if let contentString = content as? String, contentString.contains("tool_result") {
                    timestamps.lastToolResultTs = max(timestamps.lastToolResultTs, timestamp)
                    continue
                }

                if let contentArray = content as? [[String: Any]] {
                    let hasHumanText = contentArray.contains { block in
                        guard block["type"] as? String == "text",
                              let text = block["text"] as? String,
                              !text.isEmpty
                        else {
                            return false
                        }
                        return !Self.isNonPrompt(text)
                    }
                    if hasHumanText {
                        timestamps.lastHumanMessageTs = max(timestamps.lastHumanMessageTs, timestamp)
                    }
                } else if let contentString = content as? String,
                          !contentString.isEmpty,
                          !Self.isNonPrompt(contentString) {
                    timestamps.lastHumanMessageTs = max(timestamps.lastHumanMessageTs, timestamp)
                }

            default:
                break
            }
        }

        return deltas
    }

    func snapshot() -> SessionLogSnapshot {
        SessionLogSnapshot(
            sessionKey: path,
            logPath: path,
            agentType: .claude,
            sessionId: sessionId,
            cwd: cwd,
            isSubagent: isSubagent,
            lastEventAt: lastEventAt / 1000,
            lastModifiedAt: tailer.lastMtime,
            lastHumanMessageAt: timestamps.lastHumanMessageTs / 1000,
            lastAssistantMessageAt: timestamps.lastAssistantAnyTs / 1000,
            lastTurnCompleteAt: timestamps.lastTurnEndTs / 1000,
            lastToolUseAt: timestamps.lastToolUseTs / 1000,
            lastToolResultAt: timestamps.lastToolResultTs / 1000,
            lastTaskStartedAt: 0,
            lastTaskCompletedAt: 0,
            lastSpeaker: lastSpeaker,
            pendingToolCallCount: timestamps.lastToolUseTs > timestamps.lastToolResultTs ? 1 : 0,
            hasCompletionEvent: timestamps.lastTurnEndTs >= timestamps.lastHumanMessageTs && timestamps.lastHumanMessageTs > 0,
            inputTokens: inputTokens,
            cacheCreationInputTokens: cacheCreationInputTokens,
            cachedInputTokens: cachedInputTokens,
            outputTokens: outputTokens,
            reasoningOutputTokens: reasoningOutputTokens,
            thoughtTokens: thoughtTokens,
            toolTokens: toolTokens,
            totalTokens: totalTokens
        )
    }

    private var lastSpeaker: SessionSpeaker {
        let ordered: [(SessionSpeaker, TimeInterval)] = [
            (.system, timestamps.lastTurnEndTs),
            (.assistant, timestamps.lastAssistantAnyTs),
            (.user, timestamps.lastHumanMessageTs)
        ]

        return ordered.max(by: { $0.1 < $1.1 })?.0 ?? .unknown
    }

    private mutating func apply(delta: TokenDelta) {
        inputTokens += delta.inputTokens
        cacheCreationInputTokens += delta.cacheCreationInputTokens
        cachedInputTokens += delta.cachedInputTokens
        outputTokens += delta.outputTokens
        reasoningOutputTokens += delta.reasoningOutputTokens
        thoughtTokens += delta.thoughtTokens
        toolTokens += delta.toolTokens
        totalTokens += delta.totalTokens
    }

    private static func makeClaudeTokenDelta(sessionKey: String, timestamp: TimeInterval, usage: [String: Any]) -> TokenDelta {
        TokenDelta(
            sessionKey: sessionKey,
            agentType: .claude,
            timestamp: timestamp / 1000,
            inputTokens: intValue(usage["input_tokens"]),
            cacheCreationInputTokens: intValue(usage["cache_creation_input_tokens"]),
            cachedInputTokens: intValue(usage["cache_read_input_tokens"]),
            outputTokens: intValue(usage["output_tokens"]),
            reasoningOutputTokens: 0,
            thoughtTokens: 0,
            toolTokens: 0
        )
    }

    private static func extractTimestamp(from object: [String: Any]) -> TimeInterval {
        if let timestamp = object["timestamp"] as? String {
            return parseISOTimestamp(timestamp)
        }
        if let timestamp = object["timestamp"] as? Double {
            return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000
        }
        if let timestamp = object["timestamp"] as? Int {
            let value = Double(timestamp)
            return value > 1_000_000_000_000 ? value : value * 1000
        }
        return 0
    }

    private static func parseISOTimestamp(_ value: String) -> TimeInterval {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) {
            return date.timeIntervalSince1970 * 1000
        }

        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: value) {
            return date.timeIntervalSince1970 * 1000
        }

        return 0
    }

    private static func intValue(_ raw: Any?) -> Int {
        switch raw {
        case let value as Int:
            return value
        case let value as Double:
            return Int(value)
        case let value as NSNumber:
            return value.intValue
        default:
            return 0
        }
    }

    private static func isNonPrompt(_ value: String) -> Bool {
        value.contains("<local-command-")
            || value.contains("<command-name>")
            || value.contains("[Request interrupted by user]")
    }
}
