import Foundation

// MARK: - Requests

enum RequestType: String, Codable {
    case transcribe
    case status
    case shutdown
}

struct TranscribeOptions: Codable {
    var timestamps: Bool = true
    var diarize: Bool = false
    var language: String = "auto"
}

struct Request: Codable {
    let type: RequestType
    let id: String
    var audio: String?          // base64 data OR file path
    var audioFormat: String?    // "wav", "pcm16", "webm", "path"
    var sampleRate: Int?
    var options: TranscribeOptions?
}

// MARK: - Responses

struct WordTimestamp: Codable {
    let word: String
    let start: Double
    let end: Double
    let confidence: Double
}

struct TranscribeResponse: Codable {
    let type: String  // "result"
    let id: String
    let text: String
    let language: String?
    let duration: Double?
    let words: [WordTimestamp]?
    let processingMs: Int
}

struct StatusResponse: Codable {
    let type: String  // "status"
    let id: String
    let state: String  // "ready", "loading", "downloading"
    let model: String
    let modelReady: Bool
    let uptimeSeconds: Int
}

struct ErrorResponse: Codable {
    let type: String  // "error"
    let id: String
    let error: String
}

// MARK: - Message framing
// Messages are newline-delimited JSON over the socket.
// Each message is a single JSON object followed by \n.
