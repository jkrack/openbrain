# Floating Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an always-on-top floating recorder window with a Winamp "Blue Steel" skin that records audio to disk in segments with progressive transcription, creating vault notes for skill processing.

**Architecture:** Electron BrowserWindow via `require('electron').remote`, recording in the overlay renderer, disk persistence and transcription in the main plugin renderer, IPC for segment handoff and lifecycle signals.

**Tech Stack:** TypeScript, Electron BrowserWindow/IPC/globalShortcut (via remote), MediaRecorder, AudioContext/AnalyserNode, Node fs for disk I/O, existing audioConverter.ts and stt.ts

**Spec:** `docs/superpowers/specs/2026-03-18-floating-recorder-design.md`

---

### Task 1: Settings — Add Floating Recorder Configuration

**Files:**
- Modify: `src/settings.ts:4-34` (OpenBrainSettings interface)
- Modify: `src/settings.ts:36-66` (DEFAULT_SETTINGS)
- Modify: `src/settings.ts:76-523` (OpenBrainSettingTab.display)

- [ ] **Step 1: Add settings fields to interface**

In `src/settings.ts`, add to the `OpenBrainSettings` interface after `ollamaModel`:

```typescript
  // Floating recorder
  floatingRecorderHotkey: string;
  floatingRecorderPosition: { x: number; y: number } | "auto";
  floatingRecorderSegmentDuration: number;
  floatingRecorderOutputFolder: string;
  floatingRecorderRetentionDays: number;
```

- [ ] **Step 2: Add defaults**

In `DEFAULT_SETTINGS`, add after `ollamaModel: ""`:

```typescript
  floatingRecorderHotkey: "Alt+V",
  floatingRecorderPosition: "auto" as { x: number; y: number } | "auto",
  floatingRecorderSegmentDuration: 300,
  floatingRecorderOutputFolder: "OpenBrain/recordings",
  floatingRecorderRetentionDays: 7,
```

- [ ] **Step 3: Add settings UI section**

In `OpenBrainSettingTab.display()`, add a new "Floating Recorder" section before the OpenClaw section (before line 491). Insert:

```typescript
    // ── Floating Recorder ──
    new Setting(containerEl).setName("Floating recorder").setHeading();

    new Setting(containerEl)
      .setName("Global hotkey")
      .setDesc(
        "System-wide hotkey to toggle the floating recorder. " +
        "Works even when Obsidian is not focused. Format: modifier+key (e.g., Alt+V, Ctrl+Shift+R)."
      )
      .addText((text) =>
        text
          .setPlaceholder("Alt+V")
          .setValue(this.plugin.settings.floatingRecorderHotkey)
          .onChange((value) => { void (async () => {
            this.plugin.settings.floatingRecorderHotkey = value || "Alt+V";
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("Segment duration")
      .setDesc(
        "How often to save a recording segment to disk (in seconds). " +
        "Shorter segments mean less data loss on crash. Default: 300 (5 minutes)."
      )
      .addText((text) =>
        text
          .setPlaceholder("300")
          .setValue(String(this.plugin.settings.floatingRecorderSegmentDuration))
          .onChange((value) => { void (async () => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 30) {
              this.plugin.settings.floatingRecorderSegmentDuration = num;
              await this.plugin.saveSettings();
            }
          })(); })
      );

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Vault folder where transcription notes are created.")
      .addText((text) =>
        text
          .setPlaceholder("OpenBrain/recordings")
          .setValue(this.plugin.settings.floatingRecorderOutputFolder)
          .onChange((value) => { void (async () => {
            this.plugin.settings.floatingRecorderOutputFolder = value || "OpenBrain/recordings";
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("WAV file retention")
      .setDesc(
        "Days to keep raw WAV files after transcription. Set to 0 to delete immediately."
      )
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.floatingRecorderRetentionDays))
          .onChange((value) => { void (async () => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.floatingRecorderRetentionDays = num;
              await this.plugin.saveSettings();
            }
          })(); })
      );
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts
git commit -m "feat(floating-recorder): add settings for hotkey, segments, output folder, retention"
```

---

### Task 2: Disk Session Manager — `diskRecorder.ts`

**Files:**
- Create: `src/diskRecorder.ts`
- Create: `src/__tests__/diskRecorder.test.ts`

- [ ] **Step 1: Write failing tests for session lifecycle**

Create `src/__tests__/diskRecorder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// We test the session JSON management and file-writing logic.
// MediaRecorder and transcription are not part of this module.

import {
  createSession,
  addSegment,
  markTranscription,
  readSession,
  assembleTranscription,
  markCompleted,
  findIncompleteSessions,
  type RecordingSession,
} from "../diskRecorder";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ob-disk-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("diskRecorder", () => {
  it("creates a session directory with session.json", async () => {
    const session = await createSession(testDir, 300);
    expect(session.status).toBe("recording");
    expect(session.segments).toEqual([]);
    expect(session.segmentDuration).toBe(300);

    const loaded = await readSession(session.dir);
    expect(loaded.id).toBe(session.id);
  });

  it("adds a segment entry to session.json", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44); // minimal WAV header
    await addSegment(session.dir, wavBuf, 300);

    const loaded = await readSession(session.dir);
    expect(loaded.segments).toHaveLength(1);
    expect(loaded.segments[0].file).toBe("segment-001.wav");
    expect(loaded.segments[0].duration).toBe(300);
    expect(loaded.segments[0].transcription).toBeNull();
  });

  it("marks a segment transcription", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await markTranscription(session.dir, 0, "Hello world");

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("Hello world");
  });

  it("assembles transcriptions in order", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 142);
    await markTranscription(session.dir, 0, "First segment.");
    await markTranscription(session.dir, 1, "Second segment.");
    await markTranscription(session.dir, 2, "Third segment.");

    const text = await assembleTranscription(session.dir);
    expect(text).toBe("First segment.\n\nSecond segment.\n\nThird segment.");
  });

  it("marks session as completed", async () => {
    const session = await createSession(testDir, 300);
    await markCompleted(session.dir);

    const loaded = await readSession(session.dir);
    expect(loaded.status).toBe("completed");
  });

  it("finds incomplete sessions", async () => {
    const s1 = await createSession(testDir, 300);
    const s2 = await createSession(testDir, 300);
    await markCompleted(s1.dir);

    const incomplete = await findIncompleteSessions(testDir);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toBe(s2.dir);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/diskRecorder.test.ts`
Expected: FAIL — module `../diskRecorder` not found.

- [ ] **Step 3: Implement diskRecorder.ts**

Create `src/diskRecorder.ts`:

```typescript
import { mkdir, writeFile, readFile, readdir, unlink } from "fs/promises";
import { join } from "path";

export interface SegmentEntry {
  file: string;
  duration: number;
  transcription: string | null;
}

export interface RecordingSession {
  id: string;
  dir: string;
  startedAt: string;
  status: "recording" | "transcribing" | "completed" | "error";
  segmentDuration: number;
  segments: SegmentEntry[];
}

function sessionJsonPath(dir: string): string {
  return join(dir, "session.json");
}

function toSessionData(session: RecordingSession): object {
  const { dir, ...data } = session;
  return data;
}

export async function createSession(
  baseDir: string,
  segmentDuration: number
): Promise<RecordingSession> {
  const now = new Date();
  const id = `session-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const dir = join(baseDir, id);
  await mkdir(dir, { recursive: true });

  const session: RecordingSession = {
    id,
    dir,
    startedAt: now.toISOString(),
    status: "recording",
    segmentDuration,
    segments: [],
  };

  await writeFile(sessionJsonPath(dir), JSON.stringify(toSessionData(session), null, 2));
  return session;
}

export async function readSession(dir: string): Promise<RecordingSession> {
  const raw = await readFile(sessionJsonPath(dir), "utf-8");
  const data = JSON.parse(raw) as Omit<RecordingSession, "dir">;
  return { ...data, dir };
}

export async function addSegment(
  dir: string,
  wavBuffer: Buffer,
  duration: number
): Promise<string> {
  const session = await readSession(dir);
  const index = session.segments.length + 1;
  const filename = `segment-${String(index).padStart(3, "0")}.wav`;

  await writeFile(join(dir, filename), wavBuffer);

  session.segments.push({ file: filename, duration, transcription: null });
  await writeFile(sessionJsonPath(dir), JSON.stringify(toSessionData(session), null, 2));

  return filename;
}

export async function markTranscription(
  dir: string,
  segmentIndex: number,
  text: string
): Promise<void> {
  const session = await readSession(dir);
  session.segments[segmentIndex].transcription = text;
  await writeFile(sessionJsonPath(dir), JSON.stringify(toSessionData(session), null, 2));
}

export async function markCompleted(dir: string): Promise<void> {
  const session = await readSession(dir);
  session.status = "completed";
  await writeFile(sessionJsonPath(dir), JSON.stringify(toSessionData(session), null, 2));
}

export async function assembleTranscription(dir: string): Promise<string> {
  const session = await readSession(dir);
  return session.segments
    .map((s) => s.transcription)
    .filter((t): t is string => t !== null && t !== "ERROR")
    .join("\n\n");
}

/**
 * Delete WAV segment files from completed sessions older than retentionDays.
 * Keeps session.json for history. Pass 0 to delete immediately after completion.
 */
export async function cleanupOldSegments(
  baseDir: string,
  retentionDays: number
): Promise<void> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await readdir(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const dir = join(baseDir, entry.name);
    try {
      const session = await readSession(dir);
      if (session.status !== "completed") continue;

      const sessionTime = new Date(session.startedAt).getTime();
      if (sessionTime > cutoff) continue;

      // Delete WAV files, keep session.json
      for (const seg of session.segments) {
        const wavPath = join(dir, seg.file);
        try { await unlink(wavPath); } catch { /* may already be deleted */ }
      }
    } catch {
      // Corrupted session — skip
    }
  }
}

export async function findIncompleteSessions(baseDir: string): Promise<string[]> {
  const entries = await readdir(baseDir, { withFileTypes: true });
  const incomplete: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const dir = join(baseDir, entry.name);
    try {
      const session = await readSession(dir);
      if (session.status !== "completed") {
        incomplete.push(dir);
      }
    } catch {
      // Corrupted session — skip
    }
  }

  return incomplete;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/diskRecorder.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Build to verify types**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/diskRecorder.ts src/__tests__/diskRecorder.test.ts
git commit -m "feat(floating-recorder): disk session manager with segment persistence and crash recovery"
```

---

### Task 3: Progressive Transcriber — `progressiveTranscriber.ts`

**Files:**
- Create: `src/progressiveTranscriber.ts`
- Create: `src/__tests__/progressiveTranscriber.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/progressiveTranscriber.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createSession, addSegment, readSession } from "../diskRecorder";

// Mock the stt module — we don't want to run real transcription in tests
vi.mock("../stt", () => ({
  transcribeBlob: vi.fn(),
}));

import { transcribeSegment, transcribeAllPending } from "../progressiveTranscriber";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ob-transcriber-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("progressiveTranscriber", () => {
  it("transcribes a single segment and updates session.json", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);

    // Provide a mock transcribe function
    const mockTranscribe = vi.fn().mockResolvedValue({ text: "Hello world", durationMs: 100 });

    await transcribeSegment(session.dir, 0, mockTranscribe);

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("Hello world");
    expect(mockTranscribe).toHaveBeenCalledOnce();
  });

  it("marks ERROR on transcription failure", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);

    const mockTranscribe = vi.fn().mockRejectedValue(new Error("API timeout"));

    await transcribeSegment(session.dir, 0, mockTranscribe);

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("ERROR");
  });

  it("transcribes all pending segments", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 142);

    let callCount = 0;
    const mockTranscribe = vi.fn().mockImplementation(async () => {
      callCount++;
      return { text: `Segment ${callCount}`, durationMs: 100 };
    });

    await transcribeAllPending(session.dir, mockTranscribe);

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("Segment 1");
    expect(loaded.segments[1].transcription).toBe("Segment 2");
    expect(loaded.segments[2].transcription).toBe("Segment 3");
  });

  it("skips already-transcribed segments", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 300);

    // Pre-transcribe segment 0
    const { markTranscription } = await import("../diskRecorder");
    await markTranscription(session.dir, 0, "Already done");

    const mockTranscribe = vi.fn().mockResolvedValue({ text: "New transcription", durationMs: 100 });

    await transcribeAllPending(session.dir, mockTranscribe);

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("Already done");
    expect(loaded.segments[1].transcription).toBe("New transcription");
    expect(mockTranscribe).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/progressiveTranscriber.test.ts`
Expected: FAIL — module `../progressiveTranscriber` not found.

- [ ] **Step 3: Implement progressiveTranscriber.ts**

Create `src/progressiveTranscriber.ts`:

```typescript
import { readFile } from "fs/promises";
import { join } from "path";
import { readSession, markTranscription } from "./diskRecorder";

export type TranscribeFn = (wavPath: string) => Promise<{ text: string; durationMs: number }>;

/**
 * Transcribe a single segment by index.
 * Reads the WAV file from the session directory and calls the provided transcribe function.
 * Updates session.json with the result or "ERROR" on failure.
 */
export async function transcribeSegment(
  sessionDir: string,
  segmentIndex: number,
  transcribeFn: TranscribeFn
): Promise<void> {
  const session = await readSession(sessionDir);
  const segment = session.segments[segmentIndex];
  const wavPath = join(sessionDir, segment.file);

  try {
    const result = await transcribeFn(wavPath);
    await markTranscription(sessionDir, segmentIndex, result.text);
  } catch {
    await markTranscription(sessionDir, segmentIndex, "ERROR");
  }
}

/**
 * Transcribe all segments that don't yet have a transcription.
 * Processes sequentially to avoid overloading STT resources.
 */
export async function transcribeAllPending(
  sessionDir: string,
  transcribeFn: TranscribeFn
): Promise<void> {
  const session = await readSession(sessionDir);

  for (let i = 0; i < session.segments.length; i++) {
    if (session.segments[i].transcription === null) {
      await transcribeSegment(sessionDir, i, transcribeFn);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/progressiveTranscriber.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Build to verify types**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/progressiveTranscriber.ts src/__tests__/progressiveTranscriber.test.ts
git commit -m "feat(floating-recorder): progressive transcriber with error handling and crash recovery"
```

---

### Task 4: Blue Steel Skin — `floatingRecorder.html`

**Files:**
- Create: `src/floatingRecorder.html`

This is the self-contained HTML/CSS/JS for the overlay BrowserWindow. It owns the MediaRecorder, AnalyserNode, waveform rendering, and timer. Communicates with the main plugin via Electron IPC.

- [ ] **Step 1: Create the HTML file**

Create `src/floatingRecorder.html`:

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: transparent;
    overflow: hidden;
    font-family: 'Courier New', monospace;
    user-select: none;
  }

  .recorder {
    display: flex;
    flex-direction: column;
    min-width: 340px;
  }

  /* Title bar — draggable */
  .titlebar {
    background: linear-gradient(90deg, #1a3a5a, #0a1a2a, #1a3a5a);
    border-radius: 6px 6px 0 0;
    padding: 3px 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border: 1px solid rgba(100,180,255,0.15);
    border-bottom: none;
    -webkit-app-region: drag;
  }

  .titlebar-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .titlebar-icon { font-size: 11px; }

  .titlebar-label {
    font-size: 9px;
    color: rgba(100,180,255,0.7);
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .titlebar-buttons {
    display: flex;
    gap: 3px;
    -webkit-app-region: no-drag;
  }

  .titlebar-btn {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: rgba(100,180,255,0.2);
    border: 1px solid rgba(100,180,255,0.3);
    cursor: pointer;
  }

  .titlebar-btn:hover { background: rgba(100,180,255,0.4); }
  .titlebar-btn.close:hover { background: rgba(255,80,80,0.5); }

  /* Body */
  .body {
    background: linear-gradient(180deg, #0e1a28, #0a1420);
    border: 1px solid rgba(100,180,255,0.12);
    border-top: none;
    border-radius: 0 0 6px 6px;
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* Recording dot */
  .rec-dot {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid rgba(100,180,255,0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(100,180,255,0.05);
    flex-shrink: 0;
  }

  .rec-dot-inner {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e44;
    box-shadow: 0 0 8px rgba(230,60,60,0.5);
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* Display area */
  .display {
    flex: 1;
  }

  .display-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .timer {
    font-size: 16px;
    color: #6be;
    text-shadow: 0 0 6px rgba(100,180,255,0.3);
    font-variant-numeric: tabular-nums;
    letter-spacing: 2px;
  }

  .meta {
    font-size: 8px;
    color: rgba(100,180,255,0.5);
  }

  .waveform { width: 100%; height: 14px; }

  .wave-line {
    fill: none;
    stroke: #6be;
    stroke-width: 1.5;
    stroke-linecap: round;
    opacity: 0.7;
  }

  /* Stop button */
  .stop-btn {
    width: 26px;
    height: 26px;
    border-radius: 4px;
    background: linear-gradient(180deg, #2a3a4a, #1a2a38);
    border: 1px solid rgba(100,180,255,0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    -webkit-app-region: no-drag;
  }

  .stop-btn:hover { background: linear-gradient(180deg, #3a4a5a, #2a3a48); }

  .stop-icon {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: #e44;
  }

  /* Transcribing state */
  .state-transcribing .rec-dot-inner {
    animation: none;
    opacity: 0;
  }

  .state-transcribing .timer {
    animation: pulse 2s ease-in-out infinite;
  }

  .state-transcribing .wave-line {
    opacity: 0.3;
  }
</style>
</head>
<body>
<div class="recorder" id="recorder">
  <div class="titlebar">
    <div class="titlebar-left">
      <span class="titlebar-icon">&#129504;</span>
      <span class="titlebar-label">OpenBrain Recorder</span>
    </div>
    <div class="titlebar-buttons">
      <div class="titlebar-btn close" id="closeBtn" title="Stop & Transcribe"></div>
    </div>
  </div>
  <div class="body">
    <div class="rec-dot">
      <div class="rec-dot-inner"></div>
    </div>
    <div class="display">
      <div class="display-top">
        <span class="timer" id="timer">0:00</span>
        <span class="meta" id="meta"></span>
      </div>
      <svg class="waveform" viewBox="0 0 160 16" preserveAspectRatio="none">
        <polyline class="wave-line" id="waveLine" points="0,8 160,8"/>
      </svg>
    </div>
    <div class="stop-btn" id="stopBtn" title="Stop">
      <div class="stop-icon"></div>
    </div>
  </div>
</div>

<script>
  const { ipcRenderer } = require('electron');

  // --- State ---
  let mediaRecorder = null;
  let analyser = null;
  let audioCtx = null;
  let stream = null;
  let chunks = [];
  let duration = 0;
  let segmentElapsed = 0;
  let segmentCount = 0;
  let timerInterval = null;
  let animFrame = 0;
  let segmentDuration = 300;
  let deviceId = '';
  let mimeType = 'audio/webm';

  // --- DOM refs ---
  const timerEl = document.getElementById('timer');
  const metaEl = document.getElementById('meta');
  const waveLine = document.getElementById('waveLine');
  const recorderEl = document.getElementById('recorder');

  // --- Init: receive config from main plugin ---
  ipcRenderer.on('recorder:config', (_e, config) => {
    segmentDuration = config.segmentDuration || 300;
    deviceId = config.deviceId || '';
    startRecording();
  });

  // --- Recording ---
  async function startRecording() {
    try {
      const constraints = deviceId
        ? { audio: { deviceId: { exact: deviceId } } }
        : { audio: true };

      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        if (deviceId) {
          console.warn('Device unavailable, falling back to default mic');
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw err;
        }
      }

      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      startMediaRecorder();
      startTimer();
      updateWaveform();
    } catch (err) {
      ipcRenderer.send('recorder:error', { message: err.message });
    }
  }

  function startMediaRecorder() {
    chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.start(250);
  }

  function finalizeSegment() {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        resolve(new Blob([], { type: mimeType }));
        return;
      }
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        chunks = [];
        resolve(blob);
      };
      mediaRecorder.stop();
    });
  }

  async function rotateSegment() {
    const blob = await finalizeSegment();
    if (blob.size > 0) {
      segmentCount++;
      updateMeta();

      // Convert blob to WAV buffer and send via IPC
      const wavBuffer = await blobToWavBuffer(blob);
      ipcRenderer.send('recorder:segment-ready', {
        index: segmentCount,
        wavBuffer: wavBuffer,
        duration: segmentElapsed,
      });
    }

    // Restart recorder on same stream
    if (stream && stream.active) {
      segmentElapsed = 0;
      startMediaRecorder();
    }
  }

  // --- WAV conversion (same logic as audioConverter.ts) ---
  async function blobToWavBuffer(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const tempCtx = new OfflineAudioContext(1, 1, 16000);
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

    // Resample to 16kHz mono
    const targetRate = 16000;
    const numSamples = Math.ceil(audioBuffer.duration * targetRate);
    const offlineCtx = new OfflineAudioContext(1, numSamples, targetRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    const samples = rendered.getChannelData(0);

    // Encode as 16-bit PCM WAV
    const bytesPerSample = 2;
    const dataSize = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    let o = 0;

    // RIFF header
    writeString(view, o, 'RIFF'); o += 4;
    view.setUint32(o, 36 + dataSize, true); o += 4;
    writeString(view, o, 'WAVE'); o += 4;
    writeString(view, o, 'fmt '); o += 4;
    view.setUint32(o, 16, true); o += 4;
    view.setUint16(o, 1, true); o += 2;
    view.setUint16(o, 1, true); o += 2;
    view.setUint32(o, targetRate, true); o += 4;
    view.setUint32(o, targetRate * bytesPerSample, true); o += 4;
    view.setUint16(o, bytesPerSample, true); o += 2;
    view.setUint16(o, 16, true); o += 2;
    writeString(view, o, 'data'); o += 4;
    view.setUint32(o, dataSize, true); o += 4;

    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }

    return buffer;
  }

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // --- Timer ---
  function startTimer() {
    timerInterval = setInterval(() => {
      duration++;
      segmentElapsed++;
      updateTimerDisplay();

      if (segmentElapsed >= segmentDuration) {
        rotateSegment();
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const m = Math.floor(duration / 60);
    const s = duration % 60;
    timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }

  function updateMeta() {
    metaEl.textContent = segmentCount > 0 ? `SEG ${segmentCount + 1}` : '';
  }

  // --- Waveform ---
  function updateWaveform() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);

    const points = 40;
    const step = Math.floor(data.length / points);
    let polyline = '';

    for (let i = 0; i < points; i++) {
      const x = (i / (points - 1)) * 160;
      const val = data[i * step] / 128 - 1;
      const amp = Math.min(Math.abs(val) * 48, 7);
      const y = 8 - amp;
      polyline += `${x},${y} `;
    }

    waveLine.setAttribute('points', polyline.trim());
    animFrame = requestAnimationFrame(updateWaveform);
  }

  // --- Stop ---
  async function stopRecording() {
    clearInterval(timerInterval);
    cancelAnimationFrame(animFrame);

    // Enter transcribing state
    recorderEl.classList.add('state-transcribing');
    timerEl.textContent = 'Transcribing...';

    // Finalize last segment
    const blob = await finalizeSegment();
    if (blob.size > 0) {
      segmentCount++;
      const wavBuffer = await blobToWavBuffer(blob);
      ipcRenderer.send('recorder:segment-ready', {
        index: segmentCount,
        wavBuffer: wavBuffer,
        duration: segmentElapsed,
      });
    }

    // Stop all tracks
    if (stream) stream.getTracks().forEach((t) => t.stop());

    ipcRenderer.send('recorder:stop', { totalDuration: duration, totalSegments: segmentCount });
  }

  // --- IPC from main ---
  ipcRenderer.on('recorder:done', () => {
    // Brief flash, then close
    timerEl.textContent = 'Done';
    setTimeout(() => window.close(), 1000);
  });

  // --- IPC: hotkey stop from main plugin ---
  ipcRenderer.on('recorder:request-stop', () => {
    stopRecording();
  });

  // --- Button handlers ---
  document.getElementById('stopBtn').addEventListener('click', stopRecording);
  document.getElementById('closeBtn').addEventListener('click', stopRecording);

  // --- Window position tracking (on drag end, not mousemove) ---
  const currentWindow = require('electron').remote.getCurrentWindow();
  currentWindow.on('moved', () => {
    const [x, y] = currentWindow.getPosition();
    ipcRenderer.send('recorder:position-changed', { x, y });
  });
</script>
</body>
</html>
```

- [ ] **Step 2: Build to verify no syntax errors**

Run: `npm run build`
Expected: Build succeeds (HTML file will be bundled in Task 7).

- [ ] **Step 3: Commit**

```bash
git add src/floatingRecorder.html
git commit -m "feat(floating-recorder): Blue Steel Winamp skin with local recording and waveform"
```

---

### Task 5: Floating Recorder Window Manager — `floatingRecorder.ts`

**Files:**
- Create: `src/floatingRecorder.ts`

- [ ] **Step 1: Implement floatingRecorder.ts**

Create `src/floatingRecorder.ts`:

```typescript
import { App, Notice } from "obsidian";
import { join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import { OpenBrainSettings } from "./settings";
import {
  createSession,
  addSegment,
  assembleTranscription,
  markCompleted,
  findIncompleteSessions,
  readSession,
  cleanupOldSegments,
} from "./diskRecorder";
import { transcribeSegment, transcribeAllPending, TranscribeFn } from "./progressiveTranscriber";

// Electron access via remote — may not be available in all environments
let BrowserWindow: any;
let globalShortcut: any;
let screen: any;

try {
  const remote = require("electron").remote;
  BrowserWindow = remote.BrowserWindow;
  globalShortcut = remote.globalShortcut;
  screen = remote.screen;
} catch {
  // Electron remote not available — floating recorder will be disabled
}

function getRecordingsDir(settings: OpenBrainSettings): string {
  const sttHome = settings.sttHomePath?.trim() || join(homedir(), ".openbrain");
  return join(sttHome, "recordings");
}

export class FloatingRecorder {
  private app: App;
  private settings: OpenBrainSettings;
  private window: any = null;
  private sessionDir: string | null = null;
  private pendingTranscriptions: Promise<void>[] = [];

  constructor(app: App, settings: OpenBrainSettings) {
    this.app = app;
    this.settings = settings;
  }

  get isAvailable(): boolean {
    return !!BrowserWindow;
  }

  get isRecording(): boolean {
    return this.window !== null;
  }

  registerHotkey(): void {
    if (!globalShortcut) return;

    const hotkey = this.settings.floatingRecorderHotkey || "Alt+V";
    try {
      globalShortcut.register(hotkey, () => {
        void this.toggle();
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[OpenBrain] Failed to register global hotkey "${hotkey}": ${message}`);
    }
  }

  unregisterHotkey(): void {
    if (!globalShortcut) return;
    const hotkey = this.settings.floatingRecorderHotkey || "Alt+V";
    try {
      globalShortcut.unregister(hotkey);
    } catch { /* may not be registered */ }
  }

  async toggle(): Promise<void> {
    if (this.window) {
      // Stop recording — the overlay will send segments and stop signal
      this.window.webContents.send("recorder:request-stop");
    } else {
      await this.start();
    }
  }

  private async start(): Promise<void> {
    if (!BrowserWindow) {
      new Notice("Floating recorder is not available (Electron remote not found).");
      return;
    }

    // Create session directory
    const baseDir = getRecordingsDir(this.settings);
    await mkdir(baseDir, { recursive: true });
    const session = await createSession(baseDir, this.settings.floatingRecorderSegmentDuration);
    this.sessionDir = session.dir;

    // Calculate window position
    const pos = this.getWindowPosition();

    // Create BrowserWindow
    const htmlPath = join(
      (this.app as any).vault.adapter.basePath,
      ".obsidian",
      "plugins",
      "obsidian-open-brain",
      "floatingRecorder.html"
    );

    this.window = new BrowserWindow({
      width: 360,
      height: 68,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    this.window.loadFile(htmlPath);

    // Send config once loaded
    this.window.webContents.on("did-finish-load", () => {
      this.window.webContents.send("recorder:config", {
        segmentDuration: this.settings.floatingRecorderSegmentDuration,
        deviceId: this.settings.audioDeviceId,
      });
    });

    // Handle IPC from overlay — use ipcMain.once-style cleanup to prevent listener leaks
    const { ipcMain } = require("electron");

    // Remove any stale listeners from a previous session before registering new ones
    ipcMain.removeAllListeners("recorder:segment-ready");
    ipcMain.removeAllListeners("recorder:stop");
    ipcMain.removeAllListeners("recorder:position-changed");
    ipcMain.removeAllListeners("recorder:error");

    ipcMain.on("recorder:segment-ready", (_e: any, data: any) => {
      if (!this.sessionDir) return;
      const wavBuffer = Buffer.from(data.wavBuffer);
      const dir = this.sessionDir;

      const work = (async () => {
        const filename = await addSegment(dir, wavBuffer, data.duration);
        const session = await readSession(dir);
        const segIndex = session.segments.length - 1;

        // Progressive transcription
        const transcribeFn = this.getTranscribeFn();
        await transcribeSegment(dir, segIndex, transcribeFn);
      })();

      this.pendingTranscriptions.push(work);
    });

    ipcMain.on("recorder:stop", async (_e: any, data: any) => {
      if (!this.sessionDir) return;

      // Wait for all pending transcriptions
      await Promise.allSettled(this.pendingTranscriptions);
      this.pendingTranscriptions = [];

      // Assemble final note
      await this.createVaultNote(data.totalDuration);

      // Mark session complete
      await markCompleted(this.sessionDir);

      // Clean up old WAV files based on retention setting
      const baseDir = getRecordingsDir(this.settings);
      void cleanupOldSegments(baseDir, this.settings.floatingRecorderRetentionDays);

      // Signal overlay to close
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("recorder:done");
      }

      // Cleanup after delay
      setTimeout(() => this.cleanup(), 1500);
    });

    ipcMain.on("recorder:position-changed", (_e: any, pos: any) => {
      this.settings.floatingRecorderPosition = { x: pos.x, y: pos.y };
    });

    ipcMain.on("recorder:error", (_e: any, data: any) => {
      new Notice(`Recording error: ${data.message}`);
      this.cleanup();
    });

    this.window.on("closed", () => {
      this.window = null;
    });
  }

  private getWindowPosition(): { x: number; y: number } {
    if (
      this.settings.floatingRecorderPosition !== "auto" &&
      typeof this.settings.floatingRecorderPosition === "object"
    ) {
      return this.settings.floatingRecorderPosition;
    }

    // Default: bottom-center, 60px above dock
    if (screen) {
      const display = screen.getPrimaryDisplay();
      const { width, height } = display.workAreaSize;
      return {
        x: Math.round((width - 360) / 2),
        y: height - 68 - 60,
      };
    }

    return { x: 500, y: 800 };
  }

  private getTranscribeFn(): TranscribeFn {
    // The WAV file on disk is already 16kHz mono PCM.
    // For local STT: stt.transcribeBlob handles the sherpa-onnx pipeline (accepts WAV blobs).
    // For API STT: claude.transcribeAudioSegments has a streaming interface, so we wrap
    //   it into a simple Promise<{text, durationMs}> by collecting chunks.
    return async (wavPath: string) => {
      const { readFile } = await import("fs/promises");
      const wavBuffer = await readFile(wavPath);
      const blob = new Blob([wavBuffer], { type: "audio/wav" });
      const start = Date.now();

      if (this.settings.useLocalStt) {
        const { transcribeBlob } = await import("./stt");
        return transcribeBlob(blob, this.settings);
      } else {
        // Wrap the streaming API transcriber into a simple promise
        const { transcribeAudioSegments } = await import("./claude");
        return new Promise<{ text: string; durationMs: number }>((resolve, reject) => {
          let text = "";
          void transcribeAudioSegments(this.settings, {
            segments: [blob],
            systemPrompt: "Transcribe this audio accurately. Return only the transcription text.",
            onChunk: (chunk) => { text += chunk; },
            onProgress: () => {},
            onDone: () => resolve({ text: text.trim(), durationMs: Date.now() - start }),
            onError: (err) => reject(new Error(err)),
          });
        });
      }
    };
  }

  private async createVaultNote(totalDuration: number): Promise<void> {
    if (!this.sessionDir) return;

    const text = await assembleTranscription(this.sessionDir);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = `${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
    const durationStr = formatDuration(totalDuration);

    const session = await readSession(this.sessionDir);
    const segmentCount = session.segments.length;

    const folder = this.settings.floatingRecorderOutputFolder || "OpenBrain/recordings";
    const filename = `${dateStr} Recording ${timeStr}`;
    const path = `${folder}/${filename}.md`;

    const content = [
      "---",
      "type: openbrain-recording",
      `date: ${dateStr}`,
      `duration: ${durationStr}`,
      `segments: ${segmentCount}`,
      "---",
      "",
      text,
      "",
    ].join("\n");

    // Ensure folder exists
    try {
      await this.app.vault.createFolder(folder);
    } catch { /* folder may exist */ }

    await this.app.vault.create(path, content);
    new Notice(`Recording saved: ${filename}`);
  }

  private cleanup(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
    this.sessionDir = null;
    this.pendingTranscriptions = [];

    // Remove IPC listeners
    try {
      const { ipcMain } = require("electron");
      ipcMain.removeAllListeners("recorder:segment-ready");
      ipcMain.removeAllListeners("recorder:stop");
      ipcMain.removeAllListeners("recorder:position-changed");
      ipcMain.removeAllListeners("recorder:error");
    } catch { /* may not be available */ }
  }

  /**
   * Scan for incomplete recording sessions from previous crashes and recover them.
   */
  async recoverIncompleteSessions(): Promise<void> {
    const baseDir = getRecordingsDir(this.settings);
    try {
      const incomplete = await findIncompleteSessions(baseDir);
      if (incomplete.length === 0) return;

      const transcribeFn = this.getTranscribeFn();

      for (const dir of incomplete) {
        try {
          await transcribeAllPending(dir, transcribeFn);
          const session = await readSession(dir);
          const totalDuration = session.segments.reduce((sum, s) => sum + s.duration, 0);

          // Temporarily set sessionDir for createVaultNote
          this.sessionDir = dir;
          await this.createVaultNote(totalDuration);
          await markCompleted(dir);
          this.sessionDir = null;

          const dateStr = session.startedAt.slice(0, 10);
          new Notice(`Recovered recording from ${dateStr} — created note`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[OpenBrain] Failed to recover session in ${dir}: ${message}`);
        }
      }
      // Clean up old WAV files based on retention setting
      await cleanupOldSegments(baseDir, this.settings.floatingRecorderRetentionDays);
    } catch {
      // recordings directory may not exist yet
    }
  }

  destroy(): void {
    this.unregisterHotkey();
    this.cleanup();
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
```

- [ ] **Step 2: Build to verify types**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/floatingRecorder.ts
git commit -m "feat(floating-recorder): window manager with Electron BrowserWindow, IPC, and session orchestration"
```

---

### Task 6: Wire Into Plugin — Modify `main.ts`

**Files:**
- Modify: `src/main.ts:1-15` (imports)
- Modify: `src/main.ts:16-22` (class properties)
- Modify: `src/main.ts:24-287` (onload)
- Modify: `src/main.ts:398-401` (onunload)

- [ ] **Step 1: Add import and property**

In `src/main.ts`, add import after line 14:

```typescript
import { FloatingRecorder } from "./floatingRecorder";
```

Add property to `OpenBrainPlugin` class after `private scheduler` (line 22):

```typescript
  private floatingRecorder: FloatingRecorder | null = null;
```

- [ ] **Step 2: Initialize floating recorder in onload**

In the `this.app.workspace.onLayoutReady` callback (after the notification checks around line 58), add:

```typescript
      // Initialize floating recorder
      this.floatingRecorder = new FloatingRecorder(this.app, this.settings);
      if (this.floatingRecorder.isAvailable) {
        this.floatingRecorder.registerHotkey();
        void this.floatingRecorder.recoverIncompleteSessions();
      }
```

- [ ] **Step 3: Add toggle-floating-recorder command**

After the existing `search-chats` command (after line 226), add:

```typescript
    this.addCommand({
      id: "toggle-floating-recorder",
      name: "Toggle floating recorder",
      icon: "mic",
      callback: () => {
        if (this.floatingRecorder?.isAvailable) {
          void this.floatingRecorder.toggle();
        } else {
          new Notice("Floating recorder is not available (requires Electron).");
        }
      },
    });
```

- [ ] **Step 4: Clean up in onunload**

In `onunload()` (line 398), add before the closing brace:

```typescript
    this.floatingRecorder?.destroy();
```

- [ ] **Step 5: Build to verify**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Manual test**

1. Open Obsidian with the plugin loaded
2. Check Settings > OpenBrain > Floating Recorder section appears
3. Press the configured hotkey (default Alt+V) — floating window should appear
4. Speak for ~10 seconds, press hotkey again or click stop
5. Check that a note appears in `OpenBrain/recordings/`
6. Check `~/.openbrain/recordings/` for session files

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat(floating-recorder): wire into plugin lifecycle with hotkey, command, and crash recovery"
```

---

### Task 7: Build Config & Bundling

**Files:**
- Modify: `esbuild.config.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Update esbuild config to copy HTML**

In `esbuild.config.mjs`, add the `copyFileSync` import at line 1 and add the copy step after the `context` creation:

```javascript
import { copyFileSync } from "fs";
```

After `});` that closes the `esbuild.context({...})` call, add:

```javascript
// Copy floating recorder HTML alongside the bundle
try {
  copyFileSync("src/floatingRecorder.html", "floatingRecorder.html");
} catch { /* file may not exist yet */ }
```

- [ ] **Step 2: Add floatingRecorder.html to gitignore**

The built copy in the root should be ignored (same as `main.js`). Add to `.gitignore` under `# Build output`:

```
floatingRecorder.html
```

Note: the source at `src/floatingRecorder.html` is tracked; only the root copy is ignored.

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Build succeeds, `floatingRecorder.html` exists at repo root alongside `main.js`.

- [ ] **Step 4: Commit**

```bash
git add esbuild.config.mjs .gitignore
git commit -m "build: copy floating recorder HTML to output alongside main.js"
```

---

### Task 8: Integration Test — End-to-End Session

**Files:**
- Create: `src/__tests__/floatingRecorderIntegration.test.ts`

- [ ] **Step 1: Write integration test for full session lifecycle**

Create `src/__tests__/floatingRecorderIntegration.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createSession,
  addSegment,
  readSession,
  assembleTranscription,
  markCompleted,
  findIncompleteSessions,
} from "../diskRecorder";
import { transcribeAllPending } from "../progressiveTranscriber";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ob-integration-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("floating recorder integration", () => {
  it("simulates a full recording session: create -> segments -> transcribe -> assemble", async () => {
    // 1. Start session
    const session = await createSession(testDir, 300);
    expect(session.status).toBe("recording");

    // 2. Add 3 segments (simulating 5-min chunks)
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 142);

    // Verify files on disk
    const files = await readdir(session.dir);
    expect(files).toContain("session.json");
    expect(files).toContain("segment-001.wav");
    expect(files).toContain("segment-002.wav");
    expect(files).toContain("segment-003.wav");

    // 3. Transcribe all segments
    let callCount = 0;
    const mockTranscribe = vi.fn().mockImplementation(async () => {
      callCount++;
      return { text: `Transcription for segment ${callCount}.`, durationMs: 50 };
    });

    await transcribeAllPending(session.dir, mockTranscribe);
    expect(mockTranscribe).toHaveBeenCalledTimes(3);

    // 4. Assemble
    const fullText = await assembleTranscription(session.dir);
    expect(fullText).toBe(
      "Transcription for segment 1.\n\n" +
      "Transcription for segment 2.\n\n" +
      "Transcription for segment 3."
    );

    // 5. Mark complete
    await markCompleted(session.dir);
    const final = await readSession(session.dir);
    expect(final.status).toBe("completed");
  });

  it("recovers incomplete session on restart", async () => {
    // Simulate a crash: session created with segments but not completed
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 200);

    // Verify it shows as incomplete
    const incomplete = await findIncompleteSessions(testDir);
    expect(incomplete).toHaveLength(1);

    // Recover
    const mockTranscribe = vi.fn().mockResolvedValue({ text: "Recovered text.", durationMs: 50 });
    await transcribeAllPending(session.dir, mockTranscribe);

    const text = await assembleTranscription(session.dir);
    expect(text).toBe("Recovered text.\n\nRecovered text.");

    await markCompleted(session.dir);

    // Now should not show as incomplete
    const stillIncomplete = await findIncompleteSessions(testDir);
    expect(stillIncomplete).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run src/__tests__/floatingRecorderIntegration.test.ts`
Expected: All tests PASS.

- [ ] **Step 3: Run full test suite**

Run: `npm run test`
Expected: All tests PASS (existing + new).

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/floatingRecorderIntegration.test.ts
git commit -m "test(floating-recorder): integration test for full session lifecycle and crash recovery"
```

---

### Task 9: Final Build & Verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 2: Run all tests**

Run: `npm run test`
Expected: All tests PASS.

- [ ] **Step 3: Verify output files**

Check that both `main.js` and `floatingRecorder.html` exist at the repo root:

```bash
ls -la main.js floatingRecorder.html
```

- [ ] **Step 4: Final commit with all changes**

```bash
git status
```

If any unstaged changes remain, stage and commit them.
