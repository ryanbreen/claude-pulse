// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ClaudePulseMenu",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ClaudePulseMenu",
            path: "Sources/ClaudePulseMenu"
        )
    ]
)
