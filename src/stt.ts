// src/stt.ts — Daemon-based STT client
//
// Connects to the openbrain-stt daemon over a Unix socket.
// Falls back to Anthropic API transcription if daemon is unavailable.

import { join, dirname } from "path";
import { homedir } from "os";
import {
  sendRequest,
  isDaemonRunning,
  ensureDaemon as ensureDaemonClient,
  getDefaultBinaryPath,
  SttTranscribeResult,
} from "./sttClient";
import { OpenBrainSettings } from "./settings";

const GITHUB_REPO = "jkrack/OpenBrain";

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
  const binaryPath = getBinaryPath((settings as any).pluginDir);

  // Check if binary already exists
  let binaryExists = false;
  try {
    const { access } = await import("fs/promises");
    await access(binaryPath);
    binaryExists = true;
  } catch { /* needs download */ }

  if (!binaryExists) {
    await downloadSttBinary(binaryPath, onProgress);
  }

  onProgress("Starting daemon...");
  const started = await ensureDaemon(settings);
  if (!started) {
    throw new Error("Failed to start openbrain-stt daemon");
  }

  onProgress("Daemon running. Model will download on first transcription request.");
}

/**
 * Download the STT daemon binary from the GitHub Release matching the current plugin version.
 */
async function downloadSttBinary(
  binaryPath: string,
  onProgress: InstallProgress
): Promise<void> {
  const { mkdir, writeFile, chmod, readFile } = await import("fs/promises");
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  // Read plugin version from manifest.json in the plugin directory
  let version: string;
  try {
    const pluginDir = dirname(dirname(binaryPath));
    const manifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
    version = manifest.version;
  } catch {
    version = "latest";
  }

  const tag = version === "latest" ? "latest" : `v${version}`;
  const assetName = "openbrain-stt-macos-arm64.zip";
  const downloadUrl = version === "latest"
    ? `https://github.com/${GITHUB_REPO}/releases/latest/download/${assetName}`
    : `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${assetName}`;

  onProgress(`Downloading STT daemon (${tag})...`);

  // Download the zip using Node https with redirect following
  const https = await import("https");
  const http = await import("http");

  const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
    const follow = (url: string, redirects = 0) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const mod = url.startsWith("https") ? https : http;
      mod.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    };
    follow(downloadUrl);
  });

  onProgress("Extracting binary...");

  // Write zip to temp file, extract with system unzip (always available on macOS)
  const tmpDir = join(homedir(), ".openbrain", "tmp");
  const zipPath = join(tmpDir, assetName);
  await mkdir(tmpDir, { recursive: true });
  await writeFile(zipPath, zipBuffer);

  await mkdir(dirname(binaryPath), { recursive: true });
  await execFileAsync("unzip", ["-o", zipPath, "-d", dirname(binaryPath)]);

  // The zip contains openbrain-stt-macos-arm64 — rename to openbrain-stt
  const extractedName = join(dirname(binaryPath), "openbrain-stt-macos-arm64");
  const { rename, unlink } = await import("fs/promises");
  try {
    await rename(extractedName, binaryPath);
  } catch {
    // Already named correctly or same path
  }
  await chmod(binaryPath, 0o755);

  // Clean up temp files
  try { await unlink(zipPath); } catch { /* ignore */ }

  onProgress("STT daemon installed.");
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
