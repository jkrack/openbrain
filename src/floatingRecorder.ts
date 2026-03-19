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

    const hotkey = this.settings.floatingRecorderHotkey?.trim();
    if (!hotkey) return; // No global hotkey configured — user relies on Obsidian command

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
    if (this.window) {
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

    const baseDir = getRecordingsDir(this.settings);
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

    this.window.webContents.on("did-finish-load", () => {
      this.window.webContents.send("recorder:config", {
        segmentDuration: this.settings.floatingRecorderSegmentDuration,
        deviceId: this.settings.audioDeviceId,
      });
    });

    const { ipcMain } = require("electron");

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

        const transcribeFn = this.getTranscribeFn();
        await transcribeSegment(dir, segIndex, transcribeFn);
      })();

      this.pendingTranscriptions.push(work);
    });

    ipcMain.on("recorder:stop", async (_e: any, data: any) => {
      if (!this.sessionDir) return;
      const dir = this.sessionDir;

      // Close the overlay window immediately — don't make user wait
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("recorder:done");
      }
      setTimeout(() => this.cleanup(), 500);

      // Wait for pending transcriptions with a 30-second timeout
      if (this.pendingTranscriptions.length > 0) {
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30000));
        await Promise.race([
          Promise.allSettled(this.pendingTranscriptions),
          timeout,
        ]);
        this.pendingTranscriptions = [];
      }

      try {
        await this.createVaultNote(data.totalDuration);
        await markCompleted(dir);
        new Notice("Recording saved");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[OpenBrain] Failed to create recording note: ${message}`);
        new Notice(`Recording error: ${message}`);
      }

      const recBaseDir = getRecordingsDir(this.settings);
      void cleanupOldSegments(recBaseDir, this.settings.floatingRecorderRetentionDays);
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
    return async (wavPath: string) => {
      const { readFile } = await import("fs/promises");
      const wavBuffer = await readFile(wavPath);
      const blob = new Blob([wavBuffer], { type: "audio/wav" });
      const start = Date.now();

      if (this.settings.useLocalStt) {
        const { transcribeBlob } = await import("./stt");
        return transcribeBlob(blob, this.settings);
      } else {
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

    try {
      const { ipcMain } = require("electron");
      ipcMain.removeAllListeners("recorder:segment-ready");
      ipcMain.removeAllListeners("recorder:stop");
      ipcMain.removeAllListeners("recorder:position-changed");
      ipcMain.removeAllListeners("recorder:error");
    } catch { /* may not be available */ }
  }

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
