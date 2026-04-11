import Foundation

struct LogTailer: Sendable {
    let path: String
    private(set) var lastReadOffset: UInt64 = 0
    private(set) var lastMtime: TimeInterval = 0
    private(set) var lastKnownFileSize: UInt64 = 0
    private var trailingFragment = ""

    init(path: String) {
        self.path = path
    }

    mutating func readNewLines() -> [String] {
        let fileURL = URL(fileURLWithPath: path)

        guard let values = try? fileURL.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]),
              let modificationDate = values.contentModificationDate,
              let fileSize = values.fileSize
        else {
            return []
        }

        let fileSize64 = UInt64(fileSize)
        let mtime = modificationDate.timeIntervalSince1970

        if fileSize64 < lastReadOffset {
            lastReadOffset = 0
            trailingFragment = ""
        }

        guard let handle = try? FileHandle(forReadingFrom: fileURL) else {
            return []
        }
        defer { try? handle.close() }

        do {
            try handle.seek(toOffset: lastReadOffset)
            let data = try handle.readToEnd() ?? Data()
            lastReadOffset = fileSize64
            lastKnownFileSize = fileSize64
            lastMtime = mtime

            guard !data.isEmpty else {
                return []
            }

            let chunk = String(decoding: data, as: UTF8.self)
            let combined = trailingFragment + chunk
            let hasTrailingNewline = combined.hasSuffix("\n")
            let parts = combined.split(separator: "\n", omittingEmptySubsequences: false)

            if hasTrailingNewline {
                trailingFragment = ""
                return parts
                    .map(String.init)
                    .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            }

            trailingFragment = parts.last.map(String.init) ?? combined
            return parts
                .dropLast()
                .map(String.init)
                .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        } catch {
            return []
        }
    }
}
