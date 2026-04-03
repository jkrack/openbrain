import { createConnection, Socket } from "net";
import { access, unlink } from "fs/promises";
import { spawn } from "child_process";
import { join } from "path";
import { homedir } from "os";

// --- Types ---

export interface SttRequest {
  type: "transcribe" | "status" | "shutdown";
  id: string;
  audio?: string;
  audioFormat?: string;
  sampleRate?: number;
  options?: {
    timestamps?: boolean;
    diarize?: boolean;
    language?: string;
  };
}

export interface SttTranscribeResult {
  type: "result";
  id: string;
  text: string;
  language?: string;
  duration?: number;
  words?: { word: string; start: number; end: number; confidence: number }[];
  processingMs: number;
}

export interface SttStatusResult {
  type: "status";
  id: string;
  state: "ready" | "loading" | "downloading" | "shutdown";
  model: string;
  modelReady: boolean;
  uptimeSeconds: number;
}

export interface SttErrorResult {
  type: "error";
  id: string;
  error: string;
}

type SttResponse = SttTranscribeResult | SttStatusResult | SttErrorResult;

// --- Socket path ---

const SOCKET_DIR = join(homedir(), ".openbrain");
const SOCKET_PATH = join(SOCKET_DIR, "stt.sock");

export function getSocketPath(): string {
  return SOCKET_PATH;
}

// --- Daemon status ---

export async function isDaemonRunning(): Promise<boolean> {
  try {
    await access(SOCKET_PATH);
  } catch {
    return false;
  }
  try {
    const result = await sendRequest({ type: "status", id: "ping" }, 2000);
    return result.type === "status";
  } catch {
    try {
      await unlink(SOCKET_PATH);
    } catch {
      /* ignore */
    }
    return false;
  }
}

// --- Send request ---

export function sendRequest(
  request: Omit<SttRequest, "id"> & { id?: string },
  timeoutMs: number = 120000
): Promise<SttResponse> {
  const req = { ...request, id: request.id || `req-${Date.now()}` };

  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(SOCKET_PATH);
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`STT daemon request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(JSON.stringify(req) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx);
        clearTimeout(timer);
        settled = true;
        socket.end();
        try {
          const response: SttResponse = JSON.parse(line);
          if (response.type === "error") {
            reject(new Error((response as SttErrorResult).error));
          } else {
            resolve(response);
          }
        } catch {
          reject(new Error(`Invalid JSON from daemon: ${line}`));
        }
      }
    });

    socket.on("error", (err) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(new Error(`STT daemon connection failed: ${err.message}`));
      }
    });
  });
}

// --- Daemon lifecycle ---

let daemonPid: number | null = null;

export async function ensureDaemon(binaryPath: string): Promise<boolean> {
  if (await isDaemonRunning()) return true;

  try {
    await access(binaryPath);
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    const proc = spawn(binaryPath, [], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    daemonPid = proc.pid ?? null;

    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      if (await isDaemonRunning()) {
        clearInterval(check);
        resolve(true);
      } else if (attempts > 100) {
        clearInterval(check);
        resolve(false);
      }
    }, 100);
  });
}

export async function shutdownDaemon(): Promise<void> {
  try {
    await sendRequest({ type: "shutdown", id: "shutdown" }, 5000);
  } catch {
    /* daemon may already be gone */
  }
  daemonPid = null;
}

export function getDefaultBinaryPath(pluginDir: string): string {
  return join(pluginDir, "bin", "openbrain-stt");
}
