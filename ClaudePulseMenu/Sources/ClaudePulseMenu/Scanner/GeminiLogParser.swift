import Foundation
import CryptoKit

struct GeminiLogParser: Sendable {
    private final class ProjectCache: @unchecked Sendable {
        var mtime: TimeInterval = 0
        var slugToCwd: [String: String] = [:]
        var hashToCwd: [String: String] = [:]
    }

    private static let projectCache = ProjectCache()

    private let path: String
    private let projectKey: String

    private var sessionId: String?
    private var cwd = "unknown"
    private var lastUpdated = ""
    private var lastEventAt: TimeInterval = 0
    private var lastMessageCount = 0
    private var lastModifiedAt: TimeInterval = 0
    private var lastSpeaker: SessionSpeaker = .unknown
    private var lastHumanMessageAt: TimeInterval = 0
    private var lastGeminiMessageAt: TimeInterval = 0

    private var inputTokens = 0
    private var cacheCreationInputTokens = 0
    private var cachedInputTokens = 0
    private var outputTokens = 0
    private var reasoningOutputTokens = 0
    private var thoughtTokens = 0
    private var toolTokens = 0
    private var totalTokens = 0

    init(path: String) {
        let resolvedPath = Self.resolveSessionPath(from: path)
        self.path = resolvedPath
        self.projectKey = Self.projectKey(for: resolvedPath)
        self.cwd = Self.cwd(for: projectKey)
    }

    mutating func readUpdates() -> [TokenDelta] {
        let fileURL = URL(fileURLWithPath: path)
        guard let values = try? fileURL.resourceValues(forKeys: [.contentModificationDateKey]),
              let modificationDate = values.contentModificationDate
        else {
            return []
        }

        let mtime = modificationDate.timeIntervalSince1970
        guard mtime != lastModifiedAt else { return [] }

        guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else {
            return []
        }

        let updatedValue = Self.extractLastUpdated(from: text)
        lastModifiedAt = mtime
        if updatedValue == lastUpdated, lastMessageCount > 0 {
            return []
        }

        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return []
        }

        if let id = object["sessionId"] as? String, !id.isEmpty {
            sessionId = id
        }

        if cwd == "unknown" {
            cwd = Self.cwd(for: projectKey)
        }

        guard let messages = object["messages"] as? [[String: Any]] else {
            lastUpdated = updatedValue
            return []
        }

        if messages.count < lastMessageCount {
            resetState()
        }

        let startIndex = min(lastMessageCount, messages.count)
        var deltas: [TokenDelta] = []

        for message in messages[startIndex...] {
            let timestamp = Self.extractTimestamp(from: message["timestamp"])
            lastEventAt = max(lastEventAt, timestamp)

            let messageType = message["type"] as? String ?? ""
            switch messageType {
            case "user":
                lastSpeaker = .user
                lastHumanMessageAt = max(lastHumanMessageAt, timestamp)

            case "gemini":
                lastSpeaker = .gemini
                lastGeminiMessageAt = max(lastGeminiMessageAt, timestamp)

                if let tokens = message["tokens"] as? [String: Any] {
                    let delta = Self.makeTokenDelta(sessionKey: path, timestamp: timestamp, usage: tokens)
                    apply(delta: delta)
                    deltas.append(delta)
                }

            default:
                lastSpeaker = .unknown
            }
        }

        lastMessageCount = messages.count
        lastUpdated = (object["lastUpdated"] as? String) ?? updatedValue
        return deltas
    }

    func snapshot() -> SessionLogSnapshot {
        SessionLogSnapshot(
            sessionKey: path,
            logPath: path,
            agentType: .gemini,
            sessionId: sessionId,
            cwd: cwd,
            isSubagent: false,
            lastEventAt: lastEventAt,
            lastModifiedAt: lastModifiedAt,
            lastHumanMessageAt: lastHumanMessageAt,
            lastAssistantMessageAt: lastGeminiMessageAt,
            lastTurnCompleteAt: 0,
            lastToolUseAt: 0,
            lastToolResultAt: 0,
            lastTaskStartedAt: 0,
            lastTaskCompletedAt: 0,
            lastSpeaker: lastSpeaker,
            pendingToolCallCount: 0,
            hasCompletionEvent: lastSpeaker == .gemini,
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

    private mutating func resetState() {
        lastUpdated = ""
        lastEventAt = 0
        lastMessageCount = 0
        lastSpeaker = .unknown
        lastHumanMessageAt = 0
        lastGeminiMessageAt = 0
        inputTokens = 0
        cacheCreationInputTokens = 0
        cachedInputTokens = 0
        outputTokens = 0
        reasoningOutputTokens = 0
        thoughtTokens = 0
        toolTokens = 0
        totalTokens = 0
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

    private static func makeTokenDelta(sessionKey: String, timestamp: TimeInterval, usage: [String: Any]) -> TokenDelta {
        TokenDelta(
            sessionKey: sessionKey,
            agentType: .gemini,
            timestamp: timestamp,
            inputTokens: intValue(usage["input"]),
            cacheCreationInputTokens: 0,
            cachedInputTokens: intValue(usage["cached"]),
            outputTokens: intValue(usage["output"]),
            reasoningOutputTokens: 0,
            thoughtTokens: intValue(usage["thoughts"]),
            toolTokens: intValue(usage["tool"])
        )
    }

    private static func resolveSessionPath(from path: String) -> String {
        let fileURL = URL(fileURLWithPath: path)
        if isSessionFile(fileURL) {
            return fileURL.path
        }

        var isDirectory: ObjCBool = false
        let pathExists = FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory)
        let baseDirectory = pathExists && isDirectory.boolValue
            ? fileURL
            : fileURL.deletingLastPathComponent()

        if fileURL.lastPathComponent == "logs.json" {
            let chatsDirectory = baseDirectory.appendingPathComponent("chats", isDirectory: true)
            if let sessionPath = latestSessionPath(in: chatsDirectory) {
                return sessionPath
            }
        }

        if baseDirectory.lastPathComponent == "chats",
           let sessionPath = latestSessionPath(in: baseDirectory) {
            return sessionPath
        }

        let chatsDirectory = baseDirectory.appendingPathComponent("chats", isDirectory: true)
        if let sessionPath = latestSessionPath(in: chatsDirectory) {
            return sessionPath
        }

        return fileURL.path
    }

    private static func projectKey(for path: String) -> String {
        let fileURL = URL(fileURLWithPath: path)
        if isSessionFile(fileURL) {
            return fileURL
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .lastPathComponent
        }

        if fileURL.lastPathComponent == "logs.json" {
            return fileURL.deletingLastPathComponent().lastPathComponent
        }

        if fileURL.lastPathComponent == "chats" {
            return fileURL.deletingLastPathComponent().lastPathComponent
        }

        return fileURL.deletingLastPathComponent().lastPathComponent
    }

    private static func latestSessionPath(in directory: URL) -> String? {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }

        return entries
            .filter(isSessionFile)
            .max { lhs, rhs in
                fileMtime(for: lhs) < fileMtime(for: rhs)
            }?
            .path
    }

    private static func isSessionFile(_ url: URL) -> Bool {
        url.lastPathComponent.hasPrefix("session-") && url.pathExtension == "json"
    }

    private static func fileMtime(for url: URL) -> TimeInterval {
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        return values?.contentModificationDate?.timeIntervalSince1970 ?? 0
    }

    private static func cwd(for projectKey: String) -> String {
        let fm = FileManager.default
        let path = fm.homeDirectoryForCurrentUser.appendingPathComponent(".gemini/projects.json").path
        let fileURL = URL(fileURLWithPath: path)

        guard let values = try? fileURL.resourceValues(forKeys: [.contentModificationDateKey]),
              let modificationDate = values.contentModificationDate
        else {
            return "unknown"
        }

        let mtime = modificationDate.timeIntervalSince1970
        if mtime != projectCache.mtime {
            projectCache.mtime = mtime
            let maps = loadProjectMap(from: fileURL)
            projectCache.slugToCwd = maps.slugToCwd
            projectCache.hashToCwd = maps.hashToCwd
        }

        if let cwd = projectCache.slugToCwd[projectKey] {
            return cwd
        }

        if let cwd = projectCache.hashToCwd[projectKey] {
            return cwd
        }

        return "unknown"
    }

    private static func loadProjectMap(from fileURL: URL) -> (slugToCwd: [String: String], hashToCwd: [String: String]) {
        guard let data = try? Data(contentsOf: fileURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let projects = object["projects"] as? [String: String]
        else {
            return ([:], [:])
        }

        let slugToCwd = Dictionary(uniqueKeysWithValues: projects.map { ($0.value, $0.key) })
        let hashToCwd = Dictionary(uniqueKeysWithValues: projects.keys.map { (sha256($0), $0) })
        return (slugToCwd, hashToCwd)
    }

    private static func sha256(_ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func extractLastUpdated(from text: String) -> String {
        guard let keyRange = text.range(of: "\"lastUpdated\"") else {
            return ""
        }

        let remainder = text[keyRange.upperBound...]
        guard let firstQuote = remainder.firstIndex(of: "\"") else {
            return ""
        }

        let afterQuote = remainder.index(after: firstQuote)
        guard let secondQuote = remainder[afterQuote...].firstIndex(of: "\"") else {
            return ""
        }

        return String(remainder[afterQuote..<secondQuote])
    }

    private static func extractTimestamp(from raw: Any?) -> TimeInterval {
        guard let value = raw as? String else { return 0 }

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
