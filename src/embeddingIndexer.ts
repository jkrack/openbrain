import { App, TFile } from "obsidian";
import { join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import { EmbeddingEngine } from "./embeddingEngine";
import { EmbeddingIndex, SectionVector } from "./embeddingIndex";

export type IndexerStatus = "idle" | "downloading" | "indexing" | "ready" | "paused" | "error";

export interface IndexerProgress {
  indexed: number;
  total: number;
  status: IndexerStatus;
  error?: string;
}

export interface EmbeddingIndexer {
  start(): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  queueFile(path: string): void;
  removeFile(path: string): void;
  getProgress(): IndexerProgress;
  onProgress: ((progress: IndexerProgress) => void) | null;
  /** Check if indexing should pause (recording/transcription active) */
  shouldPause: (() => boolean) | null;
}

/**
 * Strip YAML frontmatter from markdown content.
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n+/);
  if (match) return content.slice(match[0].length);
  return content;
}

/**
 * Split markdown content into sections at ## and ### headings.
 * Skips sections with fewer than 20 words.
 */
export function splitIntoSections(content: string): { heading: string; text: string }[] {
  const lines = content.split("\n");
  const sections: { heading: string; text: string }[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.+)/);
    if (headingMatch) {
      // Save previous section
      if (currentHeading !== null) {
        const text = currentLines.join("\n").trim();
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        if (wordCount >= 20) {
          sections.push({ heading: currentHeading, text });
        }
      }
      currentHeading = line;
      currentLines = [];
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  // Save last section
  if (currentHeading !== null) {
    const text = currentLines.join("\n").trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 20) {
      sections.push({ heading: currentHeading, text });
    }
  }

  return sections;
}

function getEmbeddingsDir(): string {
  return join(homedir(), ".openbrain", "embeddings");
}

export function createEmbeddingIndexer(
  app: App,
  engine: EmbeddingEngine,
  index: EmbeddingIndex,
  modelId: string
): EmbeddingIndexer {
  let running = false;
  let paused = false;
  let queue: Set<string> = new Set();
  let debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let indexed = 0;
  let total = 0;
  let status: IndexerStatus = "idle";
  let batchTimeout: ReturnType<typeof setTimeout> | null = null;

  // Sanitize model ID for use in filenames (TaylorAI/bge-micro-v2 → TaylorAI--bge-micro-v2)
  const safeModelId = modelId.replace(/\//g, "--");

  const indexer: EmbeddingIndexer = {
    onProgress: null,
    shouldPause: null,

    async start() {
      running = true;

      // Load persisted index
      const indexPath = join(getEmbeddingsDir(), `index-${safeModelId}.bin`);
      try {
        await index.load(indexPath);
      } catch {
        // No existing index or corrupt — start fresh
      }

      // Diff vault against index
      const files = app.vault.getMarkdownFiles();
      const toIndex: TFile[] = [];

      for (const file of files) {
        if (file.path.startsWith("OpenBrain/chats/") || file.path.startsWith("OpenBrain/templates/")) continue;
        if (!index.has(file.path, file.stat.mtime)) {
          toIndex.push(file);
        }
      }

      // Remove deleted files from index
      const vaultPaths = new Set(files.map((f) => f.path));
      for (const indexedPath of index.allPaths()) {
        if (!vaultPaths.has(indexedPath)) {
          index.remove(indexedPath);
        }
      }

      total = toIndex.length;
      indexed = 0;

      if (total === 0) {
        status = "ready";
        reportProgress();
        return;
      }

      status = "indexing";
      reportProgress();

      // Process in batches
      await processBatch(toIndex, 0);
    },

    stop() {
      running = false;
      if (batchTimeout) clearTimeout(batchTimeout);
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
    },

    pause() {
      paused = true;
      status = "paused";
      reportProgress();
    },

    resume() {
      paused = false;
      if (queue.size > 0) {
        void processQueue();
      } else {
        status = "ready";
        reportProgress();
      }
    },

    queueFile(path: string) {
      // Debounce: wait 2 seconds after last modification
      const existing = debounceTimers.get(path);
      if (existing) clearTimeout(existing);

      debounceTimers.set(path, setTimeout(() => {
        debounceTimers.delete(path);
        queue.add(path);
        if (running && !paused) {
          void processQueue();
        }
      }, 2000));
    },

    removeFile(path: string) {
      index.remove(path);
      queue.delete(path);
      // Save index after removal
      void saveIndex();
    },

    getProgress() {
      return { indexed, total, status };
    },
  };

  function reportProgress() {
    indexer.onProgress?.({ indexed, total, status });
  }

  async function processBatch(files: TFile[], startIdx: number) {
    if (!running) return;

    // Check if we should pause (recording/transcription active)
    if (paused || indexer.shouldPause?.()) {
      paused = true;
      status = "paused";
      reportProgress();
      // Will resume via resume() call
      // Store remaining work in queue
      for (let i = startIdx; i < files.length; i++) {
        queue.add(files[i].path);
      }
      return;
    }

    const batchEnd = Math.min(startIdx + 10, files.length);

    for (let i = startIdx; i < batchEnd; i++) {
      const file = files[i];
      try {
        await indexFile(file);
      } catch (err: unknown) {
        console.error(`[OpenBrain] Failed to index ${file.path}:`, err);
      }
      indexed++;
      reportProgress();
    }

    // Save after each batch
    await saveIndex();

    if (batchEnd < files.length) {
      // Yield to UI, then continue
      batchTimeout = setTimeout(() => void processBatch(files, batchEnd), 50);
    } else {
      status = "ready";
      reportProgress();
    }
  }

  async function indexFile(file: TFile) {
    const content = await app.vault.cachedRead(file);
    const stripped = stripFrontmatter(content);

    // Whole-note embedding (truncate to avoid exceeding model's token limit)
    const truncated = stripped.slice(0, 1500); // ~375 tokens, safe for 512-token models
    const noteVector = await engine.embed(truncated);

    // Section-level embeddings
    const rawSections = splitIntoSections(stripped);
    const sections: SectionVector[] = [];

    for (const section of rawSections) {
      const sectionTruncated = section.text.slice(0, 1500);
      const vector = await engine.embed(sectionTruncated);
      sections.push({
        heading: section.heading,
        text: section.text.slice(0, 500), // Store first 500 chars for passage display
        vector,
      });
    }

    index.add(file.path, file.stat.mtime, noteVector, sections);
  }

  async function processQueue() {
    if (paused || queue.size === 0) return;

    const paths = Array.from(queue);
    queue.clear();

    status = "indexing";
    total = paths.length;
    indexed = 0;
    reportProgress();

    for (const path of paths) {
      if (!running || paused) {
        // Re-queue remaining
        paths.slice(paths.indexOf(path)).forEach((p) => queue.add(p));
        return;
      }

      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && file.extension === "md") {
        try {
          index.remove(path); // Remove old vectors
          await indexFile(file);
        } catch (err: unknown) {
          console.error(`[OpenBrain] Failed to index ${path}:`, err);
        }
        indexed++;
        reportProgress();
      }
    }

    await saveIndex();
    status = "ready";
    reportProgress();
  }

  async function saveIndex() {
    try {
      const dir = getEmbeddingsDir();
      await mkdir(dir, { recursive: true });
      await index.save(join(dir, `index-${safeModelId}.bin`));
    } catch (err: unknown) {
      console.error("[OpenBrain] Failed to save embedding index:", err);
    }
  }

  return indexer;
}
