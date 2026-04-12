import SwiftUI

struct MenuPopoverView: View {
    let manager: SessionManager

    private struct DisplayRow: Identifiable {
        let session: AgentSession
        let depth: Int
        let childSummary: String?

        var id: Int {
            session.id
        }
    }

    /// Show any tree that has activity: token traffic, working state,
    /// or recent log events. This catches factory workers launched in
    /// separate terminal tabs that don't have a process-tree parent link.
    private var displayedTrees: [SessionNode] {
        let now = Date().timeIntervalSince1970
        let recentCutoff: TimeInterval = 300
        return manager.sessionTrees.filter { tree in
            isTreeVisible(tree, now: now, cutoff: recentCutoff)
        }
    }

    private func isTreeVisible(_ node: SessionNode, now: TimeInterval, cutoff: TimeInterval) -> Bool {
        let s = node.session
        // Has token traffic
        if (s.inputTokensPerMinute + s.outputTokensPerMinute) > 0 { return true }
        // Is working
        if s.turnState == .working { return true }
        // Is stalled with recent activity
        if s.turnState == .stalled {
            let lastActivity = max(s.lastLogEventAt, s.lastLogMtime)
            if lastActivity > 0 && (now - lastActivity) < cutoff { return true }
        }
        // Any child is visible
        return node.children.contains { isTreeVisible($0, now: now, cutoff: cutoff) }
    }

    private var flatRows: [DisplayRow] {
        var result: [DisplayRow] = []

        func walk(_ node: SessionNode, depth: Int) {
            result.append(
                DisplayRow(
                    session: node.session,
                    depth: depth,
                    childSummary: depth == 0 ? childSummary(for: node) : nil
                )
            )
            for child in node.children {
                walk(child, depth: depth + 1)
            }
        }

        for tree in displayedTrees {
            walk(tree, depth: 0)
        }

        return result
    }

    private var maxListHeight: CGFloat {
        let screenHeight = NSScreen.main?.frame.height ?? 1080
        return screenHeight * 0.5
    }

    private var estimatedListHeight: CGFloat {
        let rowHeight: CGFloat = 46
        let childRowHeight: CGFloat = 36
        return flatRows.reduce(0) { total, row in
            total + (row.depth == 0 ? rowHeight : childRowHeight)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            StatsBarView(manager: manager)
            Divider()
            if flatRows.isEmpty {
                HStack {
                    Spacer()
                    Text("No agent sessions")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                    Spacer()
                }
                .frame(height: 40)
            } else {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(flatRows) { row in
                            SessionRowView(
                                session: row.session,
                                depth: row.depth,
                                childSummary: row.childSummary
                            )
                        }
                    }
                }
                .frame(height: min(estimatedListHeight, maxListHeight))
            }
            Divider()
            HStack {
                Spacer()
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.plain)
                .font(.caption)
            }
        }
        .padding(12)
        .frame(minWidth: 400, maxWidth: 700)
    }

    private func childSummary(for node: SessionNode?) -> String? {
        guard let node, !node.children.isEmpty else { return nil }

        let descendants = flattenedDescendants(of: node)
        let activeDescendantCount = descendants.filter { SessionManager.isNodeBusy(SessionNode(session: $0, children: [])) }.count

        var counts: [AgentType: Int] = [:]
        for session in descendants {
            counts[session.agentType, default: 0] += 1
        }

        let parts = counts.sorted(by: { $0.key.rawValue < $1.key.rawValue }).map { "\($0.value) \($0.key.displayName.lowercased())" }
        let mix = parts.joined(separator: ", ")
        return "\(descendants.count) sub, \(activeDescendantCount) active" + (mix.isEmpty ? "" : " • \(mix)")
    }

    private func flattenedDescendants(of node: SessionNode) -> [AgentSession] {
        node.children.flatMap { child in
            [child.session] + flattenedDescendants(of: child)
        }
    }
}
