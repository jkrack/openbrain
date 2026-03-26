import { join } from "path";
import { homedir } from "os";
import { execFile } from "child_process";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface DownloadProgress {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

export interface EmbeddingEngine {
  init(modelId: string): Promise<void>;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  isReady(): boolean;
  getDimensions(): number;
  destroy(): void;
  onDownloadProgress: ((progress: DownloadProgress) => void) | null;
}

export function getModelCacheDir(): string {
  return join(homedir(), ".openbrain", "models", "embed");
}

/**
 * Pre-download model files from HuggingFace using curl.
 * curl on macOS uses SecureTransport which trusts the system Keychain,
 * so it works on corporate networks with custom CA certificates.
 */
async function predownloadModelFiles(
  modelId: string,
  onProgress: (p: DownloadProgress) => void
): Promise<Map<string, ArrayBuffer>> {
  const cacheDir = getModelCacheDir();
  const modelDir = join(cacheDir, modelId.replace("/", "__"));
  const baseUrl = `https://huggingface.co/${modelId}/resolve/main`;

  // Files needed by Transformers.js for feature-extraction pipeline
  const requiredFiles = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
  ];
  const optionalFiles = [
    "special_tokens_map.json",
    "preprocessor_config.json",
  ];
  // Try multiple ONNX filename patterns — models vary
  const onnxCandidates = [
    "onnx/model.onnx",
    "onnx/model_fp32.onnx",
    "onnx/model_quantized.onnx",
  ];

  const downloadFile = (file: string, required: boolean): Promise<boolean> => {
    const localPath = join(modelDir, file);
    if (existsSync(localPath)) return Promise.resolve(true);

    const dir = dirname(localPath);
    mkdirSync(dir, { recursive: true });

    return new Promise((resolve) => {
      onProgress({ status: "download", file: file.split("/").pop() });
      execFile("curl", ["-fSL", "-o", localPath, `${baseUrl}/${file}`],
        { timeout: 300000 }, (err) => {
          if (err) {
            if (required) {
              console.error(`[OpenBrain] Failed to download ${file}: ${err.message}`);
            }
            resolve(false);
          } else {
            resolve(true);
          }
        });
    });
  };

  // Download required files
  for (const file of requiredFiles) {
    const ok = await downloadFile(file, true);
    if (!ok) throw new Error(`Failed to download required model file: ${file}`);
  }

  // Download optional files (ignore failures)
  for (const file of optionalFiles) {
    await downloadFile(file, false);
  }

  // Download ONNX model — try each candidate until one works
  let onnxFound = false;
  for (const candidate of onnxCandidates) {
    if (await downloadFile(candidate, false)) {
      onnxFound = true;
      break;
    }
  }
  if (!onnxFound) {
    throw new Error("Failed to download ONNX model file — tried: " + onnxCandidates.join(", "));
  }

  // Read all downloaded files into memory
  const files = new Map<string, ArrayBuffer>();
  const allCandidates = [...requiredFiles, ...optionalFiles, ...onnxCandidates];
  for (const file of allCandidates) {
    const localPath = join(modelDir, file);
    if (existsSync(localPath)) {
      const buf = readFileSync(localPath);
      files.set(file, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
  }

  return files;
}

/**
 * Embedding engine using an iframe to run Transformers.js.
 * Same approach as Smart Connections — loads Transformers.js from CDN
 * inside an isolated iframe, avoiding all WASM/module resolution issues
 * in Obsidian's plugin protocol.
 *
 * Model files are pre-downloaded via curl (trusts macOS Keychain for
 * corporate networks) and injected into the iframe via postMessage,
 * so the iframe never needs to fetch from HuggingFace directly.
 */
export function createEmbeddingEngine(): EmbeddingEngine {
  let iframe: HTMLIFrameElement | null = null;
  let ready = false;
  let dimensions = 0;
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
  }>();

  const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1";

  const engine: EmbeddingEngine = {
    onDownloadProgress: null,

    async init(modelId: string): Promise<void> {
      console.log("[OpenBrain] Embedding init starting (iframe), model:", modelId);

      // Pre-download model files using curl (works on corporate networks)
      engine.onDownloadProgress?.({ status: "download", file: "model files" });
      let preloadedFiles: Map<string, ArrayBuffer>;
      try {
        preloadedFiles = await predownloadModelFiles(modelId, (p) => {
          engine.onDownloadProgress?.(p);
        });
        console.log(`[OpenBrain] Pre-downloaded ${preloadedFiles.size} model files`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[OpenBrain] Pre-download failed (${msg}), will try remote fetch`);
        preloadedFiles = new Map();
      }

      // Create hidden iframe
      iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.sandbox.add("allow-scripts", "allow-same-origin");
      document.body.appendChild(iframe);

      const iframeDoc = iframe.contentDocument!;

      // Build the iframe script.
      // If we have pre-loaded files, inject a fetch interceptor that serves
      // them locally so Transformers.js never hits the network for model data.
      const script = `
        <script type="module">
          import { pipeline, env } from "${TRANSFORMERS_CDN}";

          // Pre-loaded model file cache (populated via postMessage from parent)
          const fileCache = new Map();
          let modelBaseUrl = "";

          // Override fetch to serve cached model files
          const _originalFetch = globalThis.fetch;
          globalThis.fetch = async function(url, opts) {
            const urlStr = typeof url === "string" ? url : url?.url || "";
            // Match HuggingFace model file URLs
            if (modelBaseUrl && urlStr.startsWith(modelBaseUrl)) {
              const relPath = urlStr.slice(modelBaseUrl.length);
              if (fileCache.has(relPath)) {
                const data = fileCache.get(relPath);
                return new Response(data, {
                  status: 200,
                  headers: {
                    "content-type": relPath.endsWith(".json")
                      ? "application/json"
                      : "application/octet-stream",
                    "content-length": String(data.byteLength),
                  },
                });
              }
            }
            // Also try matching by filename only (some Transformers.js versions use different URL patterns)
            for (const [name, data] of fileCache) {
              if (urlStr.endsWith("/" + name) || urlStr.endsWith("/" + encodeURIComponent(name))) {
                return new Response(data, {
                  status: 200,
                  headers: {
                    "content-type": name.endsWith(".json")
                      ? "application/json"
                      : "application/octet-stream",
                    "content-length": String(data.byteLength),
                  },
                });
              }
            }
            return _originalFetch.call(this, url, opts);
          };

          env.allowLocalModels = false;
          env.allowRemoteModels = true;

          let extractor = null;
          let currentModelId = null;
          let consecutiveErrors = 0;

          async function initPipeline(modelId, progressCallback) {
            currentModelId = modelId;
            extractor = await pipeline("feature-extraction", modelId, {
              dtype: "fp32",
              progress_callback: progressCallback
            });
            consecutiveErrors = 0;
          }

          async function safeEmbed(text) {
            try {
              const output = await extractor(text, { pooling: "mean", normalize: true, truncation: true });
              consecutiveErrors = 0;
              return Array.from(output.data);
            } catch (err) {
              consecutiveErrors++;
              console.warn("[OpenBrain iframe] Embed failed, attempt to recover:", err.message?.slice(0, 60));

              if (consecutiveErrors >= 3 && currentModelId) {
                console.warn("[OpenBrain iframe] Resetting pipeline after consecutive errors");
                try {
                  if (extractor?.dispose) await extractor.dispose();
                } catch {}
                await initPipeline(currentModelId, () => {});
              }

              return null;
            }
          }

          async function handleMessage(e) {
            const { type, id, modelId, text, texts, files, baseUrl } = e.data;
            if (e.source !== window.parent) return;

            try {
              if (type === "preload") {
                // Receive pre-downloaded model files
                if (files) {
                  for (const [name, buffer] of Object.entries(files)) {
                    fileCache.set(name, buffer);
                  }
                }
                if (baseUrl) modelBaseUrl = baseUrl;
                window.parent.postMessage({ type: "preload-done", id }, "*");
              } else if (type === "init") {
                await initPipeline(modelId, (p) => {
                  window.parent.postMessage({
                    type: "progress", id,
                    progress: { status: p.status, file: p.file, loaded: p.loaded, total: p.total }
                  }, "*");
                });
                window.parent.postMessage({ type: "ready", id }, "*");
              } else if (type === "embed") {
                const vector = await safeEmbed(text);
                if (vector) {
                  window.parent.postMessage({ type: "result", id, vector }, "*");
                } else {
                  window.parent.postMessage({ type: "error", id, error: "Embed failed after retry" }, "*");
                }
              } else if (type === "embedBatch") {
                const vectors = [];
                for (const t of texts) {
                  const vec = await safeEmbed(t);
                  vectors.push(vec || []);
                }
                window.parent.postMessage({ type: "result", id, vectors }, "*");
              }
            } catch (err) {
              window.parent.postMessage({ type: "error", id, error: err.message }, "*");
            }
          }

          window.addEventListener("message", handleMessage);
          window.parent.postMessage({ type: "iframe-ready" }, "*");
        </script>
      `;

      iframeDoc.open();
      iframeDoc.write(`<!DOCTYPE html><html><head></head><body>${script}</body></html>`);
      iframeDoc.close();

      // Listen for messages from iframe
      const messageHandler = (e: MessageEvent) => {
        if (e.source !== iframe?.contentWindow) return;
        const { type, id, vector, vectors, error, progress } = e.data;

        if (type === "progress") {
          engine.onDownloadProgress?.(progress);
          return;
        }

        if (type === "iframe-ready") {
          return;
        }

        const handler = pending.get(id);
        if (!handler) return;
        pending.delete(id);

        if (type === "error") {
          handler.reject(new Error(error));
        } else if (type === "ready") {
          handler.resolve(undefined);
        } else if (type === "preload-done") {
          handler.resolve(undefined);
        } else if (type === "result") {
          if (vector) {
            handler.resolve(new Float32Array(vector));
          } else if (vectors) {
            handler.resolve(vectors.map((v: number[]) => new Float32Array(v)));
          }
        }
      };
      window.addEventListener("message", messageHandler);

      // Wait for iframe to be ready
      await new Promise<void>((resolve) => {
        const checkReady = (e: MessageEvent) => {
          if (e.data?.type === "iframe-ready" && e.source === iframe?.contentWindow) {
            window.removeEventListener("message", checkReady);
            resolve();
          }
        };
        window.addEventListener("message", checkReady);
      });

      // If we have pre-loaded files, send them to the iframe
      if (preloadedFiles.size > 0) {
        console.log("[OpenBrain] Sending pre-loaded model files to iframe...");
        const filesObj: Record<string, ArrayBuffer> = {};
        const transferables: ArrayBuffer[] = [];
        for (const [name, buf] of preloadedFiles) {
          filesObj[name] = buf;
          transferables.push(buf);
        }
        const baseUrl = `https://huggingface.co/${modelId}/resolve/main/`;
        await sendMessage(
          { type: "preload", files: filesObj, baseUrl },
          transferables
        );
        console.log("[OpenBrain] Pre-loaded files sent to iframe");
      }

      // Send init command
      console.log("[OpenBrain] Iframe ready, loading model...");
      await sendMessage({ type: "init", modelId });

      // Test embedding to get dimensions
      console.log("[OpenBrain] Model loaded, testing embed...");
      const testVec = await sendMessage({ type: "embed", text: "test" }) as Float32Array;
      dimensions = testVec.length;
      ready = true;
      console.log(`[OpenBrain] Embedding engine ready. Dimensions: ${dimensions}`);
    },

    async embed(text: string): Promise<Float32Array> {
      if (!ready) throw new Error("Engine not ready");
      return sendMessage({ type: "embed", text }) as Promise<Float32Array>;
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (!ready) throw new Error("Engine not ready");
      return sendMessage({ type: "embedBatch", texts }) as Promise<Float32Array[]>;
    },

    isReady(): boolean {
      return ready;
    },

    getDimensions(): number {
      return dimensions;
    },

    destroy(): void {
      ready = false;
      dimensions = 0;
      if (iframe) {
        iframe.remove();
        iframe = null;
      }
      pending.clear();
    },
  };

  function sendMessage(msg: any, transferables?: ArrayBuffer[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!iframe?.contentWindow) {
        reject(new Error("Iframe not initialized"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      if (transferables && transferables.length > 0) {
        iframe.contentWindow.postMessage({ ...msg, id }, "*", transferables);
      } else {
        iframe.contentWindow.postMessage({ ...msg, id }, "*");
      }
    });
  }

  return engine;
}
