# Local Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local semantic search to OpenBrain using Transformers.js ONNX models in a Web Worker, with hybrid note+section embeddings, progressive background indexing, and a new `vault_semantic_search` tool.

**Architecture:** Web Worker runs `@huggingface/transformers` for embedding inference. In-memory vector index with binary persistence at `~/.openbrain/embeddings/`. Background indexer processes vault files in batches, pausing during recording/transcription. Smart context upgraded to use embedding similarity with keyword fallback.

**Tech Stack:** TypeScript, `@huggingface/transformers`, Web Workers, esbuild multi-entrypoint, cosine similarity, binary serialization

**Spec:** `docs/superpowers/specs/2026-03-21-local-embeddings-design.md`

---

### Task 1: Add `@huggingface/transformers` Dependency

**Files:**
- Modify: `package.json`
- Modify: `esbuild.config.mjs`

- [ ] **Step 1: Install the dependency**

```bash
npm install @huggingface/transformers
```

- [ ] **Step 2: Add to esbuild externals**

In `esbuild.config.mjs`, the Web Worker will bundle its own copy of transformers. But the main bundle should NOT include it (it's only used in the worker). No changes needed to the main entrypoint externals — the worker will be a separate bundle.

- [ ] **Step 3: Add worker build entrypoint to esbuild**

In `esbuild.config.mjs`, after the existing `context` creation and before the `if (prod)` block, add a second build context for the worker:

```javascript
// Build embedding worker as a separate bundle (skip if file doesn't exist yet)
import { existsSync } from "fs";

let workerContext = null;
if (existsSync("src/embeddingWorker.ts")) {
  workerContext = await esbuild.context({
    entryPoints: ["src/embeddingWorker.ts"],
    bundle: true,
    format: "iife",
    target: "es2020",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "embeddingWorker.js",
  });
}
```

Update the prod/dev blocks to build/watch both contexts:

```javascript
if (prod) {
  await context.rebuild();
  if (workerContext) await workerContext.rebuild();
  process.exit(0);
} else {
  await context.watch();
  if (workerContext) await workerContext.watch();
}
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: Build succeeds. `embeddingWorker.js` won't exist yet (entrypoint doesn't exist), but the main build should pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json esbuild.config.mjs
git commit -m "build: add @huggingface/transformers and worker build entrypoint"
```

---

### Task 2: Embedding Engine — Web Worker + TypeScript API

**Files:**
- Create: `src/embeddingWorker.ts`
- Create: `src/embeddingEngine.ts`
- Create: `src/__tests__/embeddingEngine.test.ts`

- [ ] **Step 1: Create the Web Worker**

Create `src/embeddingWorker.ts`:

```typescript
import { pipeline, env } from "@huggingface/transformers";

// Configure Transformers.js to use a custom cache directory
// This will be set via a message from the main thread
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
  type: "ready" | "result" | "error";
  id: number;
  vector?: number[];
  vectors?: number[][];
  error?: string;
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
        quantized: true,
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
```

- [ ] **Step 2: Create the engine wrapper**

Create `src/embeddingEngine.ts`:

```typescript
import { join } from "path";
import { homedir } from "os";

export interface EmbeddingEngine {
  init(modelId: string): Promise<void>;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  isReady(): boolean;
  getDimensions(): number;
  destroy(): void;
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

  return {
    async init(modelId: string): Promise<void> {
      worker = new Worker(workerPath);

      worker.onmessage = (e: MessageEvent) => {
        const { type, id, vector, vectors, error } = e.data;
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
}
```

- [ ] **Step 3: Write basic test**

Create `src/__tests__/embeddingEngine.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getModelCacheDir } from "../embeddingEngine";
import { homedir } from "os";
import { join } from "path";

describe("embeddingEngine", () => {
  it("returns correct model cache directory", () => {
    const dir = getModelCacheDir();
    expect(dir).toBe(join(homedir(), ".openbrain", "models", "embed"));
  });
});
```

Note: Full integration tests require a Web Worker environment which isn't available in Node/vitest. The engine will be tested manually in Obsidian and via the indexer integration tests.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/embeddingEngine.test.ts`
Expected: PASS

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Both `main.js` and `embeddingWorker.js` are produced at repo root.

- [ ] **Step 6: Commit**

```bash
git add src/embeddingWorker.ts src/embeddingEngine.ts src/__tests__/embeddingEngine.test.ts
git commit -m "feat(embeddings): embedding engine with Web Worker and Transformers.js"
```

---

### Task 3: Embedding Index — Vector Store + Binary Persistence

**Files:**
- Create: `src/embeddingIndex.ts`
- Create: `src/__tests__/embeddingIndex.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/embeddingIndex.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createEmbeddingIndex,
  type EmbeddingIndex,
  type NoteMatch,
  type PassageMatch,
} from "../embeddingIndex";

let testDir: string;
let index: EmbeddingIndex;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ob-embed-test-"));
  index = createEmbeddingIndex(384);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// Helper: create a normalized random vector
function randomVector(dims: number): Float32Array {
  const v = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    v[i] = Math.random() - 0.5;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

// Helper: create a vector similar to another (high cosine similarity)
function similarVector(base: Float32Array, noise = 0.1): Float32Array {
  const v = new Float32Array(base.length);
  let norm = 0;
  for (let i = 0; i < base.length; i++) {
    v[i] = base[i] + (Math.random() - 0.5) * noise;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < base.length; i++) v[i] /= norm;
  return v;
}

describe("embeddingIndex", () => {
  it("adds and retrieves note vectors", () => {
    const vec = randomVector(384);
    index.add("notes/test.md", 1000, vec, []);
    expect(index.has("notes/test.md", 1000)).toBe(true);
    expect(index.has("notes/test.md", 999)).toBe(false);
    expect(index.has("notes/other.md", 1000)).toBe(false);
  });

  it("removes entries", () => {
    const vec = randomVector(384);
    index.add("notes/test.md", 1000, vec, []);
    index.remove("notes/test.md");
    expect(index.has("notes/test.md", 1000)).toBe(false);
  });

  it("searches notes by cosine similarity", () => {
    const queryVec = randomVector(384);
    const similarVec = similarVector(queryVec, 0.05);
    const dissimilarVec = randomVector(384);

    index.add("notes/relevant.md", 1000, similarVec, []);
    index.add("notes/irrelevant.md", 1000, dissimilarVec, []);

    const results = index.searchNotes(queryVec, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe("notes/relevant.md");
    expect(results[0].score).toBeGreaterThan(results[results.length - 1]?.score || 0);
  });

  it("searches passages by cosine similarity", () => {
    const queryVec = randomVector(384);
    const relevantSection = similarVector(queryVec, 0.05);
    const irrelevantSection = randomVector(384);

    index.add("notes/meeting.md", 1000, randomVector(384), [
      { heading: "## Decisions", text: "Decided to launch in April", vector: relevantSection },
      { heading: "## Attendees", text: "John, Sarah, Mike", vector: irrelevantSection },
    ]);

    const results = index.searchPassages(queryVec, 5, 0.3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].heading).toBe("## Decisions");
    expect(results[0].text).toBe("Decided to launch in April");
  });

  it("persists and loads from binary file", async () => {
    const vec1 = randomVector(384);
    const vec2 = randomVector(384);
    index.add("notes/a.md", 1000, vec1, [
      { heading: "## Summary", text: "A summary", vector: randomVector(384) },
    ]);
    index.add("notes/b.md", 2000, vec2, []);

    const filePath = join(testDir, "index.bin");
    await index.save(filePath);

    const loaded = createEmbeddingIndex(384);
    await loaded.load(filePath);

    expect(loaded.has("notes/a.md", 1000)).toBe(true);
    expect(loaded.has("notes/b.md", 2000)).toBe(true);

    const stats = loaded.stats();
    expect(stats.noteCount).toBe(2);
    expect(stats.sectionCount).toBe(1);
  });

  it("reports stats correctly", () => {
    index.add("a.md", 1, randomVector(384), [
      { heading: "## H1", text: "text1", vector: randomVector(384) },
      { heading: "## H2", text: "text2", vector: randomVector(384) },
    ]);
    index.add("b.md", 2, randomVector(384), []);

    const stats = index.stats();
    expect(stats.noteCount).toBe(2);
    expect(stats.sectionCount).toBe(2);
  });

  it("clears all entries", () => {
    index.add("a.md", 1, randomVector(384), []);
    index.add("b.md", 2, randomVector(384), []);
    index.clear();
    expect(index.stats().noteCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/embeddingIndex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement embeddingIndex.ts**

Create `src/embeddingIndex.ts`:

```typescript
import { writeFile, readFile } from "fs/promises";

export interface SectionVector {
  heading: string;
  text: string;
  vector: Float32Array;
}

export interface NoteVectors {
  path: string;
  mtime: number;
  noteVector: Float32Array;
  sections: SectionVector[];
}

export interface NoteMatch {
  path: string;
  basename: string;
  score: number;
}

export interface PassageMatch {
  path: string;
  heading: string;
  text: string;
  score: number;
}

export interface EmbeddingIndex {
  add(path: string, mtime: number, noteVector: Float32Array, sections: SectionVector[]): void;
  remove(path: string): void;
  has(path: string, mtime: number): boolean;
  searchNotes(queryVector: Float32Array, limit: number): NoteMatch[];
  searchPassages(queryVector: Float32Array, limit: number, minScore: number): PassageMatch[];
  save(filePath: string): Promise<void>;
  load(filePath: string): Promise<void>;
  clear(): void;
  allPaths(): string[];
  stats(): { noteCount: number; sectionCount: number; sizeBytes: number };
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Vectors are pre-normalized, so dot product = cosine similarity
  return dot;
}

const INDEX_VERSION = 1;

export function createEmbeddingIndex(dimensions: number): EmbeddingIndex {
  const entries = new Map<string, NoteVectors>();

  return {
    add(path, mtime, noteVector, sections) {
      entries.set(path, { path, mtime, noteVector, sections });
    },

    remove(path) {
      entries.delete(path);
    },

    has(path, mtime) {
      const entry = entries.get(path);
      return entry !== undefined && entry.mtime === mtime;
    },

    searchNotes(queryVector, limit) {
      const scored: NoteMatch[] = [];
      for (const entry of entries.values()) {
        const score = cosineSimilarity(queryVector, entry.noteVector);
        if (score > 0.3) {
          const basename = entry.path.split("/").pop()?.replace(/\.md$/, "") || entry.path;
          scored.push({ path: entry.path, basename, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    searchPassages(queryVector, limit, minScore) {
      const scored: PassageMatch[] = [];
      for (const entry of entries.values()) {
        for (const section of entry.sections) {
          const score = cosineSimilarity(queryVector, section.vector);
          if (score > minScore) {
            scored.push({
              path: entry.path,
              heading: section.heading,
              text: section.text,
              score,
            });
          }
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    async save(filePath) {
      const entryList = Array.from(entries.values());
      // Calculate total size
      let size = 1 + 2 + 2 + 4; // version + modelIdLen placeholder + dims + count
      const modelIdBytes = new TextEncoder().encode("default");
      size += modelIdBytes.length;

      for (const entry of entryList) {
        const pathBytes = new TextEncoder().encode(entry.path);
        size += 2 + pathBytes.length; // path
        size += 8; // mtime
        size += dimensions * 4; // noteVector
        size += 2; // section count
        for (const s of entry.sections) {
          const hBytes = new TextEncoder().encode(s.heading);
          const tBytes = new TextEncoder().encode(s.text);
          size += 2 + hBytes.length; // heading
          size += 4 + tBytes.length; // text (uint32 for longer content)
          size += dimensions * 4; // vector
        }
      }

      const buffer = Buffer.alloc(size);
      let offset = 0;

      // Header
      buffer.writeUInt8(INDEX_VERSION, offset); offset += 1;
      buffer.writeUInt16LE(modelIdBytes.length, offset); offset += 2;
      modelIdBytes.forEach((b, i) => buffer.writeUInt8(b, offset + i));
      offset += modelIdBytes.length;
      buffer.writeUInt16LE(dimensions, offset); offset += 2;
      buffer.writeUInt32LE(entryList.length, offset); offset += 4;

      // Entries
      for (const entry of entryList) {
        const pathBytes = new TextEncoder().encode(entry.path);
        buffer.writeUInt16LE(pathBytes.length, offset); offset += 2;
        pathBytes.forEach((b, i) => buffer.writeUInt8(b, offset + i));
        offset += pathBytes.length;

        buffer.writeDoubleBE(entry.mtime, offset); offset += 8;

        for (let i = 0; i < dimensions; i++) {
          buffer.writeFloatLE(entry.noteVector[i], offset); offset += 4;
        }

        buffer.writeUInt16LE(entry.sections.length, offset); offset += 2;

        for (const s of entry.sections) {
          const hBytes = new TextEncoder().encode(s.heading);
          buffer.writeUInt16LE(hBytes.length, offset); offset += 2;
          hBytes.forEach((b, i) => buffer.writeUInt8(b, offset + i));
          offset += hBytes.length;

          const tBytes = new TextEncoder().encode(s.text);
          buffer.writeUInt32LE(tBytes.length, offset); offset += 4;
          tBytes.forEach((b, i) => buffer.writeUInt8(b, offset + i));
          offset += tBytes.length;

          for (let i = 0; i < dimensions; i++) {
            buffer.writeFloatLE(s.vector[i], offset); offset += 4;
          }
        }
      }

      await writeFile(filePath, buffer);
    },

    async load(filePath) {
      const data = await readFile(filePath);
      let offset = 0;
      const decoder = new TextDecoder();

      // Header
      const version = data.readUInt8(offset); offset += 1;
      if (version !== INDEX_VERSION) throw new Error(`Unsupported index version: ${version}`);

      const modelIdLen = data.readUInt16LE(offset); offset += 2;
      offset += modelIdLen; // skip model ID for now

      const dims = data.readUInt16LE(offset); offset += 2;
      const count = data.readUInt32LE(offset); offset += 4;

      entries.clear();

      for (let n = 0; n < count; n++) {
        const pathLen = data.readUInt16LE(offset); offset += 2;
        const path = decoder.decode(data.subarray(offset, offset + pathLen));
        offset += pathLen;

        const mtime = data.readDoubleBE(offset); offset += 8;

        const noteVector = new Float32Array(dims);
        for (let i = 0; i < dims; i++) {
          noteVector[i] = data.readFloatLE(offset); offset += 4;
        }

        const sectionCount = data.readUInt16LE(offset); offset += 2;
        const sections: SectionVector[] = [];

        for (let s = 0; s < sectionCount; s++) {
          const hLen = data.readUInt16LE(offset); offset += 2;
          const heading = decoder.decode(data.subarray(offset, offset + hLen));
          offset += hLen;

          const tLen = data.readUInt32LE(offset); offset += 4;
          const text = decoder.decode(data.subarray(offset, offset + tLen));
          offset += tLen;

          const vector = new Float32Array(dims);
          for (let i = 0; i < dims; i++) {
            vector[i] = data.readFloatLE(offset); offset += 4;
          }

          sections.push({ heading, text, vector });
        }

        entries.set(path, { path, mtime, noteVector, sections });
      }
    },

    allPaths() {
      return Array.from(entries.keys());
    },

    clear() {
      entries.clear();
    },

    stats() {
      let sectionCount = 0;
      let sizeBytes = 0;
      for (const entry of entries.values()) {
        sectionCount += entry.sections.length;
        sizeBytes += dimensions * 4; // noteVector
        for (const s of entry.sections) {
          sizeBytes += dimensions * 4 + s.text.length + s.heading.length;
        }
      }
      return { noteCount: entries.size, sectionCount, sizeBytes };
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/embeddingIndex.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/embeddingIndex.ts src/__tests__/embeddingIndex.test.ts
git commit -m "feat(embeddings): vector index with cosine similarity and binary persistence"
```

---

### Task 4: Background Indexer

**Files:**
- Create: `src/embeddingIndexer.ts`
- Create: `src/__tests__/embeddingIndexer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/embeddingIndexer.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { splitIntoSections, stripFrontmatter } from "../embeddingIndexer";

describe("embeddingIndexer", () => {
  it("strips YAML frontmatter", () => {
    const content = "---\ntitle: Test\ntags: [a, b]\n---\n\n# Hello\n\nSome content.";
    const stripped = stripFrontmatter(content);
    expect(stripped).toBe("# Hello\n\nSome content.");
  });

  it("returns content unchanged if no frontmatter", () => {
    const content = "# Hello\n\nSome content.";
    expect(stripFrontmatter(content)).toBe(content);
  });

  it("splits content at ## and ### headings", () => {
    const content = [
      "# Main Title",
      "Intro paragraph.",
      "",
      "## Section One",
      "Content for section one.",
      "More content.",
      "",
      "### Subsection",
      "Subsection content.",
      "",
      "## Section Two",
      "Content for section two.",
    ].join("\n");

    const sections = splitIntoSections(content);
    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe("## Section One");
    expect(sections[0].text).toContain("Content for section one.");
    expect(sections[1].heading).toBe("### Subsection");
    expect(sections[1].text).toContain("Subsection content.");
    expect(sections[2].heading).toBe("## Section Two");
    expect(sections[2].text).toContain("Content for section two.");
  });

  it("skips sections with fewer than 20 words", () => {
    const content = [
      "## Long Section",
      "This section has more than twenty words in it so it should be included in the results when we split the content into sections for embedding.",
      "",
      "## Short",
      "Too short.",
    ].join("\n");

    const sections = splitIntoSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("## Long Section");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/embeddingIndexer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement embeddingIndexer.ts**

Create `src/embeddingIndexer.ts`:

```typescript
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

  const indexer: EmbeddingIndexer = {
    onProgress: null,
    shouldPause: null,

    async start() {
      running = true;

      // Load persisted index
      const indexPath = join(getEmbeddingsDir(), `index-${modelId}.bin`);
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
    const truncated = stripped.slice(0, 4000); // ~1000 tokens, safe for all models
    const noteVector = await engine.embed(truncated);

    // Section-level embeddings
    const rawSections = splitIntoSections(stripped);
    const sections: SectionVector[] = [];

    for (const section of rawSections) {
      const sectionTruncated = section.text.slice(0, 2000);
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
      await index.save(join(dir, `index-${modelId}.bin`));
    } catch (err: unknown) {
      console.error("[OpenBrain] Failed to save embedding index:", err);
    }
  }

  return indexer;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/embeddingIndexer.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/embeddingIndexer.ts src/__tests__/embeddingIndexer.test.ts
git commit -m "feat(embeddings): background vault indexer with batching, pause/resume, debounce"
```

---

### Task 5: Embedding Search Interface

**Files:**
- Create: `src/embeddingSearch.ts`

- [ ] **Step 1: Implement embeddingSearch.ts**

Create `src/embeddingSearch.ts`:

```typescript
import { EmbeddingEngine } from "./embeddingEngine";
import { EmbeddingIndex, NoteMatch, PassageMatch } from "./embeddingIndex";

export interface EmbeddingSearch {
  searchNotes(query: string, limit?: number): Promise<NoteMatch[]>;
  searchPassages(query: string, limit?: number): Promise<PassageMatch[]>;
  isReady(): boolean;
}

export function createEmbeddingSearch(
  engine: EmbeddingEngine,
  index: EmbeddingIndex
): EmbeddingSearch {
  return {
    async searchNotes(query: string, limit = 5): Promise<NoteMatch[]> {
      if (!engine.isReady()) return [];
      const queryVector = await engine.embed(query);
      return index.searchNotes(queryVector, limit);
    },

    async searchPassages(query: string, limit = 5): Promise<PassageMatch[]> {
      if (!engine.isReady()) return [];
      const queryVector = await engine.embed(query);
      return index.searchPassages(queryVector, limit, 0.5);
    },

    isReady(): boolean {
      return engine.isReady();
    },
  };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/embeddingSearch.ts
git commit -m "feat(embeddings): search interface for note and passage similarity queries"
```

---

### Task 6: Smart Context Integration

**Files:**
- Modify: `src/smartContext.ts`

- [ ] **Step 1: Update smartContext to use embeddings with fallback**

In `src/smartContext.ts`, add the embedding search integration. The `buildSmartContext` function gains a new parameter for the embedding search instance and uses it when available, falling back to keyword matching.

Add import at top:
```typescript
import { EmbeddingSearch } from "./embeddingSearch";
```

Update `buildSmartContext` signature and body:

```typescript
export async function buildSmartContext(
  app: App,
  message: string,
  existingFiles: string[] = [],
  embeddingSearch?: EmbeddingSearch | null
): Promise<string> {
  // If embeddings are available, use semantic search
  if (embeddingSearch?.isReady()) {
    const passages = await embeddingSearch.searchPassages(message, 3);
    const notes = await embeddingSearch.searchNotes(message, 3);

    // Filter out already-attached files
    const newPassages = passages.filter((p) => !existingFiles.includes(p.path));
    const newNotes = notes.filter((n) =>
      !existingFiles.includes(n.path) &&
      !newPassages.some((p) => p.path === n.path)
    );

    if (newPassages.length === 0 && newNotes.length === 0) return "";

    let context = "\n\n--- Relevant context from your vault ---\n";

    for (const p of newPassages) {
      const basename = p.path.split("/").pop()?.replace(/\.md$/, "") || p.path;
      context += `\nFrom "${basename}" > ${p.heading}:\n${p.text}\n`;
    }

    if (newNotes.length > 0) {
      context += "\nRelated notes (read if helpful):\n";
      context += newNotes.map((n) => `- ${n.path}`).join("\n");
    }

    return context;
  }

  // Fallback: keyword matching (existing behavior)
  const relevant = findRelevantFiles(app, message);
  const newFiles = relevant.filter((p) => !existingFiles.includes(p));
  if (newFiles.length === 0) return "";

  return "\n\nRelevant vault notes (read if helpful for responding):\n" +
    newFiles.map((p) => `- ${p}`).join("\n");
}
```

Note: `buildSmartContext` changes from synchronous to async. Update all callers in `panel.tsx` to await it.

- [ ] **Step 2: Make embedding search available to panel.tsx**

The `EmbeddingSearch` instance is created in `main.ts` and needs to be accessible in the panel. Add it as a module-level getter in `toolEngine.ts` (which already stores the instance):

In `src/toolEngine.ts`, add:
```typescript
export function getEmbeddingSearch(): EmbeddingSearch | null {
  return embeddingSearchInstance;
}
```

- [ ] **Step 3: Update panel.tsx caller**

In `src/panel.tsx`, add import:
```typescript
import { getEmbeddingSearch } from "./toolEngine";
```

Find the call to `buildSmartContext` (around line 647) and update it:

Change:
```typescript
const smartCtx = buildSmartContext(app, userText, attachedFiles);
```
To:
```typescript
const smartCtx = await buildSmartContext(app, userText, attachedFiles, getEmbeddingSearch());
```

The `sendMessage` function is already async, so this is safe.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Run tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/smartContext.ts src/panel.tsx
git commit -m "feat(embeddings): upgrade smart context to use semantic search with keyword fallback"
```

---

### Task 7: Vault Semantic Search Tool

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/toolEngine.ts`

- [ ] **Step 1: Add tool definition**

In `src/tools.ts`, add to the `READ_TOOLS` array after the last entry (vault_unresolved, around line 111):

```typescript
  {
    name: "vault_semantic_search",
    description: "Find notes and passages semantically related to a query. Uses embedding-based similarity, not keyword matching. Returns both relevant note paths and specific passage excerpts. Only available when semantic search is enabled.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Max results per category (default 5)" }
      },
      required: ["query"]
    }
  },
```

- [ ] **Step 2: Add tool execution**

In `src/toolEngine.ts`, add a case in the `executeToolInner` switch statement after the last read tool case (vault_unresolved). The embedding search instance needs to be accessible — pass it via a module-level setter.

Add at the top of `toolEngine.ts`:
```typescript
import { EmbeddingSearch } from "./embeddingSearch";

let embeddingSearchInstance: EmbeddingSearch | null = null;

export function setEmbeddingSearch(search: EmbeddingSearch | null): void {
  embeddingSearchInstance = search;
}
```

Add the case in the switch:
```typescript
    case "vault_semantic_search": {
      if (!embeddingSearchInstance?.isReady()) {
        return "Semantic search is not available. Enable it in Settings > OpenBrain > Semantic search.";
      }
      const query = input.query as string;
      const limit = (input.limit as number) || 5;

      const notes = await embeddingSearchInstance.searchNotes(query, limit);
      const passages = await embeddingSearchInstance.searchPassages(query, limit);

      let result = "";
      if (passages.length > 0) {
        result += "Relevant passages:\n";
        for (const p of passages) {
          const basename = p.path.split("/").pop()?.replace(/\.md$/, "") || p.path;
          result += `\n"${basename}" > ${p.heading} (score: ${p.score.toFixed(2)}):\n${p.text}\n`;
        }
      }
      if (notes.length > 0) {
        result += "\nRelated notes:\n";
        for (const n of notes) {
          result += `- ${n.path} (score: ${n.score.toFixed(2)})\n`;
        }
      }
      if (!result) result = "No semantically similar content found.";
      return result;
    }
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/tools.ts src/toolEngine.ts
git commit -m "feat(embeddings): add vault_semantic_search tool for Claude"
```

---

### Task 8: Settings UI — Model Picker & Index Status

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1: Add settings fields**

In the `OpenBrainSettings` interface, add after the floating recorder fields:

```typescript
  // Embeddings
  embeddingsEnabled: boolean;
  embeddingsModel: string;
```

In `DEFAULT_SETTINGS`, add:
```typescript
  embeddingsEnabled: false,
  embeddingsModel: "TaylorAI/bge-micro-v2",
```

- [ ] **Step 2: Add the model list constant**

At the top of `settings.ts` (after imports), add:

```typescript
const EMBEDDING_MODELS = [
  { id: "TaylorAI/bge-micro-v2", name: "BGE-micro-v2", size: "~20MB", dims: 384, tokens: 512, quality: 1 },
  { id: "Snowflake/snowflake-arctic-embed-xs", name: "Arctic Embed XS", size: "~25MB", dims: 384, tokens: 512, quality: 2 },
  { id: "TaylorAI/gte-tiny", name: "GTE-tiny", size: "~25MB", dims: 384, tokens: 512, quality: 2 },
  { id: "nomic-ai/nomic-embed-text-v1.5", name: "Nomic Embed v1.5", size: "~100MB", dims: 768, tokens: 2048, quality: 4 },
  { id: "jinaai/jina-embeddings-v2-small-en", name: "Jina v2 Small", size: "~80MB", dims: 512, tokens: 8192, quality: 5 },
];
```

- [ ] **Step 3: Add settings UI section**

In `OpenBrainSettingTab.display()`, add a new "Semantic search" section before the OpenClaw section. Include:

1. Enable toggle
2. Model picker rendered as a list with Fast ↔ Accurate scale
3. Re-index warning on model change
4. Index status display (connected via a callback from main.ts)

```typescript
    // ── Semantic Search ──
    new Setting(containerEl).setName("Semantic search").setHeading();

    new Setting(containerEl)
      .setName("Enable semantic search")
      .setDesc(
        "Use local AI embeddings to find semantically related notes and passages. " +
        "Runs entirely on your device — no data leaves your machine."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.embeddingsEnabled)
          .onChange((value) => { void (async () => {
            this.plugin.settings.embeddingsEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          })(); })
      );

    if (this.plugin.settings.embeddingsEnabled) {
      // Model picker
      const modelSection = containerEl.createDiv({ cls: "ca-embed-models" });

      const scaleLabel = modelSection.createDiv({ cls: "ca-embed-scale" });
      scaleLabel.createSpan({ text: "Fast", cls: "ca-embed-scale-label" });
      scaleLabel.createEl("span", { text: "◄─────────────────────────►", cls: "ca-embed-scale-bar" });
      scaleLabel.createSpan({ text: "Accurate", cls: "ca-embed-scale-label" });

      for (const model of EMBEDDING_MODELS) {
        const isSelected = this.plugin.settings.embeddingsModel === model.id;
        const row = modelSection.createDiv({
          cls: `ca-embed-model-row${isSelected ? " selected" : ""}`,
        });

        const qualityBar = "■".repeat(model.quality) + "□".repeat(5 - model.quality);
        row.createSpan({ text: model.name, cls: "ca-embed-model-name" });
        row.createSpan({ text: model.size, cls: "ca-embed-model-size" });
        row.createSpan({ text: `${model.dims}d`, cls: "ca-embed-model-dims" });
        row.createSpan({ text: qualityBar, cls: "ca-embed-model-quality" });

        if (!isSelected) {
          row.addEventListener("click", () => {
            const prev = this.plugin.settings.embeddingsModel;
            if (prev !== model.id) {
              // Warn about re-indexing
              const confirmed = confirm(
                `Switching to ${model.name} requires re-indexing your entire vault. This will take a few minutes. Continue?`
              );
              if (!confirmed) return;
            }
            void (async () => {
              this.plugin.settings.embeddingsModel = model.id;
              await this.plugin.saveSettings();
              this.display();
            })();
          });
        }
      }

      // Index status (populated by main.ts via a callback)
      const statusEl = containerEl.createDiv({ cls: "ca-embed-status" });
      statusEl.setText("Checking index...");
      // main.ts will update this element via plugin reference
      (this.plugin as any)._embeddingStatusEl = statusEl;
    }
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts
git commit -m "feat(embeddings): settings UI with model picker, Fast/Accurate spectrum, index status"
```

---

### Task 9: Wire Everything Into main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add imports**

```typescript
import { createEmbeddingEngine, getModelCacheDir } from "./embeddingEngine";
import { createEmbeddingIndex } from "./embeddingIndex";
import { createEmbeddingIndexer } from "./embeddingIndexer";
import { createEmbeddingSearch } from "./embeddingSearch";
import { setEmbeddingSearch } from "./toolEngine";
```

- [ ] **Step 2: Add class properties**

After the existing `private floatingRecorder` property:

```typescript
  private embeddingEngine: ReturnType<typeof createEmbeddingEngine> | null = null;
  private embeddingIndexer: ReturnType<typeof createEmbeddingIndexer> | null = null;
  private embeddingStatusBarEl: HTMLElement | null = null;
```

- [ ] **Step 3: Initialize in onLayoutReady**

After the floating recorder initialization block, add:

```typescript
      // Initialize embedding system
      if (this.settings.embeddingsEnabled) {
        void this.initEmbeddings();
      }
```

Add the `initEmbeddings` method to the class:

```typescript
  private async initEmbeddings(): Promise<void> {
    try {
      const workerPath = join(
        (this.app as any).vault.adapter.basePath,
        ".obsidian", "plugins", "open-brain", "embeddingWorker.js"
      );

      this.embeddingEngine = createEmbeddingEngine(workerPath);
      await this.embeddingEngine.init(this.settings.embeddingsModel);

      const index = createEmbeddingIndex(this.embeddingEngine.getDimensions());
      const indexer = createEmbeddingIndexer(
        this.app, this.embeddingEngine, index, this.settings.embeddingsModel
      );

      // Pause indexing during recording
      indexer.shouldPause = () =>
        this.floatingRecorder?.isRecording ?? false;

      // Update status bar and settings panel
      indexer.onProgress = (progress) => {
        this.updateEmbeddingStatus(progress);
      };

      this.embeddingIndexer = indexer;

      // Make search available to tools and smart context
      const search = createEmbeddingSearch(this.embeddingEngine, index);
      setEmbeddingSearch(search);

      // Start indexing
      await indexer.start();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[OpenBrain] Failed to initialize embeddings: ${message}`);
    }
  }

  private updateEmbeddingStatus(progress: { indexed: number; total: number; status: string }): void {
    // Use a SEPARATE status bar element for embeddings (don't overwrite recording status)
    if (!this.embeddingStatusBarEl) {
      this.embeddingStatusBarEl = this.addStatusBarItem();
      this.embeddingStatusBarEl.addClass("openbrain-embed-status");
    }

    if (progress.status === "indexing") {
      this.embeddingStatusBarEl.setText(`Indexing ${progress.indexed}/${progress.total}`);
    } else if (progress.status === "ready") {
      this.embeddingStatusBarEl.setText("");
    } else if (progress.status === "paused") {
      this.embeddingStatusBarEl.setText("Index paused");
    }
  }
```

- [ ] **Step 4: Wire vault events to indexer**

In the existing vault event listeners (create/modify/delete/rename), add indexer calls alongside the existing vaultIndex calls:

```typescript
    // In the create handler:
    this.embeddingIndexer?.queueFile(file.path);

    // In the modify handler:
    this.embeddingIndexer?.queueFile(file.path);

    // In the delete handler:
    this.embeddingIndexer?.removeFile(file.path);

    // In the rename handler:
    this.embeddingIndexer?.removeFile(oldPath);
    this.embeddingIndexer?.queueFile(file.path);
```

- [ ] **Step 5: Clean up in onunload**

```typescript
    this.embeddingIndexer?.stop();
    this.embeddingEngine?.destroy();
    setEmbeddingSearch(null);
```

- [ ] **Step 6: Build and test**

Run: `npm run build && npm run test`
Expected: Both pass.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat(embeddings): wire engine, indexer, search into plugin lifecycle"
```

---

### Task 10: Build Config & Final Verification

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add embeddingWorker.js to gitignore**

Add under `# Build output`:
```
embeddingWorker.js
```

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: `main.js`, `floatingRecorder.html`, and `embeddingWorker.js` all exist at repo root.

- [ ] **Step 3: Run all tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 4: Verify output files**

```bash
ls -la main.js floatingRecorder.html embeddingWorker.js
```

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "build: add embeddingWorker.js to gitignore"
```

- [ ] **Step 6: Copy to Obsidian plugin folder**

```bash
cp main.js styles.css floatingRecorder.html embeddingWorker.js /path/to/vault/.obsidian/plugins/open-brain/
```
