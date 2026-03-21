import { join } from "path";
import { homedir } from "os";

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
  /** Callback for download progress during init */
  onDownloadProgress: ((progress: DownloadProgress) => void) | null;
}

export function getModelCacheDir(): string {
  return join(homedir(), ".openbrain", "models", "embed");
}

export function createEmbeddingEngine(workerPath: string): EmbeddingEngine {
  let worker: Worker | null = null;
  let ready = false;
  let dimensions = 0;
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
  }>();

  const engine: EmbeddingEngine = {
    onDownloadProgress: null,

    async init(modelId: string): Promise<void> {
      // Electron requires file:// URL for Web Workers
      const workerUrl = workerPath.startsWith("file://")
        ? workerPath
        : `file://${workerPath}`;
      worker = new Worker(workerUrl);

      worker.onmessage = (e: MessageEvent) => {
        const { type, id, vector, vectors, error, progress } = e.data;

        // Download progress doesn't resolve promises — just fire callback
        if (type === "progress") {
          engine.onDownloadProgress?.(progress as DownloadProgress);
          return;
        }

        const handler = pending.get(id);
        if (!handler) return;
        pending.delete(id);

        if (type === "error") {
          handler.reject(new Error(error));
        } else if (type === "ready") {
          handler.resolve(undefined);
        } else if (type === "result") {
          if (vector) {
            handler.resolve(new Float32Array(vector));
          } else if (vectors) {
            handler.resolve(vectors.map((v: number[]) => new Float32Array(v)));
          }
        }
      };

      worker.onerror = (err) => {
        console.error("[OpenBrain] Embedding worker error:", err);
        for (const [, handler] of pending) {
          handler.reject(new Error(`Worker error: ${err.message || "unknown"}`));
        }
        pending.clear();
      };

      await sendMessage({
        type: "init",
        modelId,
        cacheDir: getModelCacheDir(),
      });

      // Detect dimensions by embedding a test string
      const testVec = await sendMessage({ type: "embed", text: "test" }) as Float32Array;
      dimensions = testVec.length;
      ready = true;
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
      if (worker) {
        worker.terminate();
        worker = null;
      }
      pending.clear();
    },
  };

  function sendMessage(msg: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!worker) {
        reject(new Error("Worker not initialized"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id });
    });
  }

  return engine;
}
