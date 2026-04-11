import Foundation

struct CodexLogParser: Sendable {
    private let path: String
    private var tailer: LogTailer

    private var sessionId: String?
    private var cwd = "unknown"
    private var lastEventAt: TimeInterval = 0
    private var lastTaskStartedAt: TimeInterval = 0
    private var lastTaskCompletedAt: TimeInterval = 0
    private var pendingToolCalls: Set<String> = []

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

            let timestamp = Self.extractTimestamp(from: object)
            lastEventAt = max(lastEventAt, timestamp)

            guard let type = object["type"] as? String else { continue }

            switch type {
            case "session_meta":
                if let payload = object["payload"] as? [String: Any] {
                    if let id = payload["id"] as? String, !id.isEmpty {
                        sessionId = id
                    }
                    if let metaCwd = payload["cwd"] as? String, !metaCwd.isEmpty {
                        cwd = metaCwd
                    }
                }

            case "event_msg":
                guard let payload = object["payload"] as? [String: Any],
                      let eventType = payload["type"] as? String
                else {
                    continue
                }

                switch eventType {
                case "task_started":
                    lastTaskStartedAt = max(lastTaskStartedAt, timestamp)
                    if lastTaskStartedAt > lastTaskCompletedAt {
                        pendingToolCalls.removeAll()
                    }

                case "task_complete":
                    lastTaskCompletedAt = max(lastTaskCompletedAt, timestamp)
                    pendingToolCalls.removeAll()

                case "token_count":
                    guard let info = payload["info"] as? [String: Any] else { continue }

                    if let lastTokenUsage = info["last_token_usage"] as? [String: Any] {
                        let delta = Self.makeTokenDelta(sessionKey: path, timestamp: timestamp, usage: lastTokenUsage)
                        apply(delta: delta)
                        deltas.append(delta)
                    }

                    if let totalTokenUsage = info["total_token_usage"] as? [String: Any] {
                        assignTotals(from: totalTokenUsage)
                    }

                default:
                    break
                }

            case "response_item":
                guard let payload = object["payload"] as? [String: Any],
                      let itemType = payload["type"] as? String
                else {
                    continue
                }

                switch itemType {
                case "function_call":
                    if let callID = payload["call_id"] as? String, !callID.isEmpty {
                        pendingToolCalls.insert(callID)
                    }

                case "function_call_output":
                    if let callID = payload["call_id"] as? String, !callID.isEmpty {
                        pendingToolCalls.remove(callID)
                    }

                default:
                    break
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
            agentType: .codex,
            sessionId: sessionId,
            cwd: cwd,
            isSubagent: false,
            lastEventAt: lastEventAt,
            lastModifiedAt: tailer.lastMtime,
            lastHumanMessageAt: 0,
            lastAssistantMessageAt: 0,
            lastTurnCompleteAt: 0,
            lastToolUseAt: 0,
            lastToolResultAt: 0,
            lastTaskStartedAt: lastTaskStartedAt,
            lastTaskCompletedAt: lastTaskCompletedAt,
            lastSpeaker: .assistant,
            pendingToolCallCount: pendingToolCalls.count,
            hasCompletionEvent: lastTaskCompletedAt >= lastTaskStartedAt && lastTaskStartedAt > 0,
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

    private mutating func assignTotals(from usage: [String: Any]) {
        inputTokens = Self.intValue(usage["input_tokens"])
        cacheCreationInputTokens = 0
        cachedInputTokens = Self.intValue(usage["cached_input_tokens"])
        outputTokens = Self.intValue(usage["output_tokens"])
        reasoningOutputTokens = Self.intValue(usage["reasoning_output_tokens"])
        thoughtTokens = 0
        toolTokens = 0
        totalTokens = Self.intValue(usage["total_tokens"])
    }

    private static func makeTokenDelta(sessionKey: String, timestamp: TimeInterval, usage: [String: Any]) -> TokenDelta {
        TokenDelta(
            sessionKey: sessionKey,
            agentType: .codex,
            timestamp: timestamp,
            inputTokens: intValue(usage["input_tokens"]),
            cacheCreationInputTokens: 0,
            cachedInputTokens: intValue(usage["cached_input_tokens"]),
            outputTokens: intValue(usage["output_tokens"]),
            reasoningOutputTokens: intValue(usage["reasoning_output_tokens"]),
            thoughtTokens: 0,
            toolTokens: 0
        )
    }

    private static func extractTimestamp(from object: [String: Any]) -> TimeInterval {
        if let timestamp = object["timestamp"] as? String {
            return parseISOTimestamp(timestamp)
        }
        if let timestamp = object["timestamp"] as? Double {
            return timestamp
        }
        if let timestamp = object["timestamp"] as? Int {
            return Double(timestamp)
        }
        return 0
    }

    private static func parseISOTimestamp(_ value: String) -> TimeInterval {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) {
            return date.timeIntervalSince1970
        }

        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: value) {
            return date.timeIntervalSince1970
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
}
