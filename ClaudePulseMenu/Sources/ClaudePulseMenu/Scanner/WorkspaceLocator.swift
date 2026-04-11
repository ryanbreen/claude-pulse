import Foundation

struct WorkspaceLocator {
    // pid -> (ppid, command)
    private let processTree: [Int: (ppid: Int, command: String)]
    private let ghosttySurfaces: [GhosttySurface]
    // window title (lowercased) -> yabai space
    private let titleToSpace: [String: Int]
    // ghostty app pid(s) — used to confirm we're under a Ghostty
    private let ghosttyPids: Set<Int>

    init() {
        self.processTree = WorkspaceLocator.buildProcessTree()
        self.ghosttySurfaces = GhosttyIntrospector.surfaces()
        let (titles, pids) = WorkspaceLocator.buildYabaiMaps()
        self.titleToSpace = titles
        self.ghosttyPids = pids
    }

    func workspaceID(forPid pid: Int, cwd: String) -> Int? {
        guard pid > 0 else { return nil }

        if !ghosttySurfaces.isEmpty {
            return workspaceIDFromGhosttySurfaces(forPid: pid)
        }

        return workspaceIDFromYabaiTitles(forPid: pid, cwd: cwd)
    }

    private func workspaceIDFromGhosttySurfaces(forPid pid: Int) -> Int? {
        var current = pid
        for _ in 0..<20 {
            if let surface = ghosttySurfaces.first(where: { $0.shellPid == current }) {
                return stableWorkspaceID(for: surface)
            }

            guard let entry = processTree[current] else { break }
            let parent = entry.ppid
            if parent <= 1 || parent == current { break }
            current = parent
        }

        return nil
    }

    private func workspaceIDFromYabaiTitles(forPid pid: Int, cwd: String) -> Int? {
        var current = pid
        var underGhostty = false
        for _ in 0..<20 {
            guard let entry = processTree[current] else { break }
            if entry.command.lowercased().contains("ghostty") || ghosttyPids.contains(current) {
                underGhostty = true
                break
            }
            let parent = entry.ppid
            if parent <= 1 || parent == current { break }
            current = parent
        }

        guard underGhostty else { return nil }

        let basename = (cwd as NSString).lastPathComponent.lowercased()
        if basename.isEmpty { return nil }

        // When Ghostty IPC is unavailable, yabai title matching is only a best-effort
        // fallback. Prefer nil over guessing if more than one title looks plausible.
        if let exactMatch = titleToSpace[basename] {
            return exactMatch
        }

        let substringMatches = titleToSpace.compactMap { title, space -> Int? in
            let hasMeaningfulLength = max(basename.count, title.count) >= 4
            guard hasMeaningfulLength,
                  title.contains(basename) || basename.contains(title)
            else {
                return nil
            }
            return space
        }
        if !substringMatches.isEmpty {
            return substringMatches.count == 1 ? substringMatches[0] : nil
        }

        let normalizedBasename = WorkspaceLocator.normalizedYabaiTitle(basename)
        let normalizedMatches = titleToSpace.compactMap { title, space -> Int? in
            WorkspaceLocator.normalizedYabaiTitle(title) == normalizedBasename ? space : nil
        }
        if !normalizedMatches.isEmpty {
            return normalizedMatches.count == 1 ? normalizedMatches[0] : nil
        }

        return nil
    }

    private func stableWorkspaceID(for surface: GhosttySurface) -> Int {
        // Pack the window id into the high bits and the tab index into the low bits
        // so the identifier stays stable and collision-free for any realistic counts.
        Int((UInt64(UInt32(surface.windowId)) << 16) | (UInt64(UInt32(surface.tabIndex)) & 0xFFFF))
    }

    // MARK: - Private builders

    private static func buildProcessTree() -> [Int: (ppid: Int, command: String)] {
        guard let output = runCommand("/bin/ps", args: ["-eo", "pid,ppid,command"]) else {
            return [:]
        }
        var tree: [Int: (ppid: Int, command: String)] = [:]
        for line in output.components(separatedBy: "\n") {
            let parts = line.trimmingCharacters(in: .whitespaces)
                .components(separatedBy: .whitespaces)
                .filter { !$0.isEmpty }
            guard parts.count >= 3,
                  let pid = Int(parts[0]),
                  let ppid = Int(parts[1])
            else { continue }
            let command = parts[2...].joined(separator: " ")
            tree[pid] = (ppid: ppid, command: command)
        }
        return tree
    }

    private static func buildYabaiMaps() -> (titleToSpace: [String: Int], ghosttyPids: Set<Int>) {
        guard let output = runCommand("/opt/homebrew/bin/yabai", args: ["-m", "query", "--windows"]) else {
            return ([:], [])
        }
        guard let data = output.data(using: .utf8),
              let windows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else {
            return ([:], [])
        }
        var titleMap: [String: Int] = [:]
        var ambiguousTitles = Set<String>()
        var pids = Set<Int>()
        for window in windows {
            let app = (window["app"] as? String ?? "").lowercased()
            guard app.contains("ghostty") else { continue }
            if let pid = window["pid"] as? Int {
                pids.insert(pid)
            }
            if let title = window["title"] as? String,
               !title.isEmpty,
               let space = window["space"] as? Int {
                let key = title.lowercased()
                if let existingSpace = titleMap[key], existingSpace != space {
                    titleMap.removeValue(forKey: key)
                    ambiguousTitles.insert(key)
                } else if !ambiguousTitles.contains(key) {
                    titleMap[key] = space
                }
            }
        }
        return (titleMap, pids)
    }

    private static func normalizedYabaiTitle(_ value: String) -> String {
        value.replacingOccurrences(of: "[-_]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
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
