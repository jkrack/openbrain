# Local Embeddings — Design Spec

## Overview

Add local semantic search to OpenBrain using Transformers.js + ONNX embedding models running entirely in-browser. Notes are embedded at two granularities (whole-note and per-section) to enable both note discovery and passage retrieval. Embeddings power an upgraded smart context system and a new `vault_semantic_search` tool, with graceful fallback to keyword matching when not enabled.

## Motivation

OpenBrain's current `smartContext.ts` matches user messages against note metadata (basenames, titles, tags, aliases) — never the actual content. A question like "what did we decide about the mobile launch?" won't find a meeting note unless "mobile" or "launch" appears in the filename or tags. With embeddings, the system understands conceptual similarity: notes about "delayed timeline", "backend blockers", or "April shipping target" surface alongside exact keyword matches.

The vault (~856 files) is small enough for brute-force cosine similarity over in-memory vectors. No external server, no API key, no data leaving the machine. Same privacy story as the local STT.

## Architecture

### Component Overview

Five new modules, five modified:

#### `src/embeddingEngine.ts` — Model Loading & Inference

Manages a Web Worker that runs Transformers.js. Provides a Promise-based API to the rest of the plugin.

**Interface:**
- `init(modelId: string, modelDir: string): Promise<void>` — Load ONNX model in worker. Downloads from HuggingFace on first use via Transformers.js auto-download.
- `embed(text: string): Promise<Float32Array>` — Embed a single string.
- `embedBatch(texts: string[]): Promise<Float32Array[]>` — Embed multiple strings sequentially in the worker.
- `destroy(): void` — Terminate the worker.
- `isReady(): boolean` — Whether the model is loaded and ready.

**Web Worker (`src/embeddingWorker.js`):**
- Runs in a separate thread — embedding computation never blocks the UI.
- Loads the ONNX model via `@huggingface/transformers` pipeline.
- Communicates via `postMessage` / `onmessage`.
- Model files cached at `~/.openbrain/models/embed/{model-name}/`.

**Error handling:** If the model fails to load, `isReady()` returns false and all callers fall back to keyword matching.

#### `src/embeddingIndex.ts` — Vector Store

In-memory vector index with binary persistence.

**Data structure:**
```typescript
interface NoteVectors {
  path: string;
  mtime: number;
  noteVector: Float32Array;       // whole-note embedding
  sections: SectionVector[];      // per-heading embeddings
}

interface SectionVector {
  heading: string;                // "## Key Decisions"
  text: string;                   // actual section content (for passage injection)
  vector: Float32Array;
}
```

Stored as `Map<string, NoteVectors>` in memory.

**Similarity search:** Cosine similarity, brute-force scan. For ~8,000 vectors at 384 dimensions, a full scan takes <5ms.

**Persistence:** Binary file at `~/.openbrain/embeddings/index-{model-id}.bin`.

Format:
- Header: version byte (uint8, currently 1), model ID (length-prefixed UTF-8), dimension count (uint16), entry count (uint32)
- Per entry: path (length-prefixed), mtime (float64), note vector (raw float32s), section count (uint16), per section: heading (length-prefixed), text (length-prefixed), vector (raw float32s)

Binary chosen over JSON because ~8,000 vectors × 384 floats × 4 bytes = ~12MB raw. JSON with base64 would be ~16MB and slow to parse. Binary loads in <100ms.

**Model switching:** Filename includes model ID. Switching models ignores/deletes the old file and triggers full re-index.

**API:**
- `add(path, mtime, noteVector, sections[])`
- `remove(path)`
- `has(path, mtime): boolean` — Check if file is indexed at the given mtime
- `searchNotes(queryVector, limit): NoteMatch[]`
- `searchPassages(queryVector, limit, minScore): PassageMatch[]`
- `save(filePath): Promise<void>`
- `load(filePath): Promise<void>`
- `clear(): void`
- `stats(): { noteCount, sectionCount, sizeBytes }`

#### `src/embeddingIndexer.ts` — Background Vault Indexer

Orchestrates initial and incremental indexing.

**Progressive indexing on startup:**
1. Load persisted index from disk
2. Diff against vault — collect new files (not in index), modified files (mtime changed), deleted files (in index but not in vault)
3. Remove deleted entries
4. Queue new/modified files
5. Process in batches of 10 files with 50ms `setTimeout` yield between batches
6. Save index to disk after each batch (crash-safe incremental persistence)

**Note splitting:**
1. Read file content
2. Strip YAML frontmatter
3. Create whole-note embedding (full text, truncated to model's max token limit)
4. Split at `##` and `###` headings into sections
5. Embed each section with >20 words (skip trivial/empty sections)
6. Store section text alongside vector for later passage injection

**Incremental updates on vault events:**
- `create` → queue for embedding
- `modify` → queue for re-embedding (debounced 2 seconds per path)
- `delete` → remove from index immediately
- `rename` → remove old path, queue new path

Debounce: if a file is modified multiple times rapidly (auto-save), only the final version is embedded. 2-second debounce per file path. Queue deduplicates by path.

**Pause/resume:**
- Pauses when `FloatingRecorder.isRecording` is true
- Pauses when STT transcription is actively processing (`processSession`)
- Resumes automatically when recording/transcription completes
- Manual pause available via settings
- STT and recording always get priority — indexing happens in quiet moments

**Progress reporting:**
Callback: `onProgress(indexed: number, total: number, status: "downloading" | "indexing" | "ready" | "paused" | "error")`

Consumed by:
- Status bar: `🧠 Indexing 142/856` → `🧠 856 notes` → `🧠 Paused`
- Settings panel: detailed progress bar, file counts, size, last indexed time

#### `src/embeddingSearch.ts` — Search Interface

Takes a query string, embeds it, runs similarity against the index.

**Two search modes:**

`searchNotes(query, limit)` → `NoteMatch[]`:
- Embed the query via `embeddingEngine.embed()`
- Compare against all note-level vectors
- Return top N matches above a minimum score threshold (0.3)
- Returns: `{ path, score, basename }`

`searchPassages(query, limit)` → `PassageMatch[]`:
- Embed the query
- Compare against all section-level vectors
- Return top N matches above a higher threshold (0.5 — passages need to be more relevant)
- Returns: `{ path, heading, text, score }`

Both searches <10ms for the full index.

#### Modified: `src/smartContext.ts`

`buildSmartContext` gains a new code path:

When embeddings are available (`embeddingSearch.isReady()`):
1. Passage search → top 3 passages (score > 0.5)
2. Note search → top 3 notes (excluding notes already covered by passages)
3. Inject into system prompt:
```
--- Relevant context from your vault ---

From "2026-03-15 Product Sync" > Key Decisions:
Mobile launch pushed to April. Backend team blocked on auth migration.

From "1:1 Sarah" > Action Items:
Sarah to finalize the API contract by Friday.

Related notes (read if helpful):
- Meetings/2026-03-10-Launch-Planning.md
- Projects/Mobile App.md
```

When embeddings are NOT available: existing keyword matching, unchanged.

#### Modified: `src/tools.ts` + `src/toolEngine.ts`

New tool `vault_semantic_search`:
```typescript
{
  name: "vault_semantic_search",
  description: "Find notes and passages semantically related to a query. Uses embedding-based similarity, not keyword matching. Returns both relevant note paths and specific passage excerpts.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language search query" },
      limit: { type: "number", description: "Max results (default 5)" }
    },
    required: ["query"]
  }
}
```

Returns formatted results with note matches and passage excerpts. Only available when embeddings are enabled and index is ready.

#### Modified: `src/settings.ts`

New "Semantic search" section:

**Enable toggle:** "Enable semantic search" — default off. Turning on triggers model download and initial indexing.

**Model picker:** Models displayed on a Fast ↔ Accurate spectrum, not a raw dropdown:

| Model | Size | Dims | Tokens | Quality |
|-------|------|------|--------|---------|
| BGE-micro-v2 (default) | ~20MB | 384 | 512 | ■□□□□ |
| Snowflake Arctic XS | ~25MB | 384 | 512 | ■■□□□ |
| GTE-tiny | ~25MB | 384 | 512 | ■■□□□ |
| Nomic-embed-v1.5 | ~100MB | 768 | 2048 | ■■■■□ |
| Jina-v2-small-en | ~80MB | 512 | 8192 | ■■■■■ |

Each row shows model name, download size, dimensions, and a quality indicator. Selected model is highlighted.

**Re-index warning:** When selecting a different model: "Switching models requires re-indexing your entire vault. This will take a few minutes. Continue?" with Cancel/Switch buttons.

**Index status:**
- Downloading: "Downloading BGE-micro-v2 (12/20 MB)..."
- Indexing: "Indexing vault... 142/856 notes" with progress bar
- Ready: "Ready — 856 notes indexed (4,231 sections) · 11.2 MB · Last indexed 2 min ago"
- Paused: "Paused — recording in progress"

#### Modified: `src/main.ts`

- Initialize `embeddingEngine` and `embeddingIndexer` inside `onLayoutReady` when embeddings are enabled
- Wire vault event listeners to indexer (create/modify/delete/rename)
- Update status bar with indexing progress
- Pass `isRecording` state to indexer for pause/resume
- Clean up engine and indexer in `onunload`

#### Build: `esbuild.config.mjs`

- Bundle `embeddingWorker.js` as a separate esbuild entrypoint (it imports `@huggingface/transformers`, so it needs its own bundle — not a simple file copy like `floatingRecorder.html`)

#### Dependencies: `package.json`

- Add `@huggingface/transformers` — Transformers.js library for ONNX model inference

## Resource Isolation

STT (sherpa-onnx child process) and embeddings (Web Worker) run in separate execution contexts and won't block each other. However, to avoid resource contention during recording:

- **Indexer pauses during active recording** — checks `FloatingRecorder.isRecording`
- **Indexer pauses during transcription** — waits for `processSession` to complete
- **Single-file updates are queued, not processed** — debounced and held until quiet
- **Recording and transcription always get priority** — they're time-sensitive; indexing is not

## Storage Layout

```
~/.openbrain/
  models/
    embed/
      bge-micro-v2/          # Transformers.js auto-cached ONNX files
        model.onnx
        tokenizer.json
        ...
  embeddings/
    index-bge-micro-v2.bin   # Binary vector index
```

## Graceful Degradation

- Embeddings disabled → keyword matching (today's behavior, zero change)
- Model not downloaded yet → keyword matching + "Download model in Settings" notice
- Index still building → keyword matching for unindexed files, embeddings for indexed ones
- Model fails to load → keyword matching + error in settings panel
- Index file corrupt/missing → full re-index on next startup

## New Files
- `src/embeddingEngine.ts`
- `src/embeddingWorker.js`
- `src/embeddingIndex.ts`
- `src/embeddingIndexer.ts`
- `src/embeddingSearch.ts`

## Modified Files
- `src/smartContext.ts` — embedding search with keyword fallback
- `src/tools.ts` — `vault_semantic_search` definition
- `src/toolEngine.ts` — `vault_semantic_search` execution
- `src/settings.ts` — embedding section with model picker and index status
- `src/main.ts` — engine/indexer lifecycle, status bar, recording pause
- `esbuild.config.mjs` — add second entrypoint to bundle the worker
- `package.json` — add `@huggingface/transformers`

## Not Modified
- `src/vaultIndex.ts` — Stays as-is for metadata search (@ mentions, backlinks, tags). Embeddings complement it, don't replace it.
- Existing tools (`vault_search`, `vault_search_context`, etc.) — Unchanged. Semantic search is additive.
- `src/chatEngine.ts` — No changes. Smart context injection happens before chat engine runs.
