import Foundation

struct TokenRateTracker: Sendable {
    private struct Entry: Sendable {
        let delta: TokenDelta
    }

    private var entries: [Entry] = []
    private let windowSeconds: TimeInterval = 60

    mutating func record(_ deltas: [TokenDelta], now: TimeInterval = Date().timeIntervalSince1970) {
        guard !deltas.isEmpty else {
            prune(now: now)
            return
        }

        entries.append(contentsOf: deltas.map(Entry.init))
        prune(now: now)
    }

    func tokensPerMinute(for sessionKey: String, now: TimeInterval = Date().timeIntervalSince1970) -> Double {
        rate(now: now) { entry in
            guard entry.delta.sessionKey == sessionKey else { return 0 }
            return entry.delta.totalTokens
        }
    }

    func inputTokensPerMinute(for sessionKey: String, now: TimeInterval = Date().timeIntervalSince1970) -> Double {
        rate(now: now) { entry in
            guard entry.delta.sessionKey == sessionKey else { return 0 }
            return entry.delta.totalInputTokens
        }
    }

    func outputTokensPerMinute(for sessionKey: String, now: TimeInterval = Date().timeIntervalSince1970) -> Double {
        rate(now: now) { entry in
            guard entry.delta.sessionKey == sessionKey else { return 0 }
            return entry.delta.totalOutputTokens
        }
    }

    func globalTokensPerMinute(now: TimeInterval = Date().timeIntervalSince1970) -> Double {
        rate(now: now) { entry in
            entry.delta.totalTokens
        }
    }

    func globalInputTokensPerMinute(now: TimeInterval = Date().timeIntervalSince1970) -> Double {
        rate(now: now) { entry in
            entry.delta.totalInputTokens
        }
    }

    func globalOutputTokensPerMinute(now: TimeInterval = Date().timeIntervalSince1970) -> Double {
        rate(now: now) { entry in
            entry.delta.totalOutputTokens
        }
    }

    private func rate(now: TimeInterval, value: (Entry) -> Int) -> Double {
        let cutoff = now - windowSeconds
        let total = entries.reduce(0) { partial, entry in
            guard entry.delta.timestamp >= cutoff else {
                return partial
            }
            return partial + value(entry)
        }
        return Double(total) * (60.0 / windowSeconds)
    }

    private mutating func prune(now: TimeInterval) {
        let cutoff = now - windowSeconds
        entries.removeAll { $0.delta.timestamp < cutoff }
    }
}
