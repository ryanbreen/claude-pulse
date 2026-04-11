import Foundation

struct GhosttySurface: Decodable, Sendable {
    let shellPid: Int?
    let workingDirectory: String?
    let tabIndex: Int
    let tabTitle: String
    let windowId: Int
    let splitPath: [Int]
    let isFocused: Bool

    private enum CodingKeys: String, CodingKey {
        case shellPid = "shell_pid"
        case workingDirectory = "working_directory"
        case tabIndex = "tab_index"
        case tabTitle = "tab_title"
        case windowId = "window_id"
        case splitPath = "split_path"
        case isFocused = "is_focused"
    }
}

enum GhosttyIntrospector {
    private static let cacheTTL: TimeInterval = 2
    private static let state = State()
    private static let decoder = JSONDecoder()
    private static let candidateBundleIDs = [
        "com.mitchellh.ghostty.debug",
        "com.mitchellh.ghostty.hive",
        "com.mitchellh.ghostty",
    ]

    static func surfaces() -> [GhosttySurface] {
        state.lock.lock()
        if Date().timeIntervalSince1970 - state.cachedAt < cacheTTL {
            let cached = state.cachedSurfaces
            state.lock.unlock()
            return cached
        }

        let preferredBundleID = state.preferredBundleID
        state.lock.unlock()

        let result = loadSurfaces(preferredBundleID: preferredBundleID)

        state.lock.lock()
        state.cachedAt = Date().timeIntervalSince1970
        state.cachedSurfaces = result.surfaces
        state.preferredBundleID = result.bundleID
        let cached = state.cachedSurfaces
        state.lock.unlock()
        return cached
    }

    private static func loadSurfaces(preferredBundleID: String?) -> (surfaces: [GhosttySurface], bundleID: String?) {
        let ordered = orderedCandidates(preferred: preferredBundleID)

        for bundleID in ordered {
            guard let data = requestSurfaces(bundleID: bundleID) else { continue }
            guard let surfaces = decodeSurfaces(from: data) else { continue }
            // An empty array is a valid response (no surfaces open).
            return (surfaces, bundleID)
        }

        return ([], nil)
    }

    private static func orderedCandidates(preferred: String?) -> [String] {
        guard let preferred else { return candidateBundleIDs }
        return [preferred] + candidateBundleIDs.filter { $0 != preferred }
    }

    // Sends the distributed-notification IPC request that the running Ghostty app
    // observes, waits for Ghostty to atomically write the JSON to a temp file, and
    // returns the raw bytes. Returns nil on timeout.
    private static func requestSurfaces(bundleID: String) -> Data? {
        let tempPath = NSTemporaryDirectory() + "claude-pulse-list-surfaces-\(UUID().uuidString).json"
        FileManager.default.createFile(atPath: tempPath, contents: Data(), attributes: nil)
        defer { try? FileManager.default.removeItem(atPath: tempPath) }

        let notificationName = Notification.Name("\(bundleID).ipc.list-surfaces")
        DistributedNotificationCenter.default().postNotificationName(
            notificationName,
            object: tempPath,
            userInfo: nil,
            deliverImmediately: true
        )

        for _ in 0..<50 {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: tempPath),
               let size = attrs[.size] as? Int, size > 0 {
                return try? Data(contentsOf: URL(fileURLWithPath: tempPath))
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        return nil
    }

    private static func decodeSurfaces(from data: Data) -> [GhosttySurface]? {
        try? decoder.decode([GhosttySurface].self, from: data)
    }

    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var cachedAt: TimeInterval = 0
        var cachedSurfaces: [GhosttySurface] = []
        var preferredBundleID: String?
    }
}
