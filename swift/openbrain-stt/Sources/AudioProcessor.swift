import Foundation
import FluidAudio

/// Handles audio format detection and conversion to 16kHz mono Float32
/// suitable for CoreML inference via FluidAudio's AudioConverter.
struct AudioProcessor {

    /// Shared converter targeting 16kHz mono Float32 (ASR default).
    private static let converter = AudioConverter()

    /// Load audio from a file path and convert to 16kHz mono Float32 samples.
    /// FluidAudio's AudioConverter handles format detection, resampling, and channel mixing.
    static func loadFromFile(_ path: String) throws -> [Float] {
        return try converter.resampleAudioFile(path: path)
    }

    /// Load audio from raw data with known format.
    /// Writes to a temp file and delegates to FluidAudio's file-based converter.
    static func loadFromData(_ data: Data, format: String) throws -> [Float] {
        let tempDir = FileManager.default.temporaryDirectory
        let ext = Self.extensionForFormat(format)
        let tempFile = tempDir.appendingPathComponent("openbrain-input.\(ext)")

        try data.write(to: tempFile)
        defer { try? FileManager.default.removeItem(at: tempFile) }

        return try loadFromFile(tempFile.path)
    }

    private static func extensionForFormat(_ format: String) -> String {
        switch format.lowercased() {
        case "wav", "pcm16": return "wav"
        case "webm": return "webm"
        case "mp4", "m4a": return "m4a"
        case "ogg", "opus": return "ogg"
        default: return "wav"
        }
    }
}
