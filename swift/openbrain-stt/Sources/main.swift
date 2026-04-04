import Foundation

// MARK: - Globals

let transcriber = Transcriber()
let startTime = Date()
let idleTimeoutSeconds: TimeInterval = 30 * 60  // 30 minutes
var lastActivityTime = Date()
var serverFd: Int32 = -1
var isShuttingDown = false
let socketPath: String = {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home.appendingPathComponent(".openbrain/stt.sock").path
}()

// MARK: - JSON Coding

let jsonEncoder = JSONEncoder()
let jsonDecoder = JSONDecoder()

// MARK: - Server

func startServer() async throws {
    // Ensure socket directory exists
    let socketDir = (socketPath as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: socketDir, withIntermediateDirectories: true)

    // Remove stale socket
    if FileManager.default.fileExists(atPath: socketPath) {
        try FileManager.default.removeItem(atPath: socketPath)
    }

    // Create Unix domain socket
    serverFd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard serverFd >= 0 else {
        throw DaemonError.socketCreationFailed(errno)
    }

    // Bind
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
        let pathBytes = socketPath.utf8CString
        pathBytes.withUnsafeBufferPointer { buf in
            let raw = UnsafeMutableRawPointer(ptr)
            memcpy(raw, buf.baseAddress!, min(buf.count, MemoryLayout.size(ofValue: ptr.pointee)))
        }
    }

    let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bindResult = withUnsafePointer(to: &addr) { addrPtr in
        addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
            bind(serverFd, sockaddrPtr, addrLen)
        }
    }
    guard bindResult == 0 else {
        close(serverFd)
        throw DaemonError.bindFailed(errno)
    }

    // Listen
    guard listen(serverFd, 5) == 0 else {
        close(serverFd)
        throw DaemonError.listenFailed(errno)
    }

    // Set non-blocking
    let flags = fcntl(serverFd, F_GETFL)
    _ = fcntl(serverFd, F_SETFL, flags | O_NONBLOCK)

    print("openbrain-stt: listening on \(socketPath)")

    // Pre-load model in background
    Task {
        do {
            try await transcriber.loadModel()
            print("openbrain-stt: model loaded and ready")
        } catch {
            print("openbrain-stt: model load failed: \(error.localizedDescription)")
        }
    }

    // Start idle timeout monitor
    Task {
        await monitorIdleTimeout()
    }

    // Accept loop
    while !isShuttingDown {
        var clientAddr = sockaddr_un()
        var clientAddrLen = socklen_t(MemoryLayout<sockaddr_un>.size)

        let clientFd = withUnsafeMutablePointer(to: &clientAddr) { addrPtr in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                accept(serverFd, sockaddrPtr, &clientAddrLen)
            }
        }

        if clientFd >= 0 {
            lastActivityTime = Date()
            Task {
                await handleClient(fd: clientFd)
            }
        } else if errno == EWOULDBLOCK || errno == EAGAIN {
            // No pending connection — sleep briefly to avoid busy-waiting
            try await Task.sleep(nanoseconds: 50_000_000)  // 50ms
        } else {
            // Unexpected error
            if !isShuttingDown {
                print("openbrain-stt: accept error: \(errno)")
            }
            break
        }
    }

    cleanup()
}

// MARK: - Client Handling

func handleClient(fd: Int32) async {
    defer { close(fd) }

    // Read all data until connection closes
    var buffer = Data()
    let chunkSize = 65536
    let readBuf = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
    defer { readBuf.deallocate() }

    // Set a read timeout via non-blocking + polling
    let clientFlags = fcntl(fd, F_GETFL)
    _ = fcntl(fd, F_SETFL, clientFlags | O_NONBLOCK)

    let readDeadline = Date().addingTimeInterval(60)  // 60s max per client

    while Date() < readDeadline {
        let bytesRead = read(fd, readBuf, chunkSize)
        if bytesRead > 0 {
            buffer.append(readBuf, count: bytesRead)
            // Check if we have a complete newline-delimited message
            if buffer.contains(0x0A) {  // '\n'
                break
            }
        } else if bytesRead == 0 {
            // EOF
            break
        } else if errno == EWOULDBLOCK || errno == EAGAIN {
            try? await Task.sleep(nanoseconds: 10_000_000)  // 10ms
        } else {
            // Read error
            return
        }
    }

    // Process each newline-delimited JSON message
    let messages = buffer.split(separator: 0x0A)
    for messageData in messages {
        lastActivityTime = Date()
        await processRequest(Data(messageData), to: fd)
    }
}

func processRequest(_ data: Data, to fd: Int32) async {
    do {
        let request = try jsonDecoder.decode(Request.self, from: data)

        switch request.type {
        case .transcribe:
            await handleTranscribe(request, to: fd)
        case .status:
            await handleStatus(request, to: fd)
        case .shutdown:
            sendResponse(
                ErrorResponse(type: "ok", id: request.id, error: "shutting down"),
                to: fd
            )
            isShuttingDown = true
        }
    } catch {
        let errorResp = ErrorResponse(
            type: "error",
            id: "unknown",
            error: "Invalid request: \(error.localizedDescription)"
        )
        sendResponse(errorResp, to: fd)
    }
}

// MARK: - Handlers

func handleTranscribe(_ request: Request, to fd: Int32) async {
    do {
        let audioSamples: [Float]
        let format = request.audioFormat ?? "wav"

        if format == "path", let path = request.audio {
            // File path mode
            audioSamples = try AudioProcessor.loadFromFile(path)
        } else if let base64Audio = request.audio {
            // Base64-encoded audio data
            guard let audioData = Data(base64Encoded: base64Audio) else {
                throw DaemonError.invalidAudioData
            }
            audioSamples = try AudioProcessor.loadFromData(audioData, format: format)
        } else {
            throw DaemonError.invalidAudioData
        }

        let options = request.options ?? TranscribeOptions()
        var response = try await transcriber.transcribe(
            audioSamples: audioSamples,
            timestamps: options.timestamps,
            language: options.language
        )
        // Fill in the request id
        response = TranscribeResponse(
            type: response.type,
            id: request.id,
            text: response.text,
            language: response.language,
            duration: response.duration,
            words: response.words,
            processingMs: response.processingMs
        )
        sendResponse(response, to: fd)
    } catch {
        let errorResp = ErrorResponse(
            type: "error",
            id: request.id,
            error: error.localizedDescription
        )
        sendResponse(errorResp, to: fd)
    }
}

func handleStatus(_ request: Request, to fd: Int32) async {
    let currentState = await transcriber.state
    let stateString: String
    let modelReady: Bool

    switch currentState {
    case .idle:
        stateString = "idle"
        modelReady = false
    case .loading:
        stateString = "loading"
        modelReady = false
    case .ready:
        stateString = "ready"
        modelReady = true
    case .error(let msg):
        stateString = "error: \(msg)"
        modelReady = false
    }

    let uptime = Int(Date().timeIntervalSince(startTime))
    let response = StatusResponse(
        type: "status",
        id: request.id,
        state: stateString,
        model: "parakeet-tdt-0.6b-v3",
        modelReady: modelReady,
        uptimeSeconds: uptime
    )
    sendResponse(response, to: fd)
}

// MARK: - Response Sending

func sendResponse<T: Encodable>(_ response: T, to fd: Int32) {
    do {
        var data = try jsonEncoder.encode(response)
        data.append(0x0A)  // newline delimiter

        // Temporarily set blocking mode for writes to handle large responses
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags & ~O_NONBLOCK)
        defer { _ = fcntl(fd, F_SETFL, flags) }

        data.withUnsafeBytes { rawBuf in
            guard let baseAddr = rawBuf.baseAddress else { return }
            var totalWritten = 0
            while totalWritten < data.count {
                let written = write(fd, baseAddr.advanced(by: totalWritten), data.count - totalWritten)
                if written < 0 {
                    if errno == EINTR { continue }  // interrupted — retry
                    break  // real error
                }
                if written == 0 { break }
                totalWritten += written
            }
        }
    } catch {
        print("openbrain-stt: failed to encode response: \(error)")
    }
}

// MARK: - Idle Timeout

func monitorIdleTimeout() async {
    while !isShuttingDown {
        try? await Task.sleep(nanoseconds: 60_000_000_000)  // Check every 60s
        let idle = Date().timeIntervalSince(lastActivityTime)
        if idle >= idleTimeoutSeconds {
            print("openbrain-stt: idle timeout (\(Int(idle))s), shutting down")
            isShuttingDown = true
            break
        }
    }
}

// MARK: - Cleanup

func cleanup() {
    if serverFd >= 0 {
        close(serverFd)
        serverFd = -1
    }
    try? FileManager.default.removeItem(atPath: socketPath)
    print("openbrain-stt: shutdown complete")
}

// MARK: - Signal Handling

signal(SIGTERM) { _ in
    isShuttingDown = true
}

signal(SIGINT) { _ in
    isShuttingDown = true
}

// MARK: - Errors

enum DaemonError: Error, LocalizedError {
    case socketCreationFailed(Int32)
    case bindFailed(Int32)
    case listenFailed(Int32)
    case invalidAudioData

    var errorDescription: String? {
        switch self {
        case .socketCreationFailed(let code):
            return "Failed to create socket (errno \(code))"
        case .bindFailed(let code):
            return "Failed to bind socket (errno \(code))"
        case .listenFailed(let code):
            return "Failed to listen on socket (errno \(code))"
        case .invalidAudioData:
            return "Invalid or missing audio data in request"
        }
    }
}

// MARK: - Entry Point

Task {
    do {
        try await startServer()
    } catch {
        print("Fatal: \(error)")
        exit(1)
    }
}
RunLoop.main.run()
