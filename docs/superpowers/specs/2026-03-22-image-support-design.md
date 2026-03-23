# Image Support Design Spec

## Problem

OpenBrain has partial image support — clipboard paste detection and provider encoding work, but images are not stored in messages, not rendered in the chat thread, not persisted in chat history, and not extractable from vault notes. Users paste an image and nothing visible happens.

## Goals

1. Fix the broken paste-to-chat flow so pasted images appear in the conversation and reach the LLM
2. Support drag-and-drop image attachment
3. Auto-extract images from vault notes referenced in context (`![[image.png]]`)
4. Allow @-referencing image files directly from the input area
5. Persist images across sessions without bloating chat files
6. Make images discoverable through the existing text embedding search
7. Work on both desktop and mobile

## Non-Goals

- Vision embeddings (CLIP/multimodal vector search) — future project
- Image generation or editing
- PDF/document rendering (raster images only)
- SVG support — excluded due to XSS risk (SVGs can contain `<script>` tags and execute in Electron). Providers also reject `image/svg+xml`.
- Video support

---

## Data Model

### ImageAttachment

The core unit for all image sources:

```typescript
interface ImageAttachment {
  id: string;              // generated via Math.random().toString(36).slice(2, 10), same as message IDs
  source: "paste" | "vault" | "drop" | "context";
  vaultPath?: string;      // for vault/context images — path to original file
  assetPath?: string;      // for paste/drop — saved copy in assets folder
  mediaType: string;       // image/png, image/jpeg, image/gif, image/webp
  width?: number;          // intrinsic dimensions (from image header)
  height?: number;
  sizeBytes: number;       // original file size
}
```

Note: `caption` is deferred to a future iteration to avoid scope creep. The initial implementation focuses on ingestion, display, and persistence.

### Message Extension

Add `images?: ImageAttachment[]` to the existing `Message` interface in `src/providers/types.ts`. This is the only change to the shared types.

### Storage Layout

Pasted and dropped images are saved to the vault:

```
OpenBrain/chats/assets/<chatId>/<attachmentId>.<ext>
```

Vault-sourced images stay in their original location — referenced by `vaultPath`, no copy made.

### Chat History Serialization

Images are encoded into the message delimiter comment itself, extending the existing format. This avoids the problem of a separate `<!-- images: -->` comment being consumed as message content by the existing lazy regex.

**Format version 1 (current):**
```
<!-- msg:abc123:user:1711100000000:false -->
```

**Format version 2 (with images):**
```
<!-- msg:abc123:user:1711100000000:false:IMAGES_JSON_BASE64 -->
```

The 6th field is the `ImageAttachment[]` array serialized as JSON then base64-encoded (to avoid `:` and `-->` conflicts in the comment). When absent, the message has no images.

Bump `format_version` in frontmatter to `2` when any message has images. `parseChat` accepts both version 1 and 2. Old plugin versions reject version 2 (existing behavior at line 122).

**Updated parseChat regex:**
```
/<!-- msg:([^:]+):([^:]+):(\d+):(true|false)(?::([A-Za-z0-9+/=]+))? -->\n### (?:User|Assistant)\n([\s\S]*?)(?=\n\n<!-- msg:|$)/g
```

The 5th capture group `([A-Za-z0-9+/=]+)` is optional (the `?:` non-capturing group wraps the colon + base64). When present, decode base64 → JSON → `ImageAttachment[]`.

The JSON array contains `ImageAttachment` metadata only — no base64 image data in chat files.

---

## Attachment Manager

New module: `src/attachmentManager.ts`

Owns the full image lifecycle — ingestion, storage, retrieval, and cleanup.

### API

```typescript
class AttachmentManager {
  constructor(app: App)

  // Ingest from any source
  addFromClipboard(blob: Blob, chatId: string): Promise<ImageAttachment>
  addFromDrop(file: File, chatId: string): Promise<ImageAttachment>
  addFromVault(vaultPath: string): Promise<ImageAttachment>

  // Batch extract from note content (finds ![[image.png]] references)
  extractFromNote(content: string): Promise<ImageAttachment[]>

  // Read image data on-demand (for API calls and rendering)
  // Returns null if the source file is missing (deleted, sync conflict)
  readAsBase64(attachment: ImageAttachment): Promise<string | null>
  readAsDataUrl(attachment: ImageAttachment): Promise<string | null>

  // Persistence
  saveToAssets(blob: Blob, chatId: string, id: string, ext: string): Promise<string>

  // Lifecycle
  removeAttachment(id: string): void
  cleanOrphanedAssets(): Promise<number>
}
```

### Behaviors

**addFromClipboard / addFromDrop:**
1. Generate attachment ID
2. Determine media type and extension from blob/file
3. Compress if over 2MB (resize to max 2048px longest side, re-encode as JPEG 85%)
4. Save to `OpenBrain/chats/assets/<chatId>/<id>.<ext>` via `app.vault.createBinary()`
5. Read image dimensions from header
6. Return `ImageAttachment` with `assetPath` set

**addFromVault:**
1. Validate file exists via `app.vault.getAbstractFileByPath()`
2. Read binary to get `sizeBytes` and dimensions
3. Return `ImageAttachment` with `vaultPath` set, no copy made

**extractFromNote:**
1. Regex scan for `![[*.png]]`, `![[*.jpg]]`, `![[*.jpeg]]`, `![[*.gif]]`, `![[*.webp]]` (SVG excluded — XSS risk, providers reject it)
2. Resolve each via `app.metadataCache.getFirstLinkpathDest()`
3. Call `addFromVault()` for each resolved image, with `source: "context"`
4. Skip unresolved references silently

**readAsBase64:**
1. Read from `assetPath` or `vaultPath` via `app.vault.readBinary()`
2. Convert `ArrayBuffer` to base64 string
3. If the file is missing (deleted, sync conflict), return `null` instead of throwing
4. This is the only place binary reads happen — called when sending to API or rendering thumbnails

**saveToAssets (folder creation):**
Uses the same guard pattern as `chatHistory.ts:179-189` — check `app.vault.getAbstractFileByPath()` before `app.vault.createFolder()` to handle concurrent calls safely.

**cleanOrphanedAssets:**
1. List all files in `OpenBrain/chats/assets/`
2. Scan all chat files for image references
3. Delete asset files with no references
4. Return count of files removed
5. Opt-in only — available from settings as a manual cleanup button. Not automatic on plugin load (avoids hidden I/O cost on large vaults and mobile).

### Size Limits

- Warn at 5MB per image (Notice to user)
- Hard reject at 20MB (Anthropic API limit)
- Auto-compress PNG and JPEG images over 2MB using Canvas API (max 2048px longest side, JPEG 85%)
- GIF and WebP are NOT compressed — Canvas destroys GIF animation and WebP transparency. These are only subject to the hard 20MB reject limit.

---

## UI Components

### InputArea Changes

**Paste handler:** Rewire existing handler to use `AttachmentManager.addFromClipboard()` instead of raw FileReader. Remove the auto-switch to chat mode — images work in vault (agent) mode too.

**Drop zone:** Add `onDragOver`/`onDrop` handlers to the input area. Visual indicator: dashed border + "Drop image" overlay text when dragging over. Call `AttachmentManager.addFromDrop()`.

**@-reference images:** Extend the existing `@` file picker to include image files (currently `.md` only). When an image file is selected, call `AttachmentManager.addFromVault()` and add to pending attachments instead of `attachedFiles`.

**Pending attachments bar:** Replace current `pendingImages` preview strip with a richer component showing:
- Thumbnails (loaded via `readAsDataUrl`)
- Filename and file size
- Source badge ("pasted", "vault")
- Remove button on each

### MessageThread Changes

**User messages with images:** Render a thumbnail gallery below message text. Thumbnails loaded lazily via `IntersectionObserver` — `readAsDataUrl()` is only called when the message scrolls into view (important for long chats with many images). If `readAsBase64` returns `null` (missing file), show a broken-image placeholder with the original filename.

**Lightbox:** Simple modal overlay — full-size image, left/right arrows for multiple images, close on click-outside or Escape. No external dependencies, just a positioned div.

**Context images indicator:** When images were auto-extracted from note context (`source: "context"`), show a subtle badge "N images from note" that expands to show which ones.

### No ChatHeader Changes

Image support is always available regardless of vault/chat mode.

---

## Provider & Engine Integration

### chatEngine.ts

Add `attachmentManager?: AttachmentManager` to `ChatEngineOptions`. The `images` field changes from `{ base64: string; mediaType: string }[]` to `ImageAttachment[]`.

Before the first provider call, the engine resolves images:

```typescript
let resolvedImages: { base64: string; mediaType: string }[] | undefined;
if (options.images?.length && options.attachmentManager) {
  const resolved = await Promise.all(
    options.images.map(async (img) => {
      const base64 = await options.attachmentManager!.readAsBase64(img);
      return base64 ? { base64, mediaType: img.mediaType } : null;
    })
  );
  resolvedImages = resolved.filter((r): r is { base64: string; mediaType: string } => r !== null);
}
```

Images with missing source files are silently dropped from the API call. The UI handles missing images separately via the broken-image placeholder.

This resolved array is passed to `provider.streamChat()` in the same `{ base64, mediaType }` shape providers already expect. After the first turn, `resolvedImages` is cleared (existing behavior) so images aren't re-sent on tool loop iterations.

### Provider Changes

None. All 3 providers already handle `{ base64, mediaType }` correctly in `buildMessages()`. The engine resolves attachments to this shape before passing to providers.

### smartContext.ts

`buildSmartContext` return type changes from `Promise<string>` to `Promise<{ text: string; images: ImageAttachment[] }>`. All code paths (embedding search, keyword fallback, early returns) must return this shape. The keyword fallback path returns `{ text: "...", images: [] }` since it does not extract images.

When building context from a note, call `AttachmentManager.extractFromNote()` on the note content. Return extracted images alongside the existing text context string.

**panel.tsx caller update:**

```typescript
const smartCtx = await buildSmartContext(app, userText, attachedFiles, getEmbeddingSearch(), attachmentManager);
const contextImages = smartCtx.images;
const allContext = [noteContext, recentContext, smartCtx.text].filter(Boolean).join("");

// Merge context images with user-attached images
const allImages = [...pendingAttachments, ...contextImages];
```

The merged `allImages` array is passed as `ChatEngineOptions.images`.

---

## Chat History Persistence

### serializeChat Changes

When building the message delimiter comment, if `msg.images?.length > 0`, append a 6th field containing the `ImageAttachment[]` as base64-encoded JSON:

```typescript
// Unicode-safe base64: handles non-ASCII vault paths (accented chars, CJK, emoji)
const toBase64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const fromBase64 = (s: string) => decodeURIComponent(escape(atob(s)));

const imagesField = msg.images?.length
  ? ":" + toBase64(JSON.stringify(msg.images))
  : "";
return `<!-- msg:${m.id}:${m.role}:${ts}:${audio}${imagesField} -->`;
```

Set `format_version: 2` in frontmatter when any message has images.

### parseChat Changes

Update the regex to capture the optional 6th field (see Data Model section for exact pattern). Accept both format version 1 and 2. When the 6th capture group is present, decode: `JSON.parse(fromBase64(match[5]))` → `ImageAttachment[]`.

The `extractFromNote` regex should use case-insensitive matching for extensions (`.PNG`, `.JPG` are common from screenshots and cameras).

### Asset Lifecycle

- **On paste/drop:** Immediately saved to `OpenBrain/chats/assets/<chatId>/`
- **On chat delete:** Assets subfolder cleaned up
- **From settings:** Manual orphan cleanup button (opt-in only, not automatic)

---

## Embedding Enrichment (Level 1)

### embeddingIndexer Changes

During text chunking, when the chunker encounters `![[filename.ext]]` where ext matches an image type:

- Replace with `[Image: filename.ext]`
- If alt text present (`![[file.png|alt text here]]`), use: `[Image: alt text here (file.png)]`

This makes images discoverable via text search ("diagram", "screenshot", "architecture") without any new embedding model or pipeline.

---

## Mobile Considerations

- Paste and vault image features work on mobile (no Node.js dependencies)
- `app.vault.readBinary()` and `app.vault.createBinary()` work on mobile
- Drop zone is desktop-only — iOS Safari does not support `onDrop` for files. Mobile users attach images via paste (which is the standard mobile workflow)
- Image compression uses Canvas API (available in all browsers)
- Asset storage in vault folder syncs normally via Obsidian Sync/iCloud
- No `fs`, `path`, `os`, or `child_process` imports in `attachmentManager.ts` or any new code
- Note: `embeddingIndexer.ts` already has Node.js imports — the enrichment change inherits those existing dependencies and only runs on desktop

---

## Files Modified

| File | Change |
|------|--------|
| `src/attachmentManager.ts` | **New** — full attachment lifecycle manager |
| `src/providers/types.ts` | Add `images?: ImageAttachment[]` to `Message`, export `ImageAttachment` |
| `src/panel.tsx` | Rewire paste handler, add drop zone, pass attachments to messages, remove chat mode auto-switch |
| `src/components/MessageThread.tsx` | Render image thumbnails in messages, lightbox component |
| `src/components/InputArea.tsx` | @-reference image files, pending attachments bar |
| `src/chatHistory.ts` | Serialize/parse images in chat files |
| `src/chatEngine.ts` | Resolve `ImageAttachment[]` to base64 on-demand before API call |
| `src/smartContext.ts` | Extract images from note content |
| `src/embeddingIndexer.ts` | Replace image wiki-links with searchable text tokens |
| `styles.css` | Drop zone, lightbox, thumbnail gallery, attachment bar styles |

## Files Not Modified

- `src/providers/anthropic.ts`, `openrouter.ts`, `ollama.ts` — already handle images correctly. `ChatOptions.images` keeps its existing `{ base64: string; mediaType: string }[]` type — the engine resolves `ImageAttachment[]` to this shape before passing to providers.
- `src/main.ts` — no new lifecycle hooks needed
- `src/settings.ts` — orphan cleanup button available in a follow-up
