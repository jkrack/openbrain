// src/stt.ts — Daemon-based STT client
//
// Connects to the openbrain-stt daemon over a Unix socket.
// Falls back to Anthropic API transcription if daemon is unavailable.

import { join } from "path";
import { homedir } from "os";
import {
  sendRequest,
  isDaemonRunning,
  ensureDaemon as ensureDaemonClient,
  getDefaultBinaryPath,
  SttTranscribeResult,
} from "./sttClient";
import { OpenBrainSettings } from "./settings";

// --- Types (preserved for backward compatibility) ---

export interface SttStatus {
  binaryInstalled: boolean;
  modelInstalled: boolean;
  modelName: string;
  ready: boolean;
  daemonState?: string;
}

export interface TranscribeResult {
  text: string;
  durationMs: number;
  language?: string;
  words?: { word: string; start: number; end: number; confidence: number }[];
  processingMs?: number;
}

export type InstallProgress = (message: string) => void;

// --- Constants ---

const DEFAULT_HOME = join(homedir(), ".openbrain");

// --- Path helpers ---

export function getSttHomePath(settings: OpenBrainSettings): string {
  return DEFAULT_HOME;
}

function getBinaryPath(pluginDir?: string): string {
  if (pluginDir) return getDefaultBinaryPath(pluginDir);
  // Fallback: check standard locations
  return join(DEFAULT_HOME, "bin", "openbrain-stt");
}

// --- Installation check ---

export async function checkSttInstallation(
  settings: OpenBrainSettings
): Promise<SttStatus> {
  const running = await isDaemonRunning();

  if (running) {
    try {
      const status = await sendRequest({ type: "status", id: "check" }, 5000);
      if (status.type === "status") {
        return {
          binaryInstalled: true,
          modelInstalled: status.modelReady,
          modelName: "Parakeet TDT 0.6B v3",
          ready: status.modelReady,
          daemonState: status.state,
        };
      }
    } catch { /* fall through */ }
  }

  // Daemon not running — check if binary exists
  const binaryPath = getBinaryPath((settings as any).pluginDir);
  let binaryInstalled = false;
  try {
    const { access } = await import("fs/promises");
    await access(binaryPath);
    binaryInstalled = true;
  } catch { /* not installed */ }

  return {
    binaryInstalled,
    modelInstalled: false,  // Can't check without daemon
    modelName: "Parakeet TDT 0.6B v3",
    ready: false,
    daemonState: binaryInstalled ? "stopped" : "not-installed",
  };
}

// --- Transcription ---

/**
 * Transcribe a single audio blob.
 * Sends raw audio data to the daemon; throws if daemon unavailable
 * so callers can fall back to API transcription.
 */
export async function transcribeBlob(
  blob: Blob,
  settings: OpenBrainSettings
): Promise<TranscribeResult> {
  const start = Date.now();

  // Try daemon first
  const daemonReady = await ensureDaemonIfNeeded(settings);
  if (daemonReady) {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");

      const response = await sendRequest({
        type: "transcribe",
        audio: base64,
        audioFormat: detectFormat(blob.type),
        options: { timestamps: true, diarize: false, language: "auto" },
      });

      if (response.type === "result") {
        const r = response as SttTranscribeResult;
        return {
          text: r.text,
          durationMs: Date.now() - start,
          language: r.language,
          words: r.words,
          processingMs: r.processingMs,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[OpenBrain] Daemon transcription failed (${msg}), falling back to API`);
    }
  }

  // Fallback: throw so caller can use API path
  throw new Error("STT daemon not available — use API transcription");
}

/**
 * Transcribe a WAV file already on disk.
 */
export async function transcribeWavFile(
  wavPath: string,
  settings: OpenBrainSettings
): Promise<TranscribeResult> {
  const start = Date.now();

  const daemonReady = await ensureDaemonIfNeeded(settings);
  if (daemonReady) {
    try {
      const response = await sendRequest({
        type: "transcribe",
        audio: wavPath,
        audioFormat: "path",
        options: { timestamps: true, diarize: false, language: "auto" },
      });

      if (response.type === "result") {
        const r = response as SttTranscribeResult;
        return {
          text: r.text,
          durationMs: Date.now() - start,
          language: r.language,
          words: r.words,
          processingMs: r.processingMs,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[OpenBrain] Daemon transcription failed (${msg}), falling back to API`);
    }
  }

  throw new Error("STT daemon not available — use API transcription");
}

/**
 * Transcribe multiple audio segments sequentially.
 */
export async function transcribeSegments(
  segments: Blob[],
  settings: OpenBrainSettings,
  onProgress?: (current: number, total: number) => void
): Promise<TranscribeResult> {
  const start = Date.now();
  const transcriptions: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    onProgress?.(i + 1, segments.length);
    const result = await transcribeBlob(segments[i], settings);
    if (result.text) {
      transcriptions.push(result.text);
    }
  }

  return {
    text: transcriptions.join("\n\n"),
    durationMs: Date.now() - start,
  };
}

// --- Daemon management ---

export async function ensureDaemon(settings: OpenBrainSettings): Promise<boolean> {
  const binaryPath = getBinaryPath((settings as any).pluginDir);
  return ensureDaemonClient(binaryPath);
}

export async function installStt(
  settings: OpenBrainSettings,
  onProgress: InstallProgress
): Promise<void> {
  // The daemon handles its own model download.
  // "Install" means: ensure binary is available and start daemon.
  const binaryPath = getBinaryPath((settings as any).pluginDir);

  try {
    const { access } = await import("fs/promises");
    await access(binaryPath);
  } catch {
    onProgress("Binary not found. Download from GitHub releases or build from source.");
    throw new Error(
      "openbrain-stt binary not found at " + binaryPath +
      ". See docs for installation instructions."
    );
  }

  onProgress("Starting daemon...");
  const started = await ensureDaemon(settings);
  if (!started) {
    throw new Error("Failed to start openbrain-stt daemon");
  }

  onProgress("Daemon running. Model will download on first transcription request.");
}

// --- Helpers ---

async function ensureDaemonIfNeeded(settings: OpenBrainSettings): Promise<boolean> {
  if (await isDaemonRunning()) return true;
  try {
    return await ensureDaemon(settings);
  } catch {
    return false;
  }
}

function detectFormat(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "mp4";
  if (mimeType.includes("ogg") || mimeType.includes("opus")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";  // Default — most browsers produce WebM
}
