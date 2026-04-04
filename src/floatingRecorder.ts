import { App, Notice } from "obsidian";
import { join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import { OpenBrainSettings } from "./settings";
import {
  createSession,
  assembleTranscription,
  markCompleted,
  findIncompleteSessions,
  readSession,
  cleanupOldSegments,
} from "./diskRecorder";
import { transcribeAllPending, TranscribeFn } from "./progressiveTranscriber";

// Electron access via remote — may not be available in all environments
let BrowserWindow: any;
let globalShortcut: any;
let electronScreen: any;
let remote: any;

try {
  remote = require("electron").remote;
  BrowserWindow = remote.BrowserWindow;
  globalShortcut = remote.globalShortcut;
  electronScreen = remote.screen;
} catch {
  // Electron remote not available — floating recorder will be disabled
}

function getRecordingsDir(): string {
  return join(homedir(), ".openbrain", "recordings");
}

export interface SkillInfo {
  id: string;
  name: string;
  input: string;
}

export class FloatingRecorder {
  private app: App;
  private settings: OpenBrainSettings;
  private window: any = null;
  private sessionDir: string | null = null;
  /** Provides the current skill list. Called when the overlay opens. */
  getSkills: (() => SkillInfo[]) | null = null;

  /** Called after a recording is transcribed and saved as a note. Receives the vault note path and optional skill ID. */
  onRecordingComplete: ((notePath: string, skillId?: string) => void) | null = null;
  /** Called when transcription is copied to clipboard (no note created). */
  onClipboardCopy: (() => void) | null = null;
  /** Called when processing status changes (for UI feedback). Null clears the status. */
  onStatusChange: ((status: string | null) => void) | null = null;

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
    if (!globalShortcut || !this.settings.floatingRecorderEnabled) return;

    const hotkey = this.settings.floatingRecorderHotkey?.trim();
    if (!hotkey) return;

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
    const hotkey = this.settings.floatingRecorderHotkey?.trim();
    if (!hotkey) return;
    try {
      globalShortcut.unregister(hotkey);
    } catch { /* may not be registered */ }
  }

  async toggle(): Promise<void> {
    if (!this.settings.floatingRecorderEnabled) {
      new Notice("Floating recorder is disabled. Enable it in Settings > OpenBrain.");
      return;
    }
    if (this.window) {
      // Send stop signal to overlay — it will save segments and close itself
      try {
        if (!this.window.isDestroyed()) {
          this.window.webContents.send("recorder:request-stop");
          // Fallback: if overlay doesn't close within 3 seconds, force it
          setTimeout(() => {
            if (this.window && !this.window.isDestroyed()) {
              this.window.close();
            }
          }, 3000);
        }
      } catch {
        // Remote proxy may be stale — force cleanup
        try { this.window.close(); } catch { /* already gone */ }
        this.window = null;
      }
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
    const baseDir = getRecordingsDir();
    await mkdir(baseDir, { recursive: true });
    const session = await createSession(baseDir, this.settings.floatingRecorderSegmentDuration);
    this.sessionDir = session.dir;

    const pos = this.getWindowPosition();

    const htmlPath = join(
      (this.app as any).vault.adapter.basePath,
      ".obsidian",
      "plugins",
      "open-brain",
      "floatingRecorder.html"
    );

    // Use the same session as Obsidian's main window so mic permissions are inherited
    const obsidianSession = remote.getCurrentWindow().webContents.session;

    this.window = new BrowserWindow({
      width: 360,
      height: 280,
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
        session: obsidianSession,
      },
    });

    // Auto-grant media permissions (mic) for this window
    this.window.webContents.session.setPermissionRequestHandler(
      (_webContents: any, permission: string, callback: (granted: boolean) => void) => {
        if (permission === "media") {
          callback(true);
        } else {
          callback(false);
        }
      }
    );

    this.window.loadFile(htmlPath);

    // Send config with session directory — overlay writes segments directly to disk
    this.window.webContents.on("did-finish-load", () => {
      this.window.webContents.send("recorder:config", {
        segmentDuration: this.settings.floatingRecorderSegmentDuration,
        deviceId: this.settings.audioDeviceId,
        sessionDir: this.sessionDir,
        skills: this.getSkills?.() || [],
        defaultMode: this.settings.floatingRecorderDefaultMode || "clipboard",
        theme: this.readObsidianTheme(),
      });
    });

    // Poll for window close — remote event listeners are unreliable
    // When the overlay closes itself, we detect it here and process the session
    const obsidianWindow = remote.getCurrentWindow();
    let onFocus: (() => void) | null = null;
    let onBlur: (() => void) | null = null;

    const pollInterval = setInterval(() => {
      if (!this.window || this.window.isDestroyed()) {
        clearInterval(pollInterval);
        const dir = this.sessionDir;
        this.window = null;
        this.sessionDir = null;

        // Clean up focus/blur listeners
        if (onFocus) obsidianWindow.removeListener("focus", onFocus);
        if (onBlur) obsidianWindow.removeListener("blur", onBlur);

        if (dir) {
          void this.processSession(dir);
        }
      }
    }, 500);

    // Hide overlay when Obsidian is focused, show when blurred
    onFocus = () => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.hide();
      }
    };
    onBlur = () => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.showInactive();
      }
    };
    obsidianWindow.on("focus", onFocus);
    obsidianWindow.on("blur", onBlur);

    // Initially show only if Obsidian is not focused
    if (obsidianWindow.isFocused()) {
      this.window.hide();
    }
  }

  /**
   * Process a completed recording session — transcribe segments and create vault note.
   * Called after the overlay window closes.
   */
  private async processSession(dir: string): Promise<void> {
    try {
      const session = await readSession(dir) as any;
      if (session.segments.length === 0) return;

      const mode: string = session.mode || "clipboard";

      // Remember the user's choice for next time
      this.settings.floatingRecorderDefaultMode = mode;

      const segCount = session.segments.length;
      this.onStatusChange?.(`Transcribing ${segCount} segment${segCount > 1 ? "s" : ""}...`);

      const transcribeFn = this.getTranscribeFn();
      await transcribeAllPending(dir, transcribeFn);

      const text = await assembleTranscription(dir);

      if (mode === "clipboard") {
        // Clipboard mode — copy text, no note, no OpenBrain
        const { clipboard } = require("electron");
        clipboard.writeText(text);
        await markCompleted(dir);
        this.onStatusChange?.(null);
        new Notice("Recording transcribed — copied to clipboard");
        this.onClipboardCopy?.();
      } else {
        // Skill mode — create note and hand off to OpenBrain
        this.onStatusChange?.("Saving note...");

        const totalDuration = session.segments.reduce((sum: number, s: any) => sum + s.duration, 0);
        const notePath = await this.createVaultNote(dir, totalDuration);
        await markCompleted(dir);

        this.onStatusChange?.(null);

        if (notePath && this.onRecordingComplete) {
          this.onRecordingComplete(notePath, mode);
        }
      }

      const recBaseDir = getRecordingsDir();
      void cleanupOldSegments(recBaseDir, this.settings.floatingRecorderRetentionDays);
    } catch (err: unknown) {
      this.onStatusChange?.(null);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[OpenBrain] Failed to process recording session: ${message}`);
      new Notice(`Recording error: ${message}`);
    }
  }

  private getWindowPosition(): { x: number; y: number } {
    if (
      this.settings.floatingRecorderPosition !== "auto" &&
      typeof this.settings.floatingRecorderPosition === "object"
    ) {
      return this.settings.floatingRecorderPosition;
    }

    if (electronScreen) {
      const display = electronScreen.getPrimaryDisplay();
      const { width, height } = display.workAreaSize;
      return {
        x: Math.round((width - 360) / 2),
        y: height - 280 - 60,
      };
    }

    return { x: 500, y: 800 };
  }

  private getTranscribeFn(): TranscribeFn {
    return async (wavPath: string) => {
      try {
        const { transcribeWavFile } = await import("./stt");
        return transcribeWavFile(wavPath, this.settings);
      } catch {
        const { readFile } = await import("fs/promises");
        const wavBuffer = await readFile(wavPath);
        const blob = new Blob([wavBuffer], { type: "audio/wav" });
        const start = Date.now();
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

  private async createVaultNote(dir: string, totalDuration: number): Promise<string> {
    const text = await assembleTranscription(dir);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = `${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
    const durationStr = formatDuration(totalDuration);

    const session = await readSession(dir);
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

    try {
      await this.app.vault.createFolder(folder);
    } catch { /* folder may exist */ }

    await this.app.vault.create(path, content);
    new Notice(`Recording saved: ${filename}`);
    return path;
  }

  /** Read the active Obsidian theme's CSS variables to pass to the floating window. */
  private readObsidianTheme(): Record<string, string> {
    try {
      const body = document.body;
      const cs = getComputedStyle(body);
      return {
        accent: cs.getPropertyValue("--interactive-accent").trim(),
        textError: cs.getPropertyValue("--text-error").trim() || "#e44",
        textMuted: cs.getPropertyValue("--text-muted").trim(),
        bgSecondary: cs.getPropertyValue("--background-secondary").trim(),
        bgPrimary: cs.getPropertyValue("--background-primary").trim(),
        border: cs.getPropertyValue("--background-modifier-border").trim(),
      };
    } catch {
      return {};
    }
  }

  private cleanup(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
    this.sessionDir = null;
  }

  async recoverIncompleteSessions(): Promise<void> {
    const baseDir = getRecordingsDir();
    try {
      const incomplete = await findIncompleteSessions(baseDir);
      if (incomplete.length === 0) return;

      for (const dir of incomplete) {
        await this.processSession(dir);
      }
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
