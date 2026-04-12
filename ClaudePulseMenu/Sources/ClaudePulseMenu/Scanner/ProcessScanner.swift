import Foundation

struct ProcessScanner {
    private static let maxAncestorWalkDepth = 10

    static func scan() -> ScanResult {
        guard let psOutput = runCommand("/bin/ps", args: ["-eo", "pid,ppid,tty,etime,%cpu,rss,command"]) else {
            return ScanResult(sessions: [], parentMap: [:])
        }

        let lines = psOutput.components(separatedBy: "\n")

        var allPidToPpid: [Int: Int] = [:]
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let parts = trimmed.components(separatedBy: .whitespaces)
            if parts.count >= 2, let pid = Int(parts[0]), let ppid = Int(parts[1]) {
                allPidToPpid[pid] = ppid
            }
        }

        var agentPids: Set<Int> = []
        var parsedEntries: [(line: String, pid: Int, agentType: AgentType)] = []

        for line in lines {
            guard let parsed = parsePsLine(line) else { continue }

            if let agentType = classifyAgent(command: parsed.command) {
                agentPids.insert(parsed.pid)
                parsedEntries.append((line: line, pid: parsed.pid, agentType: agentType))
            }
        }

        var sessions: [AgentSession] = []
        var parentMap: [Int: Int] = [:]

        for entry in parsedEntries {
            if let parentPid = findAgentAncestor(
                pid: entry.pid,
                agentPids: agentPids,
                pidToPpid: allPidToPpid,
                maxDepth: maxAncestorWalkDepth
            ) {
                parentMap[entry.pid] = parentPid
            }
        }

        for entry in parsedEntries {
            guard let parsed = parsePsLine(entry.line) else { continue }

            var flags: [String] = []
            if entry.agentType == .claude {
                if parsed.command.contains("--continue") || parsed.command.range(of: #"\s-c(\s|$)"#, options: .regularExpression) != nil {
                    flags.append("continue")
                }
                if parsed.command.contains("--resume") || parsed.command.range(of: #"\s-r(\s|$)"#, options: .regularExpression) != nil {
                    flags.append("resume")
                }
            }
            if entry.agentType == .codex {
                if parsed.command.contains("--full-auto") { flags.append("full-auto") }
                if parsed.command.contains(" exec ") { flags.append("exec") }
            }

            let sessionId = entry.agentType == .claude ? extractSessionId(from: parsed.command) : nil

            let session = AgentSession(
                id: parsed.pid,
                pid: parsed.pid,
                ppid: parsed.ppid,
                tty: parsed.tty,
                elapsed: parsed.elapsed,
                elapsedSeconds: parseElapsedTime(parsed.elapsed),
                cpuPercent: parsed.cpuPercent,
                rssMB: Double(parsed.rssKB) / 1024.0,
                command: parsed.command,
                cwd: "unknown",
                flags: flags,
                sessionId: sessionId,
                isSubagent: parentMap[parsed.pid] != nil,
                turnState: .unknown,
                agentType: entry.agentType,
                logPath: nil,
                lastLogEventAt: 0,
                lastLogMtime: 0,
                didCrash: false,
                hasCompletionEvent: false,
                inputTokens: 0,
                cacheCreationInputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0,
                thoughtTokens: 0,
                toolTokens: 0,
                totalTokens: 0,
                tokensPerMinute: 0,
                inputTokensPerMinute: 0,
                outputTokensPerMinute: 0,
                workspaceID: nil
            )
            sessions.append(session)
        }

        let pids = sessions.map { $0.pid }
        let cwdMap = batchGetCwd(pids: pids)

        for i in sessions.indices {
            sessions[i].cwd = cwdMap[sessions[i].pid] ?? "unknown"
        }

        return ScanResult(
            sessions: sessions.sorted { $0.cpuPercent > $1.cpuPercent },
            parentMap: parentMap
        )
    }

    // MARK: - Private helpers

    private struct ParsedPsLine {
        let pid: Int
        let ppid: Int
        let tty: String
        let elapsed: String
        let cpuPercent: Double
        let rssKB: Int
        let command: String
    }

    private static func parsePsLine(_ line: String) -> ParsedPsLine? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        // Split on whitespace but preserve command (everything from col 7 onward)
        let parts = trimmed.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
        guard parts.count >= 7 else { return nil }

        guard let pid = Int(parts[0]),
              let ppid = Int(parts[1]) else { return nil }

        let tty = parts[2]
        let elapsed = parts[3]

        guard let cpu = Double(parts[4]),
              let rss = Int(parts[5]) else { return nil }

        let command = parts[6...].joined(separator: " ")

        return ParsedPsLine(
            pid: pid,
            ppid: ppid,
            tty: tty,
            elapsed: elapsed,
            cpuPercent: cpu,
            rssKB: rss,
            command: command
        )
    }

    private static func classifyAgent(command: String) -> AgentType? {
        if command.contains("/bin/sh") || command.contains("/bin/zsh") || command.contains("grep") {
            return nil
        }

        if command.range(of: #"\bclaude\s+--"#, options: .regularExpression) != nil {
            return .claude
        }

        // Codex: match `codex` as an executable token or a node-wrapped `/codex/` path.
        if command.range(of: #"\bcodex(\s|$)"#, options: .regularExpression) != nil ||
           command.range(of: #"/codex/"#, options: .regularExpression) != nil {
            return .codex
        }

        if command.range(of: #"\bgemini\b"#, options: .regularExpression) != nil {
            return .gemini
        }

        return nil
    }

    private static func findAgentAncestor(
        pid: Int,
        agentPids: Set<Int>,
        pidToPpid: [Int: Int],
        maxDepth: Int
    ) -> Int? {
        var current = pidToPpid[pid]
        for _ in 0..<maxDepth {
            guard let ancestor = current else { break }
            if agentPids.contains(ancestor) { return ancestor }
            current = pidToPpid[ancestor]
        }
        return nil
    }

    private static func extractSessionId(from command: String) -> String? {
        // Match --session-id UUID, --resume UUID, -s UUID, -r UUID
        for pattern in [
            #"--session-id\s+([a-f0-9-]+)"#,
            #"--resume\s+([a-f0-9-]+)"#,
            #"\s-s\s+([a-f0-9-]+)"#,
            #"\s-r\s+([a-f0-9-]+)"#
        ] {
            if let range = command.range(of: pattern, options: .regularExpression) {
                let match = String(command[range])
                let components = match.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
                if components.count >= 2 { return components.last }
            }
        }

        return nil
    }

    private static func batchGetCwd(pids: [Int]) -> [Int: String] {
        var result: [Int: String] = [:]
        guard !pids.isEmpty else { return result }

        let pidList = pids.map { String($0) }.joined(separator: ",")
        guard let output = runCommand("/usr/sbin/lsof", args: ["-a", "-d", "cwd", "-p", pidList, "-F", "pn"]) else {
            return result
        }

        var currentPid: Int? = nil
        for line in output.components(separatedBy: "\n") {
            if line.hasPrefix("p") {
                currentPid = Int(line.dropFirst())
            } else if line.hasPrefix("n"), let pid = currentPid {
                result[pid] = String(line.dropFirst())
            }
        }

        return result
    }

    private static func runCommand(_ executable: String, args: [String]) -> String? {
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
}
