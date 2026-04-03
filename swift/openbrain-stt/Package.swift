// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "openbrain-stt",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.13.5"),
    ],
    targets: [
        .executableTarget(
            name: "openbrain-stt",
            dependencies: ["FluidAudio"],
            path: "Sources"
        ),
    ]
)
