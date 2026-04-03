# FluidAudio STT Rebuild — Replace sherpa-onnx with CoreML/ANE

## Problem

OpenBrain's speech-to-text pipeline has fundamental architectural issues:

1. **Subprocess-per-transcription** — Every recording spawns a fresh `sherpa-onnx-offline` process. Each invocation pays a 4-5 second cold start (ONNX graph optimization + model loading), allocates ~1.2GB RAM, runs inference, then exits. The model is never warm.

2. **CPU-only inference** — ONNX Runtime on CPU achieves ~0.118 RTF (8.5x realtime). Apple Silicon Macs have a 19 TFLOPS Neural Engine sitting idle while the CPU grinds through matrix multiplications.

3. **Complex dependency chain** — sherpa-onnx binary + dynamic libraries (DYLD_LIBRARY_PATH) + 622MB model download + ffmpeg fallback for audio conversion. Each piece can fail independently (and does on corporate networks).

4. **No iOS path** — The current approach is desktop-only with no way to extend to Obsidian mobile.

## Solution

Replace the entire sherpa-onnx pipeline with a custom Swift CLI built on FluidAudio that runs Parakeet TDT 0.6B-v3 on Apple's Neural Engine via CoreML. Ship it as a companion binary alongside the plugin.

### What we gain

- **20x faster inference** — 155x realtime on ANE vs ~8.5x on CPU
- **66MB memory** vs 1.2GB per invocation
- **Warm daemon** — model loads once, stays resident, subsequent transcriptions are instant
- **No ffmpeg** — FluidAudio handles audio conversion natively
- **Multilingual** — 25 European languages with auto-detection (v3 model)
- **Word-level timestamps** — built into Parakeet TDT output
- **Speaker diarization** — FluidAudio supports it
- **Single binary** — no dylibs, no separate model management from the plugin
- **iOS path** — same Swift package works on iPhone (future phase)

### What we lose

- **Intel Mac support** — ANE requires Apple Silicon (M1+)
- **Linux/Windows local STT** — CoreML is Apple-only

### Fallback strategy

- **Apple Silicon Mac** → FluidAudio daemon (primary)
- **Intel Mac** → Anthropic API transcription (existing `claude.ts`)
- **Mobile (future)** → FluidAudio in-process
- **No local STT on non-Apple** — API transcription is the universal fallback

sherpa-onnx is fully removed. Intel Macs and non-Apple platforms use the API fallback that already exists.

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────┐
│  Obsidian Plugin (TypeScript/React)                 │
│                                                     │
│  useAudioRecorder → MediaRecorder → Blob[]          │
│       ↓                                             │
│  panel.tsx / floatingRecorder.ts                    │
│       ↓                                             │
│  stt.ts (new)                                       │
│    ├─ Connect to daemon via Unix socket              │
│    ├─ Send audio data                                │
│    ├─ Receive JSON results                           │
│    └─ Fall back to claude.ts API if daemon missing   │
│                                                     │
└──────────────┬──────────────────────────────────────┘
               │ Unix domain socket (IPC)
┌──────────────▼──────────────────────────────────────┐
│  openbrain-stt (Swift CLI daemon)                   │
│                                                     │
│  FluidAudio SDK                                     │
│    ├─ AudioConverter (resample to 16kHz mono)        │
│    ├─ AsrManager (chunking + inference orchestration)│
│    └─ CoreML models on Apple Neural Engine           │
│         ├─ Preprocessor (mel spectrogram)            │
│         ├─ Encoder (FastConformer XL, 24 layers)     │
│         ├─ Decoder (TDT predictor)                   │
│         └─ JointDecision (token + duration)          │
│                                                     │
│  Model cache: ~/.openbrain/models/fluidaudio/       │
│  Socket: ~/.openbrain/stt.sock                      │
└─────────────────────────────────────────────────────┘
```

### The Swift Daemon: `openbrain-stt`

A standalone Swift CLI that:
1. Starts as a background daemon, listening on a Unix domain socket
2. Loads the Parakeet TDT 0.6B-v3 CoreML model on first request (one-time ~3.5s compilation, cached thereafter)
3. Accepts audio data (raw PCM or WAV) over the socket
4. Runs inference on the Apple Neural Engine
5. Returns JSON results (text, timestamps, confidence, language, speaker labels)
6. Stays resident — subsequent requests are near-instant (~0.1-0.2s for short clips)
7. Auto-exits after 30 minutes of inactivity (conserve resources)
8. Handles model download on first run

#### Daemon lifecycle

```
Plugin loads (main.ts onLayoutReady)
  → Check if openbrain-stt binary exists
  → If yes: spawn daemon in background
  → Daemon listens on ~/.openbrain/stt.sock
  → Plugin connects when transcription is needed

Plugin unloads
  → Send "shutdown" command to daemon
  → Daemon exits cleanly

Daemon idle for 30 minutes
  → Auto-exit
  → Plugin re-spawns on next transcription request
```

#### IPC Protocol (JSON over Unix socket)

**Request: Transcribe**
```json
{
  "type": "transcribe",
  "id": "req-001",
  "audio": "<base64 PCM or path to WAV file>",
  "audioFormat": "wav" | "pcm16",
  "sampleRate": 16000,
  "options": {
    "timestamps": true,
    "diarize": false,
    "language": "auto"
  }
}
```

**Response: Result**
```json
{
  "type": "result",
  "id": "req-001",
  "text": "Hello world, this is a test.",
  "language": "en",
  "duration": 3.2,
  "words": [
    { "word": "Hello", "start": 0.0, "end": 0.32, "confidence": 0.98 },
    { "word": "world", "start": 0.35, "end": 0.72, "confidence": 0.97 }
  ],
  "processingMs": 145
}
```

**Request: Status**
```json
{ "type": "status", "id": "req-002" }
```

**Response: Status**
```json
{
  "type": "status",
  "id": "req-002",
  "state": "ready" | "loading" | "downloading",
  "model": "parakeet-tdt-0.6b-v3",
  "modelReady": true,
  "uptimeSeconds": 3600
}
```

**Request: Shutdown**
```json
{ "type": "shutdown", "id": "req-003" }
```

#### Model management

The daemon handles its own model download and caching:

- First run: download CoreML model from HuggingFace (`FluidInference/parakeet-tdt-0.6b-v3-coreml`) using `URLSession` (trusts macOS Keychain — no corporate proxy issues)
- Cache to `~/.openbrain/models/fluidaudio/parakeet-tdt-0.6b-v3/`
- CoreML compiles the model on first inference (~3.5s), caches as `.mlmodelc`
- Subsequent daemon starts load from compiled cache in milliseconds

This eliminates the model download issues we hit with sherpa-onnx — Swift's `URLSession` uses SecureTransport natively.

### Plugin-Side Changes

#### New `stt.ts` (complete rewrite)

Replace the entire file. New responsibilities:
- Connect to the daemon's Unix socket
- Send transcription requests
- Parse JSON responses
- Handle daemon lifecycle (start, health check, restart)
- Fall back to `claude.ts` API transcription if daemon unavailable (Intel Mac, daemon crashed)

```typescript
// New interface
export interface TranscribeResult {
  text: string;
  durationMs: number;
  language?: string;
  words?: { word: string; start: number; end: number; confidence: number }[];
  processingMs?: number;
}

// Primary function — same interface, new internals
export async function transcribeBlob(blob: Blob, settings: OpenBrainSettings): Promise<TranscribeResult>;
export async function transcribeWavFile(wavPath: string, settings: OpenBrainSettings): Promise<TranscribeResult>;
export async function transcribeSegments(segments: Blob[], settings: OpenBrainSettings, onProgress?: (msg: string) => void): Promise<TranscribeResult>;

// Daemon management
export async function ensureDaemon(settings: OpenBrainSettings): Promise<boolean>;
export async function checkSttInstallation(settings: OpenBrainSettings): Promise<SttStatus>;
export async function installStt(settings: OpenBrainSettings, onProgress: (msg: string) => void): Promise<void>;
```

The external interface stays compatible — `transcribeBlob`, `transcribeSegments`, `checkSttInstallation`, `installStt` keep the same signatures. Callers (`panel.tsx`, `floatingRecorder.ts`, `progressiveTranscriber.ts`) don't change.

#### Remove `audioConverter.ts`

No longer needed. The daemon handles audio format conversion internally via FluidAudio's `AudioConverter`. The plugin sends raw audio data (or a file path) and gets text back.

However, `useAudioRecorder.ts` still produces WebM/Opus blobs from MediaRecorder. Two options:

**Option A:** Send the raw WebM/Opus blob to the daemon and let it decode. FluidAudio can handle this.

**Option B:** Convert to WAV in the plugin before sending. Keeps the daemon's interface simple (always receives PCM/WAV).

**Recommendation: Option A** — send the blob as-is. The daemon decodes it using AVFoundation (which handles WebM/Opus natively on macOS 14+). This eliminates the entire `audioConverter.ts` file and the ffmpeg fallback.

If the daemon receives a format it can't decode, it returns an error and the plugin falls back to API transcription.

#### `floatingRecorder.ts` changes

The floating recorder currently writes WAV segments to disk via `diskRecorder.ts`, then transcribes them via `transcribeWavFile()`. This stays the same — the new `transcribeWavFile()` sends the path to the daemon instead of spawning sherpa-onnx.

The `getTranscribeFn()` method simplifies:
```typescript
private getTranscribeFn(): TranscribeFn {
  // Always try daemon first, fall back to API
  return async (wavPath: string) => {
    return transcribeWavFile(wavPath, this.settings);
  };
}
```

No more `useLocalStt` toggle — the daemon is always preferred when available.

#### Settings changes

**Remove:**
- `useLocalStt: boolean` — no longer needed (daemon is auto-detected)
- `sttHomePath: string` — daemon manages its own paths

**Keep:**
- `audioDeviceId: string`
- `transcribeOnStop: boolean`
- All floating recorder settings

**Add:**
- `sttDaemonAutoStart: boolean` (default true) — start daemon on plugin load
- `sttModelId: string` (default `"parakeet-tdt-0.6b-v3"`) — future model selection

**Settings UI (Voice tab):**

Replace the "Local speech-to-text" section:

**Before:**
- Toggle: "Use local transcription"
- Text input: sherpa-onnx home directory
- Install button: "Install sherpa-onnx + Parakeet model"

**After:**
- Status indicator: "Neural Engine STT: Ready" / "Downloading model..." / "Not available (requires Apple Silicon)"
- Model info: "Parakeet TDT 0.6B v3 · 25 languages · ~155x realtime"
- Button: "Download model" (if not installed) or "Model ready ✓"
- Toggle: "Auto-start STT daemon" (default on)
- Note for Intel/non-Mac: "Local STT requires Apple Silicon. Voice recordings use Anthropic API for transcription."

### Files Removed

| File | Reason |
|------|--------|
| `src/stt.ts` | Completely rewritten (new implementation) |
| `src/audioConverter.ts` | Daemon handles audio conversion |
| `floatingRecorder.html` | Keep (no changes to the HTML overlay itself) |

### Files Created

| File | Purpose |
|------|---------|
| `src/stt.ts` | New daemon-based STT client (same export interface) |
| `swift/openbrain-stt/` | New Swift package — the daemon binary |
| `swift/openbrain-stt/Package.swift` | Swift package manifest, depends on FluidAudio |
| `swift/openbrain-stt/Sources/main.swift` | Daemon entry point: socket server, model loading, request handling |
| `swift/openbrain-stt/Sources/AudioProcessor.swift` | Audio format conversion using FluidAudio |
| `swift/openbrain-stt/Sources/Transcriber.swift` | CoreML inference wrapper |
| `swift/openbrain-stt/Sources/Protocol.swift` | JSON IPC protocol types |

### Files Modified

| File | Change |
|------|--------|
| `src/main.ts` | Start daemon on plugin load (replace sherpa-onnx references). Stop daemon on unload. |
| `src/panel.tsx` | Remove `useLocalStt` toggle logic. Remove dynamic import of old `stt.ts`. Use new `transcribeBlob` directly. |
| `src/floatingRecorder.ts` | Simplify `getTranscribeFn()` — always use daemon client. Remove `useLocalStt` branching. |
| `src/settings.ts` | Remove `useLocalStt`/`sttHomePath`. Replace Voice tab STT section with daemon status UI. |
| `src/progressiveTranscriber.ts` | No changes — `TranscribeFn` type stays the same. |
| `src/diskRecorder.ts` | No changes — format-agnostic. |
| `src/useAudioRecorder.ts` | No changes — still produces blobs via MediaRecorder. |
| `src/components/AudioControls.tsx` | No changes — just renders state from `useAudioRecorder`. |
| `src/claude.ts` | No changes — stays as API fallback. |

### Files Kept Unchanged

- `useAudioRecorder.ts` — Browser recording is independent of STT engine
- `diskRecorder.ts` — Session management is format-agnostic
- `progressiveTranscriber.ts` — Just a loop that calls `TranscribeFn`
- `floatingRecorder.html` — Electron overlay HTML
- `claude.ts` — API fallback for non-Apple-Silicon machines
- `AudioControls.tsx` — Pure UI component

## Swift Daemon Build & Distribution

### Build

```bash
cd swift/openbrain-stt
swift build -c release
# Output: .build/release/openbrain-stt
```

The binary is a universal macOS binary (arm64). Statically links FluidAudio. The CoreML models are downloaded at runtime (not bundled in the binary).

### Distribution

The built binary ships alongside the plugin:

```
.obsidian/plugins/open-brain/
  main.js
  manifest.json
  styles.css
  floatingRecorder.html
  bin/
    openbrain-stt          ← new Swift daemon binary
```

The plugin's `installStt()` function either:
1. Uses the bundled binary (if present in `bin/`)
2. Downloads a pre-built release from GitHub
3. Builds from source if Swift toolchain is available (developer path)

### Model Download

On first transcription request, the daemon downloads:
- `~/.openbrain/models/fluidaudio/parakeet-tdt-0.6b-v3/` (~6GB total)
  - `Preprocessor.mlmodelc/`
  - `Encoder.mlmodelc/`
  - `Decoder.mlmodelc/`
  - `JointDecision.mlmodelc/`
  - `tokens.txt`

These are pre-compiled CoreML models from the FluidAudio HuggingFace repo. Download uses Swift's `URLSession` which trusts the macOS Keychain natively — no corporate proxy issues.

After first download, the daemon loads from cache in milliseconds.

## Word-Level Timestamps

The new pipeline produces word-level timestamps for free (Parakeet TDT outputs them natively). This enables future features:

- Clickable words in the chat that jump to audio position
- Highlighted transcript during audio playback
- Precise editing (select a time range → get the corresponding text)

For now, timestamps are returned in the JSON response and stored in chat frontmatter. UI for timestamps is out of scope.

## Speaker Diarization

FluidAudio supports speaker diarization (who said what). This is returned in the response when `diarize: true` is set. Useful for meeting transcription — each speaker gets a label.

For now, diarization is available but not exposed in the plugin UI. The `meeting-agent` skill could use it in the future to attribute quotes to speakers.

## Implementation Phases

### Phase 1: Swift Daemon + Plugin Client

Build the `openbrain-stt` Swift daemon and the new `stt.ts` client. Get basic transcription working end-to-end: record → send to daemon → get text back.

### Phase 2: Settings UI + Installation Flow

Replace the Voice tab STT section with daemon status, model download, and auto-start toggle. Handle the "not available on Intel" case gracefully.

### Phase 3: Remove Old Code

Delete `audioConverter.ts`, remove sherpa-onnx references from `stt.ts`, clean up settings (`useLocalStt`, `sttHomePath`), remove sherpa-onnx installation flow.

### Phase 4: Floating Recorder Integration

Verify the floating recorder works with the new daemon. Simplify `getTranscribeFn()`.

### Phase 5: Word Timestamps + Diarization (optional)

Store word timestamps in chat frontmatter. Expose diarization option for meeting skills.

## Performance Expectations

| Metric | Old (sherpa-onnx) | New (FluidAudio daemon) |
|--------|-------------------|------------------------|
| Cold start (first ever) | 4-5s per invocation | ~3.5s first compile, then cached |
| Warm start | 4-5s (subprocess) | ~50ms (socket connect) |
| 10s audio | ~6.2s | ~0.15s |
| 60s audio | ~12s | ~0.5s |
| 5min audio | ~40s | ~2s |
| Memory | ~1.2GB per invocation | ~66MB persistent |
| Model size | 622MB (int8 ONNX) | ~6GB (CoreML, cached) |
| Languages | English only | 25 European |
| WER (English) | ~6.05% | ~6.34% (multilingual tradeoff) |

## What This Does NOT Include

- No iOS integration (future phase — same Swift package, different host)
- No streaming/real-time transcription (batch only, same as current)
- No custom model selection UI (single model for now)
- No Windows/Linux local STT (API fallback only)
- No word timestamp UI (data captured but not displayed)
- No speaker diarization UI (capability present but not exposed)

## License Considerations

- **FluidAudio SDK**: Apache 2.0 (permissive — can embed freely)
- **Parakeet TDT model**: CC-BY-4.0 (free to use with attribution)
- **macparakeet**: GPL-3.0 — we do NOT use any macparakeet code. We build directly on FluidAudio (Apache 2.0) and the model (CC-BY-4.0). No GPL contamination.

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| FluidAudio API changes | Low (v1.0, stable) | Pin version in Package.swift |
| 6GB model download fails | Medium (corporate networks) | URLSession trusts Keychain; add retry + resume |
| User doesn't have Apple Silicon | Medium | Graceful fallback to API transcription |
| Swift binary doesn't run on older macOS | Low | Target macOS 14.2+ (same as macparakeet) |
| CoreML compilation fails on first run | Low | Catch error, fall back to API, log diagnostic |
| Daemon crashes | Medium | Auto-restart on next transcription request |
| Unix socket permission issues | Low | Use user home dir (~/.openbrain/), standard permissions |
