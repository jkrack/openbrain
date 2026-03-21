import { pipeline, env } from "@huggingface/transformers";

let extractor: any = null;

interface WorkerMessage {
  type: "init" | "embed" | "embedBatch";
  id: number;
  modelId?: string;
  cacheDir?: string;
  text?: string;
  texts?: string[];
}

interface WorkerResponse {
  type: "ready" | "result" | "error" | "progress";
  id: number;
  vector?: number[];
  vectors?: number[][];
  error?: string;
  progress?: { status: string; file?: string; loaded?: number; total?: number };
}

function respond(msg: WorkerResponse) {
  postMessage(msg);
}

onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, id } = e.data;

  try {
    if (type === "init") {
      const { modelId, cacheDir } = e.data;
      if (cacheDir) {
        env.cacheDir = cacheDir;
      }
      env.allowLocalModels = true;
      env.allowRemoteModels = true;

      extractor = await pipeline("feature-extraction", modelId!, {
        dtype: "q8",
        progress_callback: (p: any) => {
          // Transformers.js fires progress events during download
          respond({
            type: "progress",
            id,
            progress: {
              status: p.status || "loading",
              file: p.file,
              loaded: p.loaded,
              total: p.total,
            },
          });
        },
      });

      respond({ type: "ready", id });
    } else if (type === "embed") {
      if (!extractor) throw new Error("Model not initialized");
      const output = await extractor(e.data.text!, {
        pooling: "mean",
        normalize: true,
      });
      const vector = Array.from(output.data as Float32Array);
      respond({ type: "result", id, vector });
    } else if (type === "embedBatch") {
      if (!extractor) throw new Error("Model not initialized");
      const vectors: number[][] = [];
      for (const text of e.data.texts!) {
        const output = await extractor(text, {
          pooling: "mean",
          normalize: true,
        });
        vectors.push(Array.from(output.data as Float32Array));
      }
      respond({ type: "result", id, vectors });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    respond({ type: "error", id, error: message });
  }
};
