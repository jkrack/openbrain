import Foundation
import FluidAudio

/// Wraps FluidAudio's ASR pipeline for CoreML inference on Apple Neural Engine.
///
/// Uses AsrManager (actor) with Parakeet TDT v3 model. Models are auto-downloaded
/// from HuggingFace on first use and cached under ~/Library/Application Support/FluidAudio/Models/.
actor Transcriber {
    private var asrManager: AsrManager?
    private var modelsLoaded = false

    enum State: Sendable {
        case idle
        case loading
        case ready
        case error(String)
    }

    private(set) var state: State = .idle

    init() {}

    /// Download (if needed) and load the Parakeet TDT v3 CoreML models.
    func loadModel() async throws {
        guard !modelsLoaded else { return }
        state = .loading
        do {
            let manager = AsrManager(config: .default)
            let models = try await AsrModels.downloadAndLoad(version: .v3)
            try await manager.loadModels(models)
            self.asrManager = manager
            self.modelsLoaded = true
            state = .ready
        } catch {
            state = .error(error.localizedDescription)
            throw error
        }
    }

    var isReady: Bool {
        if case .ready = state { return true }
        return false
    }

    /// Transcribe pre-processed audio samples (16kHz mono Float32).
    ///
    /// - Parameters:
    ///   - audioSamples: Float32 audio at 16kHz, as returned by AudioProcessor.
    ///   - timestamps: Whether to include word-level timestamps.
    ///   - language: Language hint (currently ignored; Parakeet TDT is English-only).
    /// - Returns: A TranscribeResponse suitable for IPC serialization.
    func transcribe(
        audioSamples: [Float],
        timestamps: Bool = true,
        language: String = "auto"
    ) async throws -> TranscribeResponse {
        guard let manager = asrManager else {
            throw TranscriberError.modelNotLoaded
        }

        let startTime = DispatchTime.now()

        let result = try await manager.transcribe(audioSamples)

        let elapsed = DispatchTime.now().uptimeNanoseconds - startTime.uptimeNanoseconds
        let processingMs = Int(elapsed / 1_000_000)

        // Map FluidAudio TokenTiming to our IPC WordTimestamp
        let words: [WordTimestamp]? = timestamps ? result.tokenTimings?.map { t in
            WordTimestamp(
                word: t.token,
                start: t.startTime,
                end: t.endTime,
                confidence: Double(t.confidence)
            )
        } : nil

        return TranscribeResponse(
            type: "result",
            id: "",  // Caller fills in the request id
            text: result.text,
            language: "en",  // Parakeet TDT v3 is English-only
            duration: result.duration,
            words: words,
            processingMs: processingMs
        )
    }
}

enum TranscriberError: Error, LocalizedError {
    case modelNotLoaded

    var errorDescription: String? {
        switch self {
        case .modelNotLoaded:
            return "Model not loaded — call loadModel() first"
        }
    }
}
