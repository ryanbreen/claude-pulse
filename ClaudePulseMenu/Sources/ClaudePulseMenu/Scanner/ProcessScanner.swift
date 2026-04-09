import Foundation

struct ProcessScanner {
    static func scan() -> [ClaudeSession] {
        guard let psOutput = runCommand("/bin/ps", args: ["-eo", "pid,ppid,tty,etime,%cpu,rss,command"]) else {
            return []
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

        var claudePids: Set<Int> = []
        var parsedLines: [(line: String, pid: Int)] = []

        for line in lines {
            guard line.contains("claude"), line.contains("--") else { continue }
            guard !line.contains("/bin/sh"), !line.contains("/bin/zsh"), !line.contains("grep") else { continue }

            guard let parsed = parsePsLine(line) else { continue }
            guard parsed.command.range(of: #"\bclaude\s+--"#, options: .regularExpression) != nil else { continue }

            claudePids.insert(parsed.pid)
            parsedLines.append((line: line, pid: parsed.pid))
        }

        var sessions: [ClaudeSession] = []

        for item in parsedLines {
            guard let parsed = parsePsLine(item.line) else { continue }
            guard parsed.command.range(of: #"\bclaude\s+--"#, options: .regularExpression) != nil else { continue }

            let isSubagent = hasClaudeAncestor(pid: parsed.pid, claudePids: claudePids, pidToPpid: allPidToPpid)
                || parsed.command.contains("--print")

            var flags: [String] = []
            if parsed.command.contains("--continue") || parsed.command.range(of: #"\s-c(\s|$)"#, options: .regularExpression) != nil {
                flags.append("continue")
            }
            if parsed.command.contains("--resume") || parsed.command.range(of: #"\s-r(\s|$)"#, options: .regularExpression) != nil {
                flags.append("resume")
            }

            let sessionId = extractSessionId(from: parsed.command)

            let session = ClaudeSession(
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
                isSubagent: isSubagent,
                turnState: .unknown
            )
            sessions.append(session)
        }

        let pids = sessions.map { $0.pid }
        let cwdMap = batchGetCwd(pids: pids)

        for i in sessions.indices {
            sessions[i].cwd = cwdMap[sessions[i].pid] ?? "unknown"
        }

        for i in sessions.indices {
            guard !sessions[i].isSubagent, sessions[i].cwd != "unknown" else { continue }
            sessions[i].turnState = TurnStateDetector.detect(
                cwd: sessions[i].cwd,
                sessionId: sessions[i].sessionId,
                cpuPercent: sessions[i].cpuPercent
            )
        }

        return sessions.sorted { $0.cpuPercent > $1.cpuPercent }
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

    private static func hasClaudeAncestor(pid: Int, claudePids: Set<Int>, pidToPpid: [Int: Int]) -> Bool {
        var current = pidToPpid[pid]
        for _ in 0..<3 {
            guard let ancestor = current else { break }
            if claudePids.contains(ancestor) { return true }
            current = pidToPpid[ancestor]
        }
        return false
    }

    private static func extractSessionId(from command: String) -> String? {
        let uuidPattern = #"--session-id\s+([a-f0-9-]+)"#
        if let range = command.range(of: uuidPattern, options: .regularExpression) {
            let match = String(command[range])
            let components = match.components(separatedBy: .whitespaces)
            if components.count >= 2 { return components[1] }
        }

        let shortPattern = #"-s\s+([a-f0-9-]+)"#
        if let range = command.range(of: shortPattern, options: .regularExpression) {
            let match = String(command[range])
            let components = match.components(separatedBy: .whitespaces)
            if components.count >= 2 { return components[1] }
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
