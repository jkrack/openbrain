# Floating Recorder — Design Spec

## Overview

An always-on-top Electron BrowserWindow with a Winamp-inspired "Blue Steel" skin that enables system-wide voice recording independent of Obsidian's focus state. Records audio to disk in segmented chunks with progressive background transcription. On stop, assembles a vault note from all segment transcriptions that can then be processed by any OpenBrain skill.

## Motivation

Today, recording in OpenBrain requires the Obsidian window to be open and focused. Users need to capture long-form audio (meetings, 1:1s, brainstorms — up to an hour) while working in other apps. The floating recorder provides a Handy-like always-visible overlay that records, segments, and transcribes durably — surviving crashes, app restarts, and hour-long sessions.

## Architecture

### Approach

Single Electron BrowserWindow (Approach 1). The plugin spawns a frameless, transparent, always-on-top window via Electron's `remote` module. Recording and waveform analysis happen inside the overlay window's renderer process (where `MediaRecorder` and `AudioContext` are available). The main plugin process handles lifecycle orchestration, transcription, and vault operations.

### Electron Access

Obsidian plugins run in a renderer process but can access Electron main-process APIs via `require('electron').remote` (Obsidian exposes this). This is the same mechanism other community plugins use for native window operations. The implementation should:
- Access `BrowserWindow` via `const { BrowserWindow } = require('electron').remote`
- Access `globalShortcut` via `const { globalShortcut } = require('electron').remote`
- Gracefully degrade if `remote` is unavailable (e.g., future Obsidian versions remove it) — fall back to an Obsidian modal-based recorder

### Component Architecture

Four new modules, one modified:

#### `src/floatingRecorder.ts` — Window Lifecycle + IPC

Manages the Electron `BrowserWindow` via `remote`. Responsibilities:
- Create/destroy the frameless, transparent, always-on-top window
- Register/unregister global hotkey via `remote.globalShortcut`
- Handle IPC communication between the main plugin and the overlay
- Expose `toggle()` to the plugin
- Save/restore window position from settings

#### `src/floatingRecorder.html` — Blue Steel Winamp Skin + Recording Engine

Self-contained HTML/CSS/JS loaded into the BrowserWindow. This is where recording happens. Responsibilities:
- Own the `MediaRecorder` and `AudioContext`/`AnalyserNode` (these are Web APIs available in the renderer)
- Capture audio, produce waveform data locally (no IPC needed for waveform — it's in the same process)
- On segment rotation: convert WebM/Opus blob to WAV via `AudioContext.decodeAudioData()`, send the WAV buffer to the main plugin via IPC for disk write
- Render the Winamp-skinned UI (waveform, timer, segment counter, stop button)
- Send IPC messages to main plugin (segment ready, stop pressed, window position changed)
- Receive IPC messages from main plugin (transcription status, done signal)
- Display recording/transcribing/done states

Note: each segment is held in memory as a WebM/Opus blob (~5 minutes of audio, typically a few MB) until conversion and handoff. This is the same approach as the existing `useAudioRecorder` hook — not a streaming-to-disk pipeline.

#### `src/diskRecorder.ts` — Disk Session Manager

Manages the on-disk session directory and segment persistence. Runs in the main plugin's renderer process. Responsibilities:
- Create session directory: `~/.openbrain/recordings/session-<timestamp>/`
- Write `session.json` manifest with metadata and segment tracking
- Receive WAV buffers from the overlay window via IPC, write to `segment-NNN.wav`
- Update `session.json` after each segment write
- Trigger progressive transcription for completed segments
- On stop: wait for all transcriptions, assemble final note, mark session complete

This is a standalone module (not a React hook). The existing `useAudioRecorder` hook remains unchanged for in-panel recording.

#### `src/progressiveTranscriber.ts` — Background Transcription

Manages background transcription of completed segments. Responsibilities:
- Transcribe each segment as it's finalized using configured STT method (Sherpa ONNX or API)
- Write partial transcriptions back to `session.json`
- Handle transcription failures gracefully (mark as ERROR, allow retry)
- Assemble all segment transcriptions into final note on completion
- Support crash recovery: resume transcription of incomplete sessions

#### `src/main.ts` (modified)

- Wire up floating recorder toggle command (Obsidian command + global hotkey)
- On startup: scan for incomplete recording sessions and recover them
- Show Notice on recovery: "Recovered recording from [date]"
- Prevent starting a second recording while one is already active

### Data Flow

```
Hotkey pressed
  -> main.ts calls floatingRecorder.toggle()
  -> floatingRecorder.ts creates BrowserWindow via remote
  -> Overlay window starts MediaRecorder + AnalyserNode (all in overlay renderer)
  -> Waveform renders locally in the overlay (no IPC)
  -> Every 5 min: overlay converts segment blob to WAV, sends buffer via IPC
  -> diskRecorder.ts writes WAV to disk, updates session.json
  -> progressiveTranscriber.ts transcribes the segment in background
  -> Stop (hotkey or button): overlay sends stop signal via IPC
  -> diskRecorder finalizes last segment, waits for transcriptions, creates vault note
  -> Sends recorder:done to overlay -> window auto-closes
```

## Floating Window Behavior

### Window Properties
- Frameless, transparent background — the Winamp skin IS the window
- `alwaysOnTop: true` — visible over all apps
- Default position: bottom-center of screen, ~60px above the system dock/taskbar
- Draggable via the title bar area ("OpenBrain Recorder" label)
- Remembers last position in settings
- Size: ~340x60px (fixed, not resizable)
- No taskbar/dock presence (`skipTaskbar: true` on Windows/Linux)

### Lifecycle
- Hotkey toggles: first press creates window + starts recording, second press stops recording + triggers transcription + closes window
- Stop button in the UI does the same as the second hotkey press
- If Obsidian quits while recording: segments already written to disk remain, next launch detects incomplete session and recovers
- Window has no taskbar/dock icon
- If a recording is already active, the hotkey stops it rather than starting a second one

## Disk Recording & Progressive Transcription

### Session Directory Structure

```
~/.openbrain/recordings/
  session-2026-03-18T141500/
    session.json
    segment-001.wav
    segment-002.wav
    segment-003.wav
```

### session.json Schema

```json
{
  "id": "session-2026-03-18T141500",
  "startedAt": "2026-03-18T14:15:00Z",
  "status": "recording",
  "segmentDuration": 300,
  "segments": [
    { "file": "segment-001.wav", "duration": 300, "transcription": "..." },
    { "file": "segment-002.wav", "duration": 300, "transcription": "..." },
    { "file": "segment-003.wav", "duration": 142, "transcription": null }
  ]
}
```

- `status` values: `"recording"`, `"transcribing"`, `"completed"`, `"error"`
- Segment `transcription`: `null` (not yet transcribed), string (transcription text), or `"ERROR"` (failed)

### Segment Pipeline

1. `MediaRecorder` in overlay window captures WebM/Opus into in-memory blob (~5 min, a few MB)
2. On segment rotation: `AudioContext.decodeAudioData()` decodes blob, encodes as WAV buffer
3. WAV buffer sent to main plugin via IPC
4. `diskRecorder.ts` writes WAV to session directory
5. `session.json` updated with new segment entry

### Progressive Transcription

- When a segment WAV is written to disk, `progressiveTranscriber` immediately transcribes it
- Uses the configured STT method from OpenBrain settings (Sherpa ONNX or API)
- Transcription text written back to `session.json` for that segment
- Runs in background — does not block ongoing recording
- On failure: marks segment as `"ERROR"`, moves on (can retry later)

### On Stop

1. Finalize last partial segment, convert, send to disk, transcribe
2. Concatenate all segment transcriptions in order, separated by `\n\n`
3. Create vault note at `OpenBrain/recordings/YYYY-MM-DD Recording HH-MM.md`:
   ```markdown
   ---
   type: openbrain-recording
   date: 2026-03-18
   duration: 12:34
   segments: 3
   ---

   [full transcription text]
   ```
4. Update `session.json` status to `"completed"`
5. Clean up WAV files (configurable retention)

### Crash Recovery

On startup, `main.ts` scans `~/.openbrain/recordings/` for sessions where `status !== "completed"`:
- Transcribes any segments missing transcriptions
- Assembles the vault note
- Marks session as `"completed"`
- Shows Notice: "Recovered recording from [date] — created note"

## IPC Protocol

### Overlay Window -> Main Plugin (via ipcRenderer)
| Channel | Payload | Purpose |
|---------|---------|---------|
| `recorder:segment-ready` | `{ index, wavBuffer: ArrayBuffer, duration }` | Segment converted, ready for disk write |
| `recorder:stop` | `{}` | Stop button clicked |
| `recorder:position-changed` | `{ x, y }` | Window dragged to new position |

### Main Plugin -> Overlay Window (via webContents.send)
| Channel | Payload | Purpose |
|---------|---------|---------|
| `recorder:segment-saved` | `{ index }` | Disk write confirmed |
| `recorder:transcribing` | `{}` | All segments received, transcription in progress |
| `recorder:done` | `{}` | Transcription complete, window can close |

Note: waveform data, timer, and segment count are all managed locally in the overlay — no IPC needed for UI updates.

## Blue Steel Skin

### Visual Design
- **Title bar**: Draggable (`-webkit-app-region: drag`), "OpenBrain Recorder" in monospace, minimize/close buttons (close = stop + transcribe)
- **Body**: Recording dot (pulsing red), monospace timer with cyan glow (`#6be`, `text-shadow`), bitrate label, waveform SVG
- **Stop button**: Beveled gradient, red square icon
- **Background**: Fully transparent — only the skin chrome is visible
- **Font**: `'Courier New', monospace` throughout
- **Color palette**: Dark navy base (`#0e1a28`), cyan accents (`#6be`), red recording dot (`#e44`), subtle blue border glow (`rgba(100,180,255,0.15)`)

### UI States
| State | Timer | Waveform | Dot | Notes |
|-------|-------|----------|-----|-------|
| Recording | Counting up | Animating at 60fps | Pulsing red | Normal operation |
| Transcribing | Shows "Transcribing..." | Frozen | Off | After stop, before note creation |
| Done | Brief flash | — | — | Auto-closes after 1 second |

### Implementation
Plain HTML/CSS/JS — no framework. Manages its own MediaRecorder, AnalyserNode, and DOM updates. ~200 lines.

## Settings

New settings section "Floating Recorder" in OpenBrain settings:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `floatingRecorderHotkey` | string | `Option+V` | Global hotkey to toggle recording |
| `floatingRecorderPosition` | `{x,y}` or `"auto"` | `"auto"` | Window position (auto = bottom-center) |
| `floatingRecorderSegmentDuration` | number | 300 | Seconds per segment |
| `floatingRecorderOutputFolder` | string | `OpenBrain/recordings` | Vault folder for transcription notes |
| `floatingRecorderRetentionDays` | number | 7 | Days to keep WAV files after transcription (0 = delete immediately) |

## New Files
- `src/floatingRecorder.ts`
- `src/floatingRecorder.html`
- `src/diskRecorder.ts`
- `src/progressiveTranscriber.ts`

## Modified Files
- `src/main.ts` — hotkey command, startup recovery, double-recording guard
- `src/settings.ts` — floating recorder settings section

## Cross-Platform Notes
- Electron `BrowserWindow` via `remote` works on macOS, Windows, and Linux
- `skipTaskbar` prevents dock/taskbar clutter on Windows/Linux
- `-webkit-app-region: drag` for title bar dragging is cross-platform
- Window position persistence handles multi-monitor setups
- Settings-driven design allows platform-specific behavior adjustments in the future
- If `remote` is unavailable: fall back to in-Obsidian modal-based recorder (degraded but functional)
- `globalShortcut` via `remote` provides system-wide hotkey; if unavailable, falls back to Obsidian command hotkey (only works when Obsidian is focused)
