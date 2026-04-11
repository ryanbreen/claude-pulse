import Foundation

func formatDuration(_ seconds: Int) -> String {
    if seconds >= 3600 {
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        return "\(h)h \(m)m"
    }
    if seconds >= 60 {
        let m = seconds / 60
        return "\(m)m"
    }
    return "\(seconds)s"
}

func formatTokenRate(_ value: Double) -> String {
    if value >= 1_000_000 {
        return String(format: "%.1fM", value / 1_000_000)
    }
    if value >= 1_000 {
        return String(format: "%.1fk", value / 1_000)
    }
    if value >= 1 {
        return String(format: "%.0f", value)
    }
    return "0"
}

func formatTTY(_ tty: String) -> String {
    if tty.hasPrefix("ttys") {
        return "s" + tty.dropFirst(4)
    }
    return tty
}
