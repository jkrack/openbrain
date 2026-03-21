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
      // Dynamic import — @huggingface/transformers is a large module
      const { pipeline, env } = await import("@huggingface/transformers");

      env.cacheDir = getModelCacheDir();
      env.allowLocalModels = true;
      env.allowRemoteModels = true;

      extractor = await pipeline("feature-extraction", modelId, {
        dtype: "q8",
        progress_callback: (p: any) => {
          engine.onDownloadProgress?.({
            status: p.status || "loading",
            file: p.file,
            loaded: p.loaded,
            total: p.total,
          });
        },
      });

      // Detect dimensions with a test embedding
      const output = await extractor("test", { pooling: "mean", normalize: true });
      dimensions = output.data.length;
      ready = true;
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
