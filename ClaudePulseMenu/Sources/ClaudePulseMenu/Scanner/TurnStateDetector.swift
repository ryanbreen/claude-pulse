import Foundation

struct TurnStateDetector {

    // MARK: - Cache

    private struct TurnTimestamps {
        var lastHumanMessageTs: Double = 0
        var lastAssistantAnyTs: Double = 0
        var lastTurnEndTs: Double = 0
        var lastToolUseTs: Double = 0
        var lastToolResultTs: Double = 0
    }

    struct CacheEntry {
        let mtimeMs: TimeInterval
        let state: TurnState
    }

    // Keyed by JSONL path — mtime-gated to skip re-parse when file is unchanged.
    // Wrapped in a class so we can mutate from a static function without Sendable complaints.
    private final class Cache: @unchecked Sendable {
        var entries: [String: CacheEntry] = [:]
        let maxSize = 100
    }

    private static let cache = Cache()

    // MARK: - Public entry point

    static func detect(cwd: String, sessionId: String?, cpuPercent: Double) -> TurnState {
        let fm = FileManager.default

        guard let homeDir = fm.homeDirectoryForCurrentUser.path.nilIfEmpty else {
            return .unknown
        }

        // Encode cwd: replace / with - (this already gives a leading -)
        let projectDirName = cwd.replacingOccurrences(of: "/", with: "-")
        let projectPath = "\(homeDir)/.claude/projects/\(projectDirName)"

        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: projectPath, isDirectory: &isDir), isDir.boolValue else {
            return .unknown
        }

        guard let jsonlPath = resolveJsonlPath(in: projectPath, sessionId: sessionId, fm: fm) else {
            return .unknown
        }

        do {
            let attrs = try fm.attributesOfItem(atPath: jsonlPath)
            let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            let mtimeMs = mtime * 1000

            if let hit = cache.entries[jsonlPath], hit.mtimeMs == mtimeMs {
                return hit.state
            }

            let fileSize = (attrs[.size] as? Int) ?? 0
            let timestamps = try parseTurnTimestamps(path: jsonlPath, fileSize: fileSize)
            let state = deriveTurnState(timestamps, cpuPercent: cpuPercent)

            cache.entries[jsonlPath] = CacheEntry(mtimeMs: mtimeMs, state: state)

            // Evict oldest entry if over limit
            if cache.entries.count > cache.maxSize {
                if let firstKey = cache.entries.keys.first {
                    cache.entries.removeValue(forKey: firstKey)
                }
            }

            return state
        } catch {
            return .unknown
        }
    }

    // MARK: - Path resolution

    private static func resolveJsonlPath(in projectPath: String, sessionId: String?, fm: FileManager) -> String? {
        if let sid = sessionId {
            let candidate = "\(projectPath)/\(sid).jsonl"
            if fm.fileExists(atPath: candidate) {
                return candidate
            }
        }

        // Fall back to most recently modified .jsonl that isn't an agent session
        guard let entries = try? fm.contentsOfDirectory(atPath: projectPath) else {
            return nil
        }

        let jsonlFiles = entries.filter { $0.hasSuffix(".jsonl") && !$0.hasPrefix("agent-") }
        if jsonlFiles.isEmpty { return nil }

        let withMtimes: [(path: String, mtime: TimeInterval)] = jsonlFiles.compactMap { name in
            let full = "\(projectPath)/\(name)"
            guard let attrs = try? fm.attributesOfItem(atPath: full),
                  let date = attrs[.modificationDate] as? Date else { return nil }
            return (full, date.timeIntervalSince1970)
        }

        return withMtimes.max(by: { $0.mtime < $1.mtime })?.path
    }

    // MARK: - JSONL parsing

    private static func parseTurnTimestamps(path: String, fileSize: Int) throws -> TurnTimestamps {
        guard let fh = FileHandle(forReadingAtPath: path) else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        defer { try? fh.close() }

        let readSize = min(fileSize, 131_072)
        let offset = max(0, fileSize - readSize)

        try fh.seek(toOffset: UInt64(offset))
        let data = fh.readDataToEndOfFile()

        guard let tail = String(data: data, encoding: .utf8) else {
            return TurnTimestamps()
        }

        var ts = TurnTimestamps()

        for line in tail.split(separator: "\n", omittingEmptySubsequences: true) {
            let lineStr = String(line)
            if lineStr.trimmingCharacters(in: .whitespaces).isEmpty { continue }

            if lineStr.utf8.count > 4096 {
                // Lightweight regex path for large lines — skip heavy parse
                processLargeLine(lineStr, into: &ts)
                continue
            }

            guard let lineData = lineStr.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
            else { continue }

            let timestamp = extractTimestamp(from: obj)
            guard let type = obj["type"] as? String else { continue }

            switch type {
            case "system":
                let sub = obj["subtype"] as? String ?? ""
                if sub == "turn_duration" || sub == "stop_hook_summary" {
                    if timestamp > ts.lastTurnEndTs { ts.lastTurnEndTs = timestamp }
                }

            case "assistant":
                if timestamp > ts.lastAssistantAnyTs { ts.lastAssistantAnyTs = timestamp }
                if let content = (obj["message"] as? [String: Any])?["content"] as? [[String: Any]] {
                    if content.contains(where: { $0["type"] as? String == "tool_use" }) {
                        if timestamp > ts.lastToolUseTs { ts.lastToolUseTs = timestamp }
                    }
                }

            case "user":
                let content = (obj["message"] as? [String: Any])?["content"]

                // Tool result check
                if let contentArray = content as? [[String: Any]] {
                    if contentArray.contains(where: { $0["type"] as? String == "tool_result" }) {
                        if timestamp > ts.lastToolResultTs { ts.lastToolResultTs = timestamp }
                        continue
                    }
                }
                if let contentStr = content as? String, contentStr.contains("tool_result") {
                    if timestamp > ts.lastToolResultTs { ts.lastToolResultTs = timestamp }
                    continue
                }

                // Human message check (exclude injected system noise)
                if let contentArray = content as? [[String: Any]] {
                    let hasHumanText = contentArray.contains { block in
                        guard block["type"] as? String == "text",
                              let text = block["text"] as? String,
                              !text.isEmpty
                        else { return false }
                        return !isNonPrompt(text)
                    }
                    if hasHumanText, timestamp > ts.lastHumanMessageTs {
                        ts.lastHumanMessageTs = timestamp
                    }
                } else if let contentStr = content as? String, !contentStr.isEmpty {
                    if !isNonPrompt(contentStr), timestamp > ts.lastHumanMessageTs {
                        ts.lastHumanMessageTs = timestamp
                    }
                }

            default:
                break
            }
        }

        return ts
    }

    // MARK: - Large-line fast path

    private static func processLargeLine(_ line: String, into ts: inout TurnTimestamps) {
        // Extract type and timestamp with lightweight string searches
        guard let typeRange = line.range(of: #"^\{"type":"(\w+)""#, options: .regularExpression) else {
            return
        }
        _ = typeRange  // used to confirm match exists

        // Pull type value
        guard let typeStart = line.range(of: "\"type\":\"")?.upperBound else { return }
        guard let typeEnd = line[typeStart...].firstIndex(of: "\"") else { return }
        let type = String(line[typeStart ..< typeEnd])

        // Pull timestamp value
        let timestamp: Double
        if let tsKeyRange = line.range(of: "\"timestamp\":\"") {
            let valStart = tsKeyRange.upperBound
            if let valEnd = line[valStart...].firstIndex(of: "\"") {
                let tsStr = String(line[valStart ..< valEnd])
                timestamp = parseISOTimestamp(tsStr)
            } else {
                timestamp = 0
            }
        } else {
            timestamp = 0
        }

        switch type {
        case "system":
            // Still parse fully — system entries are small in practice, but guard with try?
            if let data = line.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let sub = obj["subtype"] as? String ?? ""
                if sub == "turn_duration" || sub == "stop_hook_summary" {
                    if timestamp > ts.lastTurnEndTs { ts.lastTurnEndTs = timestamp }
                }
            }

        case "assistant":
            if timestamp > ts.lastAssistantAnyTs { ts.lastAssistantAnyTs = timestamp }
            if line.contains("\"tool_use\""), timestamp > ts.lastToolUseTs {
                ts.lastToolUseTs = timestamp
            }

        case "user":
            if line.contains("tool_result") {
                if timestamp > ts.lastToolResultTs { ts.lastToolResultTs = timestamp }
            } else if !line.contains("<local-command-") && !line.contains("[Request interrupted by user]") {
                if timestamp > ts.lastHumanMessageTs { ts.lastHumanMessageTs = timestamp }
            }

        default:
            break
        }
    }

    // MARK: - State derivation

    private static func deriveTurnState(_ e: TurnTimestamps, cpuPercent: Double) -> TurnState {
        if e.lastHumanMessageTs == 0 && e.lastTurnEndTs == 0 { return .unknown }

        // Turn completed normally
        if e.lastTurnEndTs >= e.lastHumanMessageTs { return .idle }

        // Tool is in-flight (sent but no result yet, and sent after last turn end)
        if e.lastToolUseTs > e.lastToolResultTs && e.lastToolUseTs > e.lastTurnEndTs {
            return .working
        }

        let processIdle = cpuPercent < activeCpuThreshold
        let now = Date().timeIntervalSince1970 * 1000  // ms

        // Claude responded but no turn_duration for >30s at low CPU → probably done
        if e.lastAssistantAnyTs > e.lastHumanMessageTs,
           now - e.lastAssistantAnyTs > 30_000,
           processIdle {
            return .idle
        }

        // No assistant response after human message for >30s at low CPU → stalled
        if e.lastAssistantAnyTs <= e.lastHumanMessageTs,
           now - e.lastHumanMessageTs > 30_000,
           processIdle {
            return .stalled
        }

        return .working
    }

    // MARK: - Helpers

    private static func extractTimestamp(from obj: [String: Any]) -> Double {
        if let ts = obj["timestamp"] as? String {
            return parseISOTimestamp(ts)
        }
        if let ts = obj["timestamp"] as? Double {
            // Could be seconds or milliseconds; values > 1e12 are already ms
            return ts > 1_000_000_000_000 ? ts : ts * 1000
        }
        if let ts = obj["timestamp"] as? Int {
            let d = Double(ts)
            return d > 1_000_000_000_000 ? d : d * 1000
        }
        return 0
    }

    private static func parseISOTimestamp(_ s: String) -> Double {
        // Fast path: ISO 8601 with fractional seconds or Z suffix
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: s) {
            return date.timeIntervalSince1970 * 1000
        }
        // Fallback without fractional seconds
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: s) {
            return date.timeIntervalSince1970 * 1000
        }
        return 0
    }

    private static func isNonPrompt(_ s: String) -> Bool {
        s.contains("<local-command-") ||
        s.contains("<command-name>") ||
        s.contains("[Request interrupted by user]")
    }
}

// MARK: - String helper

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
