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

    private var displayedTrees: [SessionNode] {
        return manager.sessionTrees.filter { tree in
            isTreeVisible(tree)
        }
    }

    private func isTreeVisible(_ node: SessionNode) -> Bool {
        SessionManager.isNodeBusy(node, activePids: manager.activePids)
    }

    private var flatRows: [DisplayRow] {
        var result: [DisplayRow] = []

        func walk(_ node: SessionNode, depth: Int) {
            guard isTreeVisible(node) else { return }

            result.append(
                DisplayRow(
                    session: node.session,
                    depth: depth,
                    childSummary: depth == 0 ? childSummary(for: node) : nil
                )
            )
            for child in node.children where isTreeVisible(child) {
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

        let descendants = flattenedVisibleDescendants(of: node)
        let activeDescendantCount = descendants.filter { $0.pid > 0 && manager.activePids.contains($0.pid) }.count

        var counts: [AgentType: Int] = [:]
        for session in descendants {
            counts[session.agentType, default: 0] += 1
        }

        let parts = counts.sorted(by: { $0.key.rawValue < $1.key.rawValue }).map { "\($0.value) \($0.key.displayName.lowercased())" }
        let mix = parts.joined(separator: ", ")
        return "\(descendants.count) sub, \(activeDescendantCount) active" + (mix.isEmpty ? "" : " • \(mix)")
    }

    private func flattenedVisibleDescendants(of node: SessionNode) -> [AgentSession] {
        node.children.flatMap { child in
            guard isTreeVisible(child) else { return [AgentSession]() }
            return [child.session] + flattenedVisibleDescendants(of: child)
        }
    }
}
