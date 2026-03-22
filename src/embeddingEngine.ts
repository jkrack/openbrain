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
 * Embedding engine using an iframe to run Transformers.js.
 * Same approach as Smart Connections — loads Transformers.js from CDN
 * inside an isolated iframe, avoiding all WASM/module resolution issues
 * in Obsidian's plugin protocol.
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

      // Create hidden iframe
      iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.sandbox.add("allow-scripts", "allow-same-origin");
      document.body.appendChild(iframe);

      const iframeDoc = iframe.contentDocument!;

      // Write the connector script into the iframe
      const script = `
        <script type="module">
          import { pipeline, env } from "${TRANSFORMERS_CDN}";

          env.allowLocalModels = false;
          env.allowRemoteModels = true;

          let extractor = null;

          async function handleMessage(e) {
            const { type, id, modelId, text, texts } = e.data;
            if (e.source !== window.parent) return;

            try {
              if (type === "init") {
                extractor = await pipeline("feature-extraction", modelId, {
                  dtype: "fp32",
                  progress_callback: (p) => {
                    window.parent.postMessage({
                      type: "progress", id,
                      progress: { status: p.status, file: p.file, loaded: p.loaded, total: p.total }
                    }, "*");
                  }
                });
                window.parent.postMessage({ type: "ready", id }, "*");
              } else if (type === "embed") {
                const output = await extractor(text, { pooling: "mean", normalize: true, truncation: true });
                window.parent.postMessage({ type: "result", id, vector: Array.from(output.data) }, "*");
              } else if (type === "embedBatch") {
                const vectors = [];
                for (const t of texts) {
                  const output = await extractor(t, { pooling: "mean", normalize: true, truncation: true });
                  vectors.push(Array.from(output.data));
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
          // Iframe is loaded, send init
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
      window.addEventListener("message", messageHandler);

      // Wait for iframe to be ready, then init
      await new Promise<void>((resolve) => {
        const checkReady = (e: MessageEvent) => {
          if (e.data?.type === "iframe-ready" && e.source === iframe?.contentWindow) {
            window.removeEventListener("message", checkReady);
            resolve();
          }
        };
        window.addEventListener("message", checkReady);
      });

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

  function sendMessage(msg: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!iframe?.contentWindow) {
        reject(new Error("Iframe not initialized"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      iframe.contentWindow.postMessage({ ...msg, id }, "*");
    });
  }

  return engine;
}
