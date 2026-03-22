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
  onDownloadProgress: ((progress: DownloadProgress) => void) | null;
}

export function getModelCacheDir(): string {
  return join(homedir(), ".openbrain", "models", "embed");
}

/**
 * Create an embedding engine that runs Transformers.js directly in the main thread.
 * No Web Worker — embeddings are fast enough (<50ms per call for small models)
 * and the indexer yields between batches to keep the UI responsive.
 */
export function createEmbeddingEngine(): EmbeddingEngine {
  let extractor: any = null;
  let ready = false;
  let dimensions = 0;

  const engine: EmbeddingEngine = {
    onDownloadProgress: null,

    async init(modelId: string): Promise<void> {
      console.log("[OpenBrain] Embedding init starting, model:", modelId);

      // Dynamic import — @huggingface/transformers is a large module
      const { pipeline, env } = await import("@huggingface/transformers");

      console.log("[OpenBrain] Transformers.js loaded, configuring env...");
      console.log("[OpenBrain] env.backends:", Object.keys(env.backends || {}));

      env.allowLocalModels = false;
      env.allowRemoteModels = true;

      // onnxruntime-node is marked as external in esbuild — resolved at runtime
      // via Node.js require(). Uses native bindings, no WASM needed.

      console.log("[OpenBrain] Calling pipeline('feature-extraction', '" + modelId + "')...");

      extractor = await pipeline("feature-extraction", modelId, {
        dtype: "q8",
        progress_callback: (p: any) => {
          if (p.status === "download") {
            console.log(`[OpenBrain] Download: ${p.file} ${p.loaded}/${p.total}`);
          } else {
            console.log(`[OpenBrain] Progress: ${p.status} ${p.file || ""}`);
          }
          engine.onDownloadProgress?.({
            status: p.status || "loading",
            file: p.file,
            loaded: p.loaded,
            total: p.total,
          });
        },
      });

      console.log("[OpenBrain] Pipeline created, testing embed...");

      // Detect dimensions with a test embedding
      console.log("[OpenBrain] Running test embedding...");
      const output = await extractor("test", { pooling: "mean", normalize: true });
      dimensions = output.data.length;
      ready = true;
      console.log(`[OpenBrain] Embedding engine ready. Dimensions: ${dimensions}`);
    },

    async embed(text: string): Promise<Float32Array> {
      if (!extractor) throw new Error("Engine not ready");
      const output = await extractor(text, { pooling: "mean", normalize: true });
      return new Float32Array(output.data);
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (!extractor) throw new Error("Engine not ready");
      const results: Float32Array[] = [];
      for (const text of texts) {
        const output = await extractor(text, { pooling: "mean", normalize: true });
        results.push(new Float32Array(output.data));
      }
      return results;
    },

    isReady(): boolean {
      return ready;
    },

    getDimensions(): number {
      return dimensions;
    },

    destroy(): void {
      extractor = null;
      ready = false;
      dimensions = 0;
    },
  };

  return engine;
}
