import { spawn, execFile } from "child_process";
import { access, mkdir, chmod, copyFile as fsCopyFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createWriteStream } from "fs";
import { get as httpsGet } from "https";
import { blobToWav, writeTempWav, cleanupTempWav } from "./audioConverter";
import { OpenBrainSettings } from "./settings";

// --- Constants ---

const DEFAULT_HOME = join(homedir(), ".openbrain");

const SHERPA_VERSION = "1.10.39";
const SHERPA_TARBALL = `sherpa-onnx-v${SHERPA_VERSION}-osx-universal2-shared-no-tts.tar.bz2`;
const SHERPA_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/${SHERPA_TARBALL}`;

const MODEL_NAME = "parakeet-tdt-0.6b-v2-int8";
const MODEL_DISPLAY_NAME = "Parakeet TDT 0.6b-v2 (int8)";
const MODEL_TARBALL = `sherpa-onnx-nemo-${MODEL_NAME}.tar.bz2`;
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_TARBALL}`;

// --- Path helpers ---

export function getSttHomePath(settings: OpenBrainSettings): string {
  return settings.sttHomePath?.trim() || DEFAULT_HOME;
}

function getBinDir(settings: OpenBrainSettings): string {
  return join(getSttHomePath(settings), "bin");
}

function getLibDir(settings: OpenBrainSettings): string {
  return join(getSttHomePath(settings), "lib");
}

function getModelDir(settings: OpenBrainSettings): string {
  return join(getSttHomePath(settings), "models", MODEL_NAME);
}

function getModelFiles(settings: OpenBrainSettings) {
  const modelDir = getModelDir(settings);
  return {
    encoder: join(modelDir, "encoder.int8.onnx"),
    decoder: join(modelDir, "decoder.int8.onnx"),
    joiner: join(modelDir, "joiner.int8.onnx"),
    tokens: join(modelDir, "tokens.txt"),
  };
}

function getBinaryPath(settings: OpenBrainSettings): string {
  return join(getBinDir(settings), "sherpa-onnx-offline");
}

// --- Installation check ---

export interface SttStatus {
  binaryInstalled: boolean;
  modelInstalled: boolean;
  modelName: string;
  ready: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function checkSttInstallation(
  settings: OpenBrainSettings
): Promise<SttStatus> {
  const binaryInstalled = await fileExists(getBinaryPath(settings));

  const files = getModelFiles(settings);
  const modelInstalled = (
    await Promise.all(Object.values(files).map(fileExists))
  ).every(Boolean);

  return {
    binaryInstalled,
    modelInstalled,
    modelName: MODEL_DISPLAY_NAME,
    ready: binaryInstalled && modelInstalled,
  };
}

// --- Transcription ---

export interface TranscribeResult {
  text: string;
  durationMs: number;
}

/**
 * Transcribe a single audio blob using sherpa-onnx-offline.
 * Converts WebM/Opus → WAV → sherpa-onnx → text.
 */
export async function transcribeBlob(
  blob: Blob,
  settings: OpenBrainSettings
): Promise<TranscribeResult> {
  const start = Date.now();

  // Convert to WAV
  const wavBuffer = await blobToWav(blob);
  const wavPath = await writeTempWav(wavBuffer);

  // Save a debug copy for manual testing
  try {
    const debugDir = join(getSttHomePath(settings), "debug");
    await mkdir(debugDir, { recursive: true });
    const debugWavPath = join(debugDir, "last_recording.wav");
    await fsCopyFile(wavPath, debugWavPath);
  } catch (e: any) {
    console.warn(`[OpenBrain] failed to save debug WAV: ${e.message}`);
  }

  try {
    const text = await runSherpaOnnx(wavPath, settings);
    return {
      text: text.trim(),
      durationMs: Date.now() - start,
    };
  } finally {
    await cleanupTempWav(wavPath);
  }
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

/**
 * Spawn sherpa-onnx-offline and return the transcription text.
 * Follows the same child_process.spawn pattern as claude.ts.
 */
function runSherpaOnnx(
  wavPath: string,
  settings: OpenBrainSettings
): Promise<string> {
  return new Promise((resolve, reject) => {
    const binaryPath = getBinaryPath(settings);
    const libDir = getLibDir(settings);
    const files = getModelFiles(settings);

    const env = { ...process.env };
    // macOS: sherpa-onnx shared libs need to be found
    env.DYLD_LIBRARY_PATH = [libDir, env.DYLD_LIBRARY_PATH]
      .filter(Boolean)
      .join(":");
    // Linux: equivalent env var
    env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(":");

    const args = [
      "--feat-dim=128",
      `--encoder=${files.encoder}`,
      `--decoder=${files.decoder}`,
      `--joiner=${files.joiner}`,
      `--tokens=${files.tokens}`,
      "--model-type=nemo_transducer",
      wavPath,
    ];

    const proc = spawn(binaryPath, args, { env });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `sherpa-onnx exited with code ${code}: ${stderr.trim()}`
          )
        );
      } else {
        // sherpa-onnx writes ALL output to stderr (not stdout).
        // The transcription appears as a JSON line: {"text": "...", ...}
        // Parse stderr to find the JSON result line.
        const allOutput = stderr + "\n" + stdout;
        const transcription = parseSherpaOutput(allOutput);
        resolve(transcription);
      }
    });

    proc.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        reject(
          new Error(
            "sherpa-onnx binary not found. Install it via Settings > OpenBrain > Install, " +
              "or run: ~/.openbrain/setup.sh"
          )
        );
      } else {
        reject(new Error(`Failed to start sherpa-onnx: ${err.message}`));
      }
    });
  });
}

/**
 * Parse the combined output from sherpa-onnx to extract the transcription text.
 * sherpa-onnx writes ALL output to stderr, including the result as a JSON line:
 *   {"lang": "", "emotion": "", "event": "", "text": "transcription here", ...}
 * Falls back to the old "filename text" format for compatibility.
 */
function parseSherpaOutput(output: string): string {
  const lines = output.trim().split("\n");

  // Strategy 1: Find a JSON line with a "text" field
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"text"')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.text === "string") {
          return parsed.text.trim();
        }
      } catch {
        // Not valid JSON, continue
      }
    }
  }

  // Strategy 2: Look for "filename.wav transcription" format (older versions)
  for (const line of lines) {
    const match = line.match(/^.*\.wav\s+(.+)$/);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }

  // Strategy 3: Return empty (no transcription found)
  return "";
}

// --- In-plugin installer ---

export type InstallProgress = (message: string) => void;

/**
 * Download and install the sherpa-onnx binary and Parakeet model.
 * Reports progress via the onProgress callback.
 */
export async function installStt(
  settings: OpenBrainSettings,
  onProgress: InstallProgress
): Promise<void> {
  const home = getSttHomePath(settings);
  const binDir = getBinDir(settings);
  const libDir = getLibDir(settings);
  const modelDir = getModelDir(settings);

  // Create directories
  await mkdir(binDir, { recursive: true });
  await mkdir(libDir, { recursive: true });
  await mkdir(modelDir, { recursive: true });

  // Step 1: Download and extract sherpa-onnx binary
  const binaryPath = getBinaryPath(settings);
  if (!(await fileExists(binaryPath))) {
    onProgress("Downloading sherpa-onnx binary (~40MB)...");
    const tarPath = join(home, SHERPA_TARBALL);
    await downloadFile(SHERPA_URL, tarPath);

    onProgress("Extracting binary...");
    const extractedDir = `sherpa-onnx-v${SHERPA_VERSION}-osx-universal2-shared-no-tts`;
    await extractTarBz2(tarPath, home);

    // Copy bin and lib files
    const srcBin = join(home, extractedDir, "bin", "sherpa-onnx-offline");
    const srcLib = join(home, extractedDir, "lib");

    await copyFile(srcBin, binaryPath);
    await chmod(binaryPath, 0o755);

    // Copy all dylib files
    await copyGlob(srcLib, libDir, "*.dylib");

    // Cleanup extracted directory and tarball
    await rmrf(join(home, extractedDir));
    await rmrf(tarPath);

    onProgress("Binary installed ✓");
  } else {
    onProgress("Binary already installed ✓");
  }

  // Step 2: Download and extract model
  const modelFiles = getModelFiles(settings);
  if (!(await fileExists(modelFiles.encoder))) {
    onProgress("Downloading Parakeet model (~622MB)... this may take a few minutes");
    const tarPath = join(home, MODEL_TARBALL);
    await downloadFile(MODEL_URL, tarPath);

    onProgress("Extracting model...");
    const extractedDir = `sherpa-onnx-nemo-${MODEL_NAME}`;
    await extractTarBz2(tarPath, home);

    // Copy model files
    const srcModel = join(home, extractedDir);
    for (const ext of ["*.onnx", "tokens.txt"]) {
      await copyGlob(srcModel, modelDir, ext);
    }

    // Cleanup
    await rmrf(join(home, extractedDir));
    await rmrf(tarPath);

    onProgress("Model installed ✓");
  } else {
    onProgress("Model already installed ✓");
  }

  onProgress("Setup complete — ready to transcribe!");
}

// --- Download / file helpers ---

/**
 * Download a file from a URL, following redirects (GitHub releases redirect).
 */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);

    const request = (currentUrl: string) => {
      httpsGet(currentUrl, (response) => {
        // Follow redirects (GitHub releases use 302)
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          reject(
            new Error(`Download failed with status ${response.statusCode}`)
          );
          return;
        }

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }).on("error", (err) => {
        file.close();
        reject(new Error(`Download error: ${err.message}`));
      });
    };

    request(url);
  });
}

/**
 * Extract a .tar.bz2 file to a destination directory using the system tar command.
 */
function extractTarBz2(tarPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", ["xjf", tarPath, "-C", destDir], (err) => {
      if (err) {
        reject(new Error(`Extraction failed: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Copy a single file using cp.
 */
function copyFile(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("cp", [src, dest], (err) => {
      if (err) reject(new Error(`Copy failed: ${err.message}`));
      else resolve();
    });
  });
}

/**
 * Copy files matching a pattern from src dir to dest dir.
 */
function copyGlob(
  srcDir: string,
  destDir: string,
  pattern: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use shell to expand the glob
    const cmd = `cp ${srcDir}/${pattern} ${destDir}/ 2>/dev/null || true`;
    const proc = spawn("sh", ["-c", cmd]);
    proc.on("close", () => resolve());
    proc.on("error", (err) => reject(err));
  });
}

/**
 * Remove a file or directory recursively.
 */
function rmrf(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("rm", ["-rf", path], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
