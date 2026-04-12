import Foundation
import SwiftUI

@Observable
class SessionManager {
    var sessions: [ClaudeSession] = []
    var sessionTrees: [SessionNode] = []
    var busyRootCount: Int = 0
    var totalAgentCount: Int = 0
    var activeCount: Int = 0
    var idleCount: Int = 0
    var stalledCount: Int = 0
    var totalCount: Int = 0
    var subagentCount: Int = 0
    var claudeCount: Int = 0
    var codexCount: Int = 0
    var geminiCount: Int = 0
    var claudeActiveCount: Int = 0
    var codexActiveCount: Int = 0
    var geminiActiveCount: Int = 0
    var totalCpu: Double = 0
    var totalMemMB: Double = 0
    var longestSession: Int = 0
    var globalTokensPerMinute: Double = 0
    var globalInputTokensPerMinute: Double = 0
    var globalOutputTokensPerMinute: Double = 0

    private struct RefreshResult {
        let sessions: [AgentSession]
        let sessionTrees: [SessionNode]
        let busyRootCount: Int
        let totalAgentCount: Int
        let activeCount: Int
        let idleCount: Int
        let stalledCount: Int
        let totalCount: Int
        let subagentCount: Int
        let claudeCount: Int
        let codexCount: Int
        let geminiCount: Int
        let claudeActiveCount: Int
        let codexActiveCount: Int
        let geminiActiveCount: Int
        let totalCpu: Double
        let totalMemMB: Double
        let longestSession: Int
        let globalTokensPerMinute: Double
        let globalInputTokensPerMinute: Double
        let globalOutputTokensPerMinute: Double
    }

    private var timer: Timer?
    private var isRefreshing = false
    private var lastTickStartedAt: TimeInterval?
    private var tokenRateTracker = TokenRateTracker()
    private var claudeDetectors: [String: TurnStateDetector] = [:]
    private var codexParsers: [String: CodexLogParser] = [:]
    private var geminiParsers: [String: GeminiLogParser] = [:]
    private var processStartTimes: [Int: TimeInterval] = [:]

    private struct TimestampedLogCandidate {
        let path: String
        let modifiedAt: TimeInterval
        let startedAt: TimeInterval?
    }

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
        guard !isRefreshing else { return }
        isRefreshing = true

        let now = Date().timeIntervalSince1970
        let since = lastTickStartedAt ?? (now - 120)

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let result = self.performRefresh(since: since, now: now)

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }

                self.sessions = result.sessions
                self.sessionTrees = result.sessionTrees
                self.busyRootCount = result.busyRootCount
                self.totalAgentCount = result.totalAgentCount
                self.activeCount = result.activeCount
                self.idleCount = result.idleCount
                self.stalledCount = result.stalledCount
                self.totalCount = result.totalCount
                self.subagentCount = result.subagentCount
                self.claudeCount = result.claudeCount
                self.codexCount = result.codexCount
                self.geminiCount = result.geminiCount
                self.claudeActiveCount = result.claudeActiveCount
                self.codexActiveCount = result.codexActiveCount
                self.geminiActiveCount = result.geminiActiveCount
                self.totalCpu = result.totalCpu
                self.totalMemMB = result.totalMemMB
                self.longestSession = result.longestSession
                self.globalTokensPerMinute = result.globalTokensPerMinute
                self.globalInputTokensPerMinute = result.globalInputTokensPerMinute
                self.globalOutputTokensPerMinute = result.globalOutputTokensPerMinute
                self.lastTickStartedAt = now
                self.isRefreshing = false
            }
        }
    }

    private func performRefresh(since: TimeInterval, now: TimeInterval) -> RefreshResult {
        let changedClaudeLogs = scanClaudeLogs(changedSince: since)
        let changedCodexLogs = scanCodexLogs(changedSince: since)
        let changedGeminiLogs = scanGeminiLogs(changedSince: since)

        var deltas: [TokenDelta] = []
        deltas.append(contentsOf: updateClaudeDetectors(with: changedClaudeLogs))
        deltas.append(contentsOf: updateCodexParsers(with: changedCodexLogs))
        deltas.append(contentsOf: updateGeminiParsers(with: changedGeminiLogs))

        let scanResult = ProcessScanner.scan()
        let processes = scanResult.sessions
        let parentMap = scanResult.parentMap
        let alivePids = Set(processes.map(\.pid))
        processStartTimes = processStartTimes.filter { alivePids.contains($0.key) }
        bootstrapClaudeProcesses(processes: processes)
        bootstrapCodexProcesses(processes: processes, now: now)
        bootstrapGeminiProcesses(processes: processes, now: now)

        tokenRateTracker.record(deltas, now: now)

        let snapshots = allSnapshots()
        let rawMerged = merge(processes: processes, snapshots: snapshots, now: now)
        pruneParserCaches(aliveProcesses: processes, publishedSessions: rawMerged, now: now)

        let locator = WorkspaceLocator()
        let merged = rawMerged.map { session -> AgentSession in
            var s = session
            s.workspaceID = locator.workspaceID(forPid: s.pid, cwd: s.cwd)
            return s
        }

        let interactive = merged.filter { !isSessionSubagent($0, parentMap: parentMap) }
        let subagents = merged.filter { isSessionSubagent($0, parentMap: parentMap) }
        let recencyCutoff: TimeInterval = 300  // 5 minutes

        // "Active" = had real token traffic in the last 60s, OR turn state is working
        // with recent log activity (catches orchestrator/factory sessions waiting on
        // sub-agents with a pending tool_use but no token traffic of their own).
        let active = interactive.filter { session in
            if (session.inputTokensPerMinute + session.outputTokensPerMinute) > 0 { return true }
            if session.turnState == .working {
                let lastActivity = max(session.lastLogEventAt, session.lastLogMtime)
                return lastActivity > 0 && (now - lastActivity) < recencyCutoff
            }
            return false
        }
        // "Stalled" only counts if the log was recently touched. A session that hasn't moved
        // in hours is dormant, not stalled — the user walked away.
        let stalled = interactive.filter { session in
            guard session.turnState == .stalled else { return false }
            let lastActivity = max(session.lastLogEventAt, session.lastLogMtime)
            return lastActivity > 0 && (now - lastActivity) < recencyCutoff
        }
        let idle = interactive.filter { ($0.inputTokensPerMinute + $0.outputTokensPerMinute) == 0 && $0.turnState != .stalled }

        let totalCpu = merged.reduce(0.0) { $0 + $1.cpuPercent }
        let totalMem = merged.reduce(0.0) { $0 + $1.rssMB }
        let longest = interactive.map { $0.elapsedSeconds }.max() ?? 0
        let claudeSessions = interactive.filter { $0.agentType == .claude }
        let codexSessions = interactive.filter { $0.agentType == .codex }
        let geminiSessions = interactive.filter { $0.agentType == .gemini }

        let sortedInteractive = interactive.sorted { lhs, rhs in
            if lhs.didCrash != rhs.didCrash {
                return lhs.didCrash && !rhs.didCrash
            }
            let lws = lhs.workspaceID ?? Int.max
            let rws = rhs.workspaceID ?? Int.max
            if lws != rws { return lws < rws }
            let lname = (lhs.cwd as NSString).lastPathComponent
            let rname = (rhs.cwd as NSString).lastPathComponent
            if lname != rname { return lname.localizedStandardCompare(rname) == .orderedAscending }
            return lhs.pid < rhs.pid
        }
        let sortedSubagents = subagents.sorted { lhs, rhs in
            let lws = lhs.workspaceID ?? Int.max
            let rws = rhs.workspaceID ?? Int.max
            if lws != rws { return lws < rws }
            let lname = (lhs.cwd as NSString).lastPathComponent
            let rname = (rhs.cwd as NSString).lastPathComponent
            if lname != rname { return lname.localizedStandardCompare(rname) == .orderedAscending }
            return lhs.pid < rhs.pid
        }

        // Build session trees from parentMap
        let trees = buildSessionTrees(allSessions: merged, parentMap: parentMap)
        let busyRoots = trees.filter { $0.session.agentType == .claude && Self.isNodeBusy($0) }.count

        return RefreshResult(
            sessions: sortedInteractive + sortedSubagents,
            sessionTrees: trees,
            busyRootCount: busyRoots,
            totalAgentCount: merged.count,
            activeCount: active.count,
            idleCount: idle.count,
            stalledCount: stalled.count,
            totalCount: interactive.count,
            subagentCount: subagents.count,
            claudeCount: claudeSessions.count,
            codexCount: codexSessions.count,
            geminiCount: geminiSessions.count,
            claudeActiveCount: claudeSessions.filter { $0.isWorking }.count,
            codexActiveCount: codexSessions.filter { $0.isWorking }.count,
            geminiActiveCount: geminiSessions.filter { $0.isWorking }.count,
            totalCpu: totalCpu,
            totalMemMB: totalMem,
            longestSession: longest,
            globalTokensPerMinute: tokenRateTracker.globalTokensPerMinute(now: now),
            globalInputTokensPerMinute: tokenRateTracker.globalInputTokensPerMinute(now: now),
            globalOutputTokensPerMinute: tokenRateTracker.globalOutputTokensPerMinute(now: now)
        )
    }

    private func isSessionSubagent(_ session: AgentSession, parentMap: [Int: Int]) -> Bool {
        if session.pid > 0 {
            return parentMap[session.pid] != nil
        }

        return session.isSubagent
    }

    private func updateClaudeDetectors(with paths: [String]) -> [TokenDelta] {
        var deltas: [TokenDelta] = []

        // Re-read any existing detectors that haven't seen a completion event yet,
        // in case the final turn_duration/stop_hook_summary lines were missed on a tick boundary.
        var pathsToRead = Set(paths)
        for (path, detector) in claudeDetectors where !detector.snapshot().hasCompletionEvent {
            pathsToRead.insert(path)
        }

        for path in pathsToRead {
            var detector = claudeDetectors[path] ?? TurnStateDetector(path: path)
            deltas.append(contentsOf: detector.readUpdates())
            claudeDetectors[path] = detector
        }

        return deltas
    }

    private func updateCodexParsers(with paths: [String]) -> [TokenDelta] {
        var deltas: [TokenDelta] = []

        // Build a combined set: newly-changed paths PLUS any existing parsers that
        // have not yet seen a completion event. The latter ensures we keep re-reading
        // a just-finished rollout even if its mtime fell exactly on a tick boundary
        // and was excluded from the changedSince scan.
        var pathsToRead = Set(paths)
        for (path, parser) in codexParsers where !parser.snapshot().hasCompletionEvent {
            pathsToRead.insert(path)
        }

        for path in pathsToRead {
            var parser = codexParsers[path] ?? CodexLogParser(path: path)
            deltas.append(contentsOf: parser.readUpdates())
            codexParsers[path] = parser
        }

        return deltas
    }

    private func updateGeminiParsers(with paths: [String]) -> [TokenDelta] {
        var deltas: [TokenDelta] = []

        // Re-read any existing parsers that haven't seen a completion event yet,
        // in case the final gemini reply was missed on a tick boundary.
        var pathsToRead = Set(paths)
        for (path, parser) in geminiParsers where !parser.snapshot().hasCompletionEvent {
            pathsToRead.insert(path)
        }

        for path in pathsToRead {
            var parser = geminiParsers[path] ?? GeminiLogParser(path: path)
            deltas.append(contentsOf: parser.readUpdates())
            geminiParsers[path] = parser
        }

        return deltas
    }

    private func allSnapshots() -> [SessionLogSnapshot] {
        var snapshots = claudeDetectors.values.map { $0.snapshot() }
        snapshots.append(contentsOf: codexParsers.values.map { $0.snapshot() })
        snapshots.append(contentsOf: geminiParsers.values.map { $0.snapshot() })
        return snapshots
    }

    private func merge(processes: [AgentSession], snapshots: [SessionLogSnapshot], now: TimeInterval) -> [AgentSession] {
        var remainingProcesses = processes
        var merged: [AgentSession] = []

        for snapshot in snapshots.sorted(by: { $0.lastModifiedAt > $1.lastModifiedAt }) {
            let matchedIndex = bestMatchIndex(for: snapshot, processes: remainingProcesses, now: now)
            let process = matchedIndex.map { remainingProcesses.remove(at: $0) }

            if process != nil || snapshot.shouldPublishWithoutProcess(now: now) {
                merged.append(makeSession(from: snapshot, process: process, now: now))
            }
        }

        for process in remainingProcesses {
            merged.append(processFallbackSession(process, now: now))
        }

        return merged
    }

    private func bestMatchIndex(for snapshot: SessionLogSnapshot, processes: [AgentSession], now: TimeInterval) -> Int? {
        var bestIndex: Int?
        var bestScore = Int.min

        for (index, process) in processes.enumerated() {
            let score = matchScore(snapshot: snapshot, process: process, now: now)
            if score > bestScore {
                bestScore = score
                bestIndex = index
            }
        }

        return bestScore > 0 ? bestIndex : nil
    }

    private func matchScore(snapshot: SessionLogSnapshot, process: AgentSession, now: TimeInterval) -> Int {
        guard snapshot.agentType == process.agentType else { return Int.min }

        if snapshot.cwd != "unknown", process.cwd != "unknown", snapshot.cwd != process.cwd {
            return Int.min
        }

        var score = 0

        if snapshot.cwd == process.cwd {
            score += 30
        }

        if let snapshotSessionId = snapshot.sessionId,
           let processSessionId = process.sessionId,
           snapshotSessionId == processSessionId {
            score += 40
        }

        if snapshot.isSubagent == process.isSubagent {
            score += 10
        }

        if let timedScore = timestampMatchScore(snapshot: snapshot, process: process, now: now) {
            score += timedScore
        }

        return score
    }

    private func makeSession(from snapshot: SessionLogSnapshot, process: AgentSession?, now: TimeInterval) -> AgentSession {
        let isAlive = process != nil
        let resolvedState = snapshot.resolvedTurnState(
            cpuPercent: process?.cpuPercent ?? 0,
            isAlive: isAlive,
            now: now
        )

        let sessionInputTpm = tokenRateTracker.inputTokensPerMinute(for: snapshot.sessionKey, now: now)
        let sessionOutputTpm = tokenRateTracker.outputTokensPerMinute(for: snapshot.sessionKey, now: now)
        let hasRecentTokens = (sessionInputTpm + sessionOutputTpm) > 0

        // A session actively emitting tokens cannot be crashed, regardless of process state.
        let didCrash = snapshot.didCrash(isAlive: isAlive) && !hasRecentTokens
        let effectiveState = didCrash ? .stalled : resolvedState
        let elapsedSeconds = process?.elapsedSeconds ?? max(0, Int(now - snapshot.lastEventAt))

        return AgentSession(
            id: process?.id ?? syntheticID(for: snapshot.sessionKey),
            pid: process?.pid ?? 0,
            ppid: process?.ppid ?? 0,
            tty: process?.tty ?? "-",
            elapsed: process?.elapsed ?? formatDuration(elapsedSeconds),
            elapsedSeconds: elapsedSeconds,
            cpuPercent: process?.cpuPercent ?? 0,
            rssMB: process?.rssMB ?? 0,
            command: process?.command ?? URL(fileURLWithPath: snapshot.logPath).lastPathComponent,
            cwd: snapshot.cwd == "unknown" ? (process?.cwd ?? "unknown") : snapshot.cwd,
            flags: process?.flags ?? [],
            sessionId: snapshot.sessionId ?? process?.sessionId,
            isSubagent: snapshot.isSubagent || (process?.isSubagent ?? false),
            turnState: effectiveState,
            agentType: snapshot.agentType,
            logPath: snapshot.logPath,
            lastLogEventAt: snapshot.lastEventAt,
            lastLogMtime: snapshot.lastModifiedAt,
            didCrash: didCrash,
            hasCompletionEvent: snapshot.hasCompletionEvent,
            inputTokens: snapshot.inputTokens,
            cacheCreationInputTokens: snapshot.cacheCreationInputTokens,
            cachedInputTokens: snapshot.cachedInputTokens,
            outputTokens: snapshot.outputTokens,
            reasoningOutputTokens: snapshot.reasoningOutputTokens,
            thoughtTokens: snapshot.thoughtTokens,
            toolTokens: snapshot.toolTokens,
            totalTokens: snapshot.totalTokens,
            tokensPerMinute: tokenRateTracker.tokensPerMinute(for: snapshot.sessionKey, now: now),
            inputTokensPerMinute: sessionInputTpm,
            outputTokensPerMinute: sessionOutputTpm,
            workspaceID: nil
        )
    }

    private func processFallbackSession(_ process: AgentSession, now: TimeInterval) -> AgentSession {
        var session = process
        session.turnState = process.cpuPercent > activeCpuThreshold ? .working : .unknown
        session.tokensPerMinute = 0
        session.inputTokensPerMinute = 0
        session.outputTokensPerMinute = 0
        // Don't set lastLogEventAt — unmatched sessions have no known log activity.
        // Setting it to `now` would make dormant sessions appear active.
        return session
    }

    private func bootstrapClaudeProcesses(processes: [AgentSession]) {
        for process in processes where process.agentType == .claude && !process.isSubagent {
            guard let path = resolveClaudeLogPath(cwd: process.cwd, sessionId: process.sessionId),
                  claudeDetectors[path] == nil
            else {
                continue
            }

            var detector = TurnStateDetector(path: path)
            _ = detector.readUpdates()
            claudeDetectors[path] = detector
        }
    }

    private func bootstrapCodexProcesses(processes: [AgentSession], now: TimeInterval) {
        for process in processes where process.agentType == .codex {
            guard let path = resolveCodexLogPath(for: process, now: now),
                  codexParsers[path] == nil
            else {
                continue
            }

            var parser = CodexLogParser(path: path)
            _ = parser.readUpdates()
            codexParsers[path] = parser
        }
    }

    private func bootstrapGeminiProcesses(processes: [AgentSession], now: TimeInterval) {
        for process in processes where process.agentType == .gemini {
            guard let path = resolveGeminiLogPath(for: process, now: now),
                  geminiParsers[path] == nil
            else {
                continue
            }

            var parser = GeminiLogParser(path: path)
            _ = parser.readUpdates()
            geminiParsers[path] = parser
        }
    }

    private func pruneParserCaches(aliveProcesses: [AgentSession], publishedSessions: [AgentSession], now: TimeInterval) {
        let liveKeys = Set(aliveProcesses.map { "\($0.agentType.rawValue)|\($0.cwd)|\($0.sessionId ?? "")|\($0.isSubagent)" })
        let publishedLogPaths = Set(publishedSessions.compactMap(\.logPath))

        claudeDetectors = claudeDetectors.filter { path, detector in
            shouldKeep(snapshot: detector.snapshot(), logPath: path, liveKeys: liveKeys, publishedLogPaths: publishedLogPaths, now: now)
        }
        codexParsers = codexParsers.filter { path, parser in
            shouldKeep(snapshot: parser.snapshot(), logPath: path, liveKeys: liveKeys, publishedLogPaths: publishedLogPaths, now: now)
        }
        geminiParsers = geminiParsers.filter { path, parser in
            shouldKeep(snapshot: parser.snapshot(), logPath: path, liveKeys: liveKeys, publishedLogPaths: publishedLogPaths, now: now)
        }
    }

    private func shouldKeep(
        snapshot: SessionLogSnapshot,
        logPath: String,
        liveKeys: Set<String>,
        publishedLogPaths: Set<String>,
        now: TimeInterval
    ) -> Bool {
        if publishedLogPaths.contains(logPath) {
            return true
        }

        let liveKey = "\(snapshot.agentType.rawValue)|\(snapshot.cwd)|\(snapshot.sessionId ?? "")|\(snapshot.isSubagent)"
        if liveKeys.contains(liveKey) {
            return true
        }

        if snapshot.shouldPublishWithoutProcess(now: now) {
            return true
        }

        return now - snapshot.lastModifiedAt < 600
    }

    private func scanClaudeLogs(changedSince since: TimeInterval) -> [String] {
        let basePath = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects").path
        return scanLogs(
            under: basePath,
            changedSince: since,
            shouldInclude: { url in
                url.pathExtension == "jsonl"
            }
        )
    }

    private func scanCodexLogs(changedSince since: TimeInterval) -> [String] {
        let calendar = Calendar.current
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dates = (0..<14).compactMap { offset in
            calendar.date(byAdding: .day, value: -offset, to: Date())
        }

        return dates.flatMap { date -> [String] in
            let components = calendar.dateComponents([.year, .month, .day], from: date)
            guard let year = components.year, let month = components.month, let day = components.day else {
                return []
            }

            let directory = home
                .appendingPathComponent(".codex/sessions")
                .appendingPathComponent(String(format: "%04d", year))
                .appendingPathComponent(String(format: "%02d", month))
                .appendingPathComponent(String(format: "%02d", day))
                .path

            return scanLogs(
                under: directory,
                changedSince: since,
                shouldInclude: { url in
                    url.lastPathComponent.hasPrefix("rollout-") && url.pathExtension == "jsonl"
                }
            )
        }
    }

    private func scanGeminiLogs(changedSince since: TimeInterval) -> [String] {
        let basePath = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".gemini/tmp").path
        return scanLogs(
            under: basePath,
            changedSince: since,
            shouldInclude: { url in
                url.lastPathComponent.hasPrefix("session-")
                    && url.pathExtension == "json"
                    && url.path.contains("/chats/")
            }
        )
    }

    private func scanLogs(
        under path: String,
        changedSince since: TimeInterval,
        shouldInclude: (URL) -> Bool
    ) -> [String] {
        let baseURL = URL(fileURLWithPath: path)
        let resourceKeys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey]

        guard let enumerator = FileManager.default.enumerator(
            at: baseURL,
            includingPropertiesForKeys: resourceKeys,
            options: []
        ) else {
            return []
        }

        var paths: [String] = []

        for case let fileURL as URL in enumerator {
            guard shouldInclude(fileURL),
                  let values = try? fileURL.resourceValues(forKeys: Set(resourceKeys)),
                  values.isRegularFile == true,
                  let modificationDate = values.contentModificationDate,
                  modificationDate.timeIntervalSince1970 > since
            else {
                continue
            }

            paths.append(fileURL.path)
        }

        return paths
    }

    private func resolveClaudeLogPath(cwd: String, sessionId: String?) -> String? {
        guard cwd != "unknown" else { return nil }

        let fm = FileManager.default
        let projectDirName = cwd.replacingOccurrences(of: "/", with: "-")
        let projectPath = fm.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects")
            .appendingPathComponent(projectDirName)
            .path

        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: projectPath, isDirectory: &isDirectory), isDirectory.boolValue else {
            return nil
        }

        guard let sessionId else {
            return nil
        }

        let candidate = URL(fileURLWithPath: projectPath).appendingPathComponent("\(sessionId).jsonl").path
        return fm.fileExists(atPath: candidate) ? candidate : nil
    }

    private func resolveCodexLogPath(for process: AgentSession, now: TimeInterval) -> String? {
        guard process.cwd != "unknown" else { return nil }

        let cutoff = now - (14 * 24 * 60 * 60)
        let candidates = scanCodexLogs(changedSince: cutoff).compactMap { path -> TimestampedLogCandidate? in
            guard codexLogCwd(path: path) == process.cwd else {
                return nil
            }

            return TimestampedLogCandidate(
                path: path,
                modifiedAt: fileMtime(for: path),
                startedAt: codexLogStartTime(path: path)
            )
        }

        if let matched = bestTimestampMatch(for: process, now: now, candidates: candidates) {
            return matched.path
        }

        return candidates.max(by: { $0.modifiedAt < $1.modifiedAt })?.path
    }

    private func resolveGeminiLogPath(for process: AgentSession, now: TimeInterval) -> String? {
        guard process.cwd != "unknown",
              let slug = geminiSlug(for: process.cwd)
        else {
            return nil
        }

        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".gemini/tmp")
            .appendingPathComponent(slug)
            .appendingPathComponent("chats")
            .path

        let candidates = scanLogs(
            under: directory,
            changedSince: now - (24 * 60 * 60),
            shouldInclude: { url in
                url.lastPathComponent.hasPrefix("session-") && url.pathExtension == "json"
            }
        ).map { path in
            TimestampedLogCandidate(
                path: path,
                modifiedAt: fileMtime(for: path),
                startedAt: geminiLogStartTime(path: path)
            )
        }

        if let matched = bestTimestampMatch(for: process, now: now, candidates: candidates) {
            return matched.path
        }

        return candidates.max(by: { $0.modifiedAt < $1.modifiedAt })?.path
    }

    private func codexLogCwd(path: String) -> String? {
        codexLogHeader(path: path)?.cwd
    }

    private func timestampMatchScore(snapshot: SessionLogSnapshot, process: AgentSession, now: TimeInterval) -> Int? {
        guard let processStartedAt = processStartTime(for: process, now: now) else {
            return nil
        }

        let logStartedAt: TimeInterval?
        switch snapshot.agentType {
        case .codex:
            logStartedAt = codexLogStartTime(path: snapshot.logPath)
        case .gemini:
            logStartedAt = geminiLogStartTime(path: snapshot.logPath)
        case .claude:
            logStartedAt = nil
        }

        guard let logStartedAt else {
            return nil
        }

        let delta = processStartedAt - logStartedAt
        let distance = abs(delta)
        guard distance <= 60 else {
            return nil
        }

        // Prefer logs that started just before the process, but accept a small clock-skew window.
        let closeness = Int((60 - distance) * 10)
        return (delta >= 0 ? 1_000 : 900) + closeness
    }

    private func bestTimestampMatch(
        for process: AgentSession,
        now: TimeInterval,
        candidates: [TimestampedLogCandidate]
    ) -> TimestampedLogCandidate? {
        guard let processStartedAt = processStartTime(for: process, now: now) else {
            return nil
        }

        return candidates
            .filter { candidate in
                guard let startedAt = candidate.startedAt else {
                    return false
                }
                return abs(processStartedAt - startedAt) <= 60
            }
            .max { lhs, rhs in
                timestampMatchSortKey(candidate: lhs, processStartedAt: processStartedAt)
                    < timestampMatchSortKey(candidate: rhs, processStartedAt: processStartedAt)
            }
    }

    private func timestampMatchSortKey(candidate: TimestampedLogCandidate, processStartedAt: TimeInterval) -> (Int, TimeInterval, TimeInterval) {
        guard let startedAt = candidate.startedAt else {
            return (Int.min, 0, candidate.modifiedAt)
        }

        let delta = processStartedAt - startedAt
        let directionRank = delta >= 0 ? 1 : 0
        return (directionRank, -abs(delta), startedAt)
    }

    private func codexLogStartTime(path: String) -> TimeInterval? {
        let filename = URL(fileURLWithPath: path).lastPathComponent
        if let rawTimestamp = firstMatch(in: filename, pattern: #"^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-"#),
           let startedAt = parseFilenameTimestamp(rawTimestamp, format: "yyyy-MM-dd'T'HH-mm-ss")
        {
            return startedAt
        }

        if let timestamp = codexLogHeader(path: path)?.timestamp {
            return parseISO8601Timestamp(timestamp)
        }

        return nil
    }

    private func codexLogHeader(path: String) -> (cwd: String?, sessionId: String?, timestamp: String?)? {
        let fileURL = URL(fileURLWithPath: path)
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return nil }
        defer { try? handle.close() }

        guard let data = try? handle.read(upToCount: 32_768),
              let firstLine = String(data: data, encoding: .utf8)?
                .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true)
                .first,
              let jsonData = String(firstLine).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
              let payload = object["payload"] as? [String: Any]
        else {
            return nil
        }

        let sessionId = (payload["session_id"] as? String) ?? (payload["id"] as? String)
        return (payload["cwd"] as? String, sessionId, payload["timestamp"] as? String)
    }

    private func geminiLogStartTime(path: String) -> TimeInterval? {
        let filename = URL(fileURLWithPath: path).lastPathComponent
        guard let rawTimestamp = firstMatch(in: filename, pattern: #"^session-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})"#) else {
            return nil
        }

        return parseFilenameTimestamp(rawTimestamp, format: "yyyy-MM-dd'T'HH-mm")
    }

    private func geminiSlug(for cwd: String) -> String? {
        let fileURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".gemini/projects.json")
        guard let data = try? Data(contentsOf: fileURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let projects = object["projects"] as? [String: String]
        else {
            return nil
        }

        return projects[cwd]
    }

    private func fileMtime(for path: String) -> TimeInterval {
        let fileURL = URL(fileURLWithPath: path)
        let values = try? fileURL.resourceValues(forKeys: [.contentModificationDateKey])
        return values?.contentModificationDate?.timeIntervalSince1970 ?? 0
    }

    private func processStartTime(for process: AgentSession, now: TimeInterval) -> TimeInterval? {
        if let cached = processStartTimes[process.pid] {
            return cached
        }

        if let startedAt = fetchProcessStartTime(pid: process.pid) {
            processStartTimes[process.pid] = startedAt
            return startedAt
        }

        guard process.elapsedSeconds >= 0 else {
            return nil
        }

        let estimatedStart = now - Double(process.elapsedSeconds)
        processStartTimes[process.pid] = estimatedStart
        return estimatedStart
    }

    private func fetchProcessStartTime(pid: Int) -> TimeInterval? {
        guard let output = runCommand("/bin/ps", args: ["-p", String(pid), "-o", "lstart="])?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !output.isEmpty
        else {
            return nil
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "EEE MMM d HH:mm:ss yyyy"
        return formatter.date(from: output)?.timeIntervalSince1970
    }

    private func runCommand(_ executable: String, args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        do {
            try process.run()
        } catch {
            return nil
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }

    private func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return nil
        }

        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              match.numberOfRanges > 1,
              let matchRange = Range(match.range(at: 1), in: text)
        else {
            return nil
        }

        return String(text[matchRange])
    }

    private func parseFilenameTimestamp(_ value: String, format: String) -> TimeInterval? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = format
        return formatter.date(from: value)?.timeIntervalSince1970
    }

    private func parseISO8601Timestamp(_ value: String) -> TimeInterval? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) {
            return date.timeIntervalSince1970
        }

        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)?.timeIntervalSince1970
    }

    private func syntheticID(for key: String) -> Int {
        let raw = key.hashValue
        if raw == Int.min {
            return Int.max
        }
        return abs(raw)
    }

    // MARK: - Session Tree Building

    private func buildSessionTrees(allSessions: [AgentSession], parentMap: [Int: Int]) -> [SessionNode] {
        // Index sessions by PID for fast lookup
        var sessionByPid: [Int: AgentSession] = [:]
        for session in allSessions {
            if session.pid > 0 {
                sessionByPid[session.pid] = session
            }
        }

        // Build child lists: parentPid → [childSession]
        var childrenOf: [Int: [AgentSession]] = [:]
        var childPids: Set<Int> = []

        for (childPid, parentPid) in parentMap {
            // Only include if both parent and child are in our session list
            guard let childSession = sessionByPid[childPid],
                  sessionByPid[parentPid] != nil else { continue }
            childrenOf[parentPid, default: []].append(childSession)
            childPids.insert(childPid)
        }

        // Roots are sessions NOT in childPids
        let roots = allSessions.filter { $0.pid > 0 ? !childPids.contains($0.pid) : true }

        // Recursively build tree nodes
        func buildNode(for session: AgentSession) -> SessionNode {
            let children = (childrenOf[session.pid] ?? [])
                .sorted(by: sessionSort)
                .map { buildNode(for: $0) }
            return SessionNode(session: session, children: children)
        }

        return roots
            .sorted(by: sessionSort)
            .map { buildNode(for: $0) }
    }

    private func sessionSort(_ lhs: AgentSession, _ rhs: AgentSession) -> Bool {
        if lhs.didCrash != rhs.didCrash {
            return lhs.didCrash && !rhs.didCrash
        }

        let lws = lhs.workspaceID ?? Int.max
        let rws = rhs.workspaceID ?? Int.max
        if lws != rws { return lws < rws }

        let lname = (lhs.cwd as NSString).lastPathComponent
        let rname = (rhs.cwd as NSString).lastPathComponent
        if lname != rname { return lname.localizedStandardCompare(rname) == .orderedAscending }

        if lhs.agentType != rhs.agentType {
            return lhs.agentType.rawValue.localizedStandardCompare(rhs.agentType.rawValue) == .orderedAscending
        }

        return lhs.pid < rhs.pid
    }

    static func countDescendants(_ node: SessionNode) -> Int {
        node.children.count + node.children.reduce(0) { $0 + countDescendants($1) }
    }

    static func isNodeBusy(_ node: SessionNode) -> Bool {
        let s = node.session
        if (s.inputTokensPerMinute + s.outputTokensPerMinute) > 0 { return true }
        if s.turnState == .working { return true }
        return node.children.contains { isNodeBusy($0) }
    }
}
