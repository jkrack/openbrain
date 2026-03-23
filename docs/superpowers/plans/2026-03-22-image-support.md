# Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full image support to OpenBrain — paste, drag-and-drop, vault image extraction, @-references, chat history persistence, and embedding enrichment.

**Architecture:** New `AttachmentManager` class owns image lifecycle (ingest, save, read, cleanup). Images stored as vault files in `OpenBrain/chats/assets/`. Chat history encodes image metadata as base64 JSON in the message delimiter comment. Providers are untouched — the chat engine resolves `ImageAttachment[]` to `{ base64, mediaType }[]` on-demand before API calls.

**Tech Stack:** TypeScript, React, Obsidian API (`app.vault.readBinary`, `app.vault.createBinary`, `app.metadataCache.getFirstLinkpathDest`), Canvas API for compression, IntersectionObserver for lazy loading.

**Spec:** `docs/superpowers/specs/2026-03-22-image-support-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/providers/types.ts` | Modify | Add `ImageAttachment` interface, add `images?` to `Message` |
| `src/attachmentManager.ts` | Create | Image lifecycle: ingest, save, read, compress, cleanup |
| `src/chatHistory.ts` | Modify | Serialize/parse images in chat delimiter comments |
| `src/chatEngine.ts` | Modify | Accept `ImageAttachment[]`, resolve to base64 before provider call |
| `src/smartContext.ts` | Modify | Return `{ text, images }`, extract images from note content |
| `src/panel.tsx` | Modify | Rewire paste handler, pass attachments through, remove mode auto-switch |
| `src/components/InputArea.tsx` | Modify | Drop zone, @-reference images, pending attachments bar |
| `src/components/MessageThread.tsx` | Modify | Render image thumbnails, lightbox, broken-image fallback |
| `src/components/ImageLightbox.tsx` | Create | Modal overlay for full-size image viewing |
| `src/embeddingIndexer.ts` | Modify | Replace image wiki-links with searchable text tokens |
| `styles.css` | Modify | Drop zone, lightbox, thumbnail gallery, attachment bar styles |
| `src/__tests__/attachmentManager.test.ts` | Create | Unit tests for AttachmentManager |
| `src/__tests__/chatHistory.test.ts` | Modify | Tests for v2 image serialization/parsing |

---

### Task 1: ImageAttachment Type + Message Extension

**Files:**
- Modify: `src/providers/types.ts`
- Test: `src/__tests__/chatHistory.test.ts` (type used there)

- [ ] **Step 1: Add ImageAttachment interface and extend Message**

In `src/providers/types.ts`, add after the `Message` interface:

```typescript
/** Image attached to a chat message */
export interface ImageAttachment {
  id: string;
  source: "paste" | "vault" | "drop" | "context";
  vaultPath?: string;
  assetPath?: string;
  mediaType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
}
```

Add `images?: ImageAttachment[]` to the `Message` interface.

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Clean build, no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: add ImageAttachment type and images field to Message"
```

---

### Task 2: AttachmentManager Core — Save and Read

**Files:**
- Create: `src/attachmentManager.ts`
- Create: `src/__tests__/attachmentManager.test.ts`

- [ ] **Step 1: Write failing tests for saveToAssets and readAsBase64**

Create `src/__tests__/attachmentManager.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => {
  class MockTFile {
    path: string;
    stat: { size: number };
    constructor(path: string, size = 1000) {
      this.path = path;
      this.stat = { size };
    }
  }
  return {
    App: class {},
    TFile: MockTFile,
    TFolder: class {},
    Notice: class {},
  };
});

import { TFile } from "obsidian";
import { AttachmentManager } from "../attachmentManager";

function mockApp(files: Record<string, ArrayBuffer> = {}): any {
  return {
    vault: {
      getAbstractFileByPath: vi.fn((p: string) => {
        if (files[p]) return Object.assign(Object.create(TFile.prototype), { path: p, stat: { size: files[p].byteLength } });
        return null;
      }),
      createBinary: vi.fn(async () => {}),
      createFolder: vi.fn(async () => {}),
      readBinary: vi.fn(async (file: any) => files[file.path] || new ArrayBuffer(0)),
    },
    metadataCache: {
      getFirstLinkpathDest: vi.fn(() => null),
    },
  };
}

describe("AttachmentManager", () => {
  describe("saveToAssets", () => {
    it("saves blob to correct path and creates folders", async () => {
      const app = mockApp();
      const mgr = new AttachmentManager(app);
      const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], { type: "image/png" });

      const path = await mgr.saveToAssets(blob, "chat-abc", "img1", "png");

      expect(path).toBe("OpenBrain/chats/assets/chat-abc/img1.png");
      expect(app.vault.createBinary).toHaveBeenCalledWith(
        path,
        expect.any(ArrayBuffer)
      );
    });
  });

  describe("readAsBase64", () => {
    it("returns base64 string for existing asset", async () => {
      const data = new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer;
      const app = mockApp({ "OpenBrain/chats/assets/chat-abc/img1.png": data });
      const mgr = new AttachmentManager(app);

      const result = await mgr.readAsBase64({
        id: "img1",
        source: "paste",
        assetPath: "OpenBrain/chats/assets/chat-abc/img1.png",
        mediaType: "image/png",
        sizeBytes: 4,
      });

      expect(result).toBeTruthy();
      expect(typeof result).toBe("string");
    });

    it("returns null for missing file", async () => {
      const app = mockApp();
      app.vault.readBinary.mockRejectedValue(new Error("File not found"));
      const mgr = new AttachmentManager(app);

      const result = await mgr.readAsBase64({
        id: "img1",
        source: "paste",
        assetPath: "OpenBrain/chats/assets/missing.png",
        mediaType: "image/png",
        sizeBytes: 0,
      });

      expect(result).toBeNull();
    });
  });

  describe("readAsDataUrl", () => {
    it("returns data URL with correct media type", async () => {
      const data = new Uint8Array([0x89, 0x50]).buffer;
      const app = mockApp({ "assets/img.png": data });
      const mgr = new AttachmentManager(app);

      const result = await mgr.readAsDataUrl({
        id: "img1",
        source: "paste",
        assetPath: "assets/img.png",
        mediaType: "image/png",
        sizeBytes: 2,
      });

      expect(result).toMatch(/^data:image\/png;base64,/);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/attachmentManager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement AttachmentManager**

Create `src/attachmentManager.ts`:

```typescript
import { App, TFile, Notice } from "obsidian";
import { ImageAttachment } from "./providers/types";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const MAX_SIZE = 20 * 1024 * 1024; // 20MB hard limit
const COMPRESS_THRESHOLD = 2 * 1024 * 1024; // 2MB
const WARN_SIZE = 5 * 1024 * 1024; // 5MB

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return map[mime] || "png";
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext.toLowerCase()] || "image/png";
}

export class AttachmentManager {
  constructor(private app: App) {}

  async addFromClipboard(blob: Blob, chatId: string): Promise<ImageAttachment | null> {
    if (blob.size > MAX_SIZE) {
      new Notice(`Image too large (${(blob.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.`);
      return null;
    }
    if (blob.size > WARN_SIZE) {
      new Notice(`Large image (${(blob.size / 1024 / 1024).toFixed(1)}MB) — may be slow to send.`);
    }

    const id = generateId();
    const mediaType = blob.type || "image/png";
    const ext = mimeToExt(mediaType);
    const finalBlob = await this.maybeCompress(blob, mediaType);
    const assetPath = await this.saveToAssets(finalBlob, chatId, id, ext);

    return {
      id,
      source: "paste",
      assetPath,
      mediaType,
      sizeBytes: finalBlob.size,
    };
  }

  async addFromDrop(file: File, chatId: string): Promise<ImageAttachment | null> {
    if (!file.type.startsWith("image/")) return null;
    if (file.size > MAX_SIZE) {
      new Notice(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.`);
      return null;
    }
    if (file.size > WARN_SIZE) {
      new Notice(`Large image (${(file.size / 1024 / 1024).toFixed(1)}MB) — may be slow to send.`);
    }

    const id = generateId();
    const mediaType = file.type;
    const ext = mimeToExt(mediaType);
    const blob = new Blob([await file.arrayBuffer()], { type: mediaType });
    const finalBlob = await this.maybeCompress(blob, mediaType);
    const assetPath = await this.saveToAssets(finalBlob, chatId, id, ext);

    return {
      id,
      source: "drop",
      assetPath,
      mediaType,
      sizeBytes: finalBlob.size,
    };
  }

  async addFromVault(vaultPath: string): Promise<ImageAttachment | null> {
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) return null;
    if (!IMAGE_EXTENSIONS.test(file.path)) return null;

    const ext = file.path.split(".").pop()?.toLowerCase() || "png";

    return {
      id: generateId(),
      source: "vault",
      vaultPath: file.path,
      mediaType: extToMime(ext),
      sizeBytes: file.stat.size,
    };
  }

  async extractFromNote(content: string): Promise<ImageAttachment[]> {
    const regex = /!\[\[([^\]]+\.(png|jpe?g|gif|webp))(?:\|[^\]]*)?\]\]/gi;
    const attachments: ImageAttachment[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const linkPath = match[1];
      const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, "");
      if (resolved instanceof TFile) {
        const att = await this.addFromVault(resolved.path);
        if (att) {
          att.source = "context";
          attachments.push(att);
        }
      }
    }

    return attachments;
  }

  async readAsBase64(attachment: ImageAttachment): Promise<string | null> {
    const path = attachment.assetPath || attachment.vaultPath;
    if (!path) return null;

    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return null;
      const buffer = await this.app.vault.readBinary(file);
      return arrayBufferToBase64(buffer);
    } catch {
      return null;
    }
  }

  async readAsDataUrl(attachment: ImageAttachment): Promise<string | null> {
    const base64 = await this.readAsBase64(attachment);
    if (!base64) return null;
    return `data:${attachment.mediaType};base64,${base64}`;
  }

  async saveToAssets(blob: Blob, chatId: string, id: string, ext: string): Promise<string> {
    const folder = `OpenBrain/chats/assets/${chatId}`;
    await this.ensureFolder(folder);

    const path = `${folder}/${id}.${ext}`;
    const buffer = await blob.arrayBuffer();
    await this.app.vault.createBinary(path, buffer);
    return path;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try { await this.app.vault.createFolder(current); } catch { /* exists */ }
      }
    }
  }

  private async maybeCompress(blob: Blob, mediaType: string): Promise<Blob> {
    // Only compress PNG and JPEG — GIF loses animation, WebP loses transparency
    if (blob.size <= COMPRESS_THRESHOLD) return blob;
    if (mediaType !== "image/png" && mediaType !== "image/jpeg") return blob;

    try {
      const bitmap = await createImageBitmap(blob);
      const maxDim = 2048;
      let { width, height } = bitmap;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();

      const compressed = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
      return compressed.size < blob.size ? compressed : blob;
    } catch {
      return blob; // Canvas not available or error — return original
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/attachmentManager.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/attachmentManager.ts src/__tests__/attachmentManager.test.ts
git commit -m "feat: add AttachmentManager for image lifecycle"
```

---

### Task 3: Chat History — Image Serialization and Parsing

**Files:**
- Modify: `src/chatHistory.ts:74-99` (serializeChat), `src/chatHistory.ts:103-163` (parseChat)
- Modify: `src/__tests__/chatHistory.test.ts`

- [ ] **Step 1: Write failing tests for v2 image serialization/parsing**

Add to `src/__tests__/chatHistory.test.ts`:

```typescript
import type { ImageAttachment } from "../providers/types";

describe("v2 image serialization", () => {
  const testImage: ImageAttachment = {
    id: "img1",
    source: "paste",
    assetPath: "OpenBrain/chats/assets/abc/img1.png",
    mediaType: "image/png",
    sizeBytes: 5000,
  };

  it("round-trips messages with images", () => {
    const msgs: Message[] = [
      makeMsg({ id: "m1", role: "user", content: "Look at this", images: [testImage] }),
      makeMsg({ id: "m2", role: "assistant", content: "I see a diagram" }),
    ];
    const meta = makeMeta({ formatVersion: 2 });
    const serialized = serializeChat(msgs, meta);
    const parsed = parseChat(serialized, "test.md");

    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.messages).toHaveLength(2);
      expect(parsed.messages[0].images).toHaveLength(1);
      expect(parsed.messages[0].images![0].id).toBe("img1");
      expect(parsed.messages[0].images![0].assetPath).toBe("OpenBrain/chats/assets/abc/img1.png");
      expect(parsed.messages[1].images).toBeUndefined();
    }
  });

  it("serializes format_version 2 when images present", () => {
    const msgs: Message[] = [
      makeMsg({ id: "m1", role: "user", content: "Hello", images: [testImage] }),
    ];
    const meta = makeMeta({ formatVersion: 2 });
    const serialized = serializeChat(msgs, meta);
    expect(serialized).toContain("format_version: 2");
  });

  it("parses v1 format without images (backward compat)", () => {
    const msgs: Message[] = [makeMsg({ id: "m1", role: "user", content: "Hello" })];
    const meta = makeMeta({ formatVersion: 1 });
    const serialized = serializeChat(msgs, meta);
    const parsed = parseChat(serialized, "test.md");

    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.messages[0].images).toBeUndefined();
    }
  });

  it("handles non-ASCII vault paths in images", () => {
    const unicodeImage: ImageAttachment = {
      ...testImage,
      vaultPath: "Notes/日本語/図.png",
    };
    const msgs: Message[] = [
      makeMsg({ id: "m1", role: "user", content: "Check this", images: [unicodeImage] }),
    ];
    const meta = makeMeta({ formatVersion: 2 });
    const serialized = serializeChat(msgs, meta);
    const parsed = parseChat(serialized, "test.md");

    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.messages[0].images![0].vaultPath).toBe("Notes/日本語/図.png");
    }
  });
});
```

Update the `makeMsg` helper to accept `images`:

```typescript
function makeMsg(overrides: Partial<Message> & { id: string; role: "user" | "assistant"; content: string }): Message {
  return {
    timestamp: new Date("2026-03-15T10:00:00Z"),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/chatHistory.test.ts`
Expected: FAIL — images field not serialized.

- [ ] **Step 3: Update serializeChat for v2 format**

In `src/chatHistory.ts`, update `serializeChat`:

```typescript
// Unicode-safe base64 helpers
function toBase64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

function fromBase64(s: string): string {
  return decodeURIComponent(escape(atob(s)));
}
```

In the `messageParts` map, update the return:

```typescript
const imagesField = m.images?.length
  ? ":" + toBase64(JSON.stringify(m.images))
  : "";
return `<!-- msg:${m.id}:${m.role}:${ts}:${audio}${imagesField} -->\n### ${roleLabel}\n${m.content}`;
```

- [ ] **Step 4: Update parseChat for v2 format**

Update the regex:

```typescript
const msgRegex = /<!-- msg:([^:]+):([^:]+):(\d+):(true|false)(?::([A-Za-z0-9+/=]+))? -->\n### (?:User|Assistant)\n([\s\S]*?)(?=\n\n<!-- msg:|$)/g;
```

Update the message parsing to extract images from the 5th capture group:

```typescript
while ((match = msgRegex.exec(body)) !== null) {
  let images: ImageAttachment[] | undefined;
  if (match[5]) {
    try {
      images = JSON.parse(fromBase64(match[5]));
    } catch { /* corrupt images data — skip */ }
  }
  messages.push({
    id: match[1],
    role: match[2] as "user" | "assistant",
    content: match[6].trimEnd(),
    isAudio: match[4] === "true",
    timestamp: new Date(parseInt(match[3], 10)),
    images,
  });
}
```

Update the format version check to accept version 2:

```typescript
if (formatVersion > 2) {
  return { error: `Unsupported format_version: ${formatVersion}` };
}
```

Also update any existing test that asserts `format_version: 2` is rejected — change it to assert version 3 is rejected instead, since version 2 is now valid.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/chatHistory.test.ts`
Expected: All tests PASS (old tests + new v2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/chatHistory.ts src/__tests__/chatHistory.test.ts
git commit -m "feat: chat history v2 — serialize/parse image attachments"
```

---

### Task 4: Chat Engine — Resolve ImageAttachments Before API Call

**Files:**
- Modify: `src/chatEngine.ts:11-22` (ChatEngineOptions), `src/chatEngine.ts:38-50` (resolution)

- [ ] **Step 1: Update ChatEngineOptions type**

Add import for `ImageAttachment` and `AttachmentManager`. Update the interface:

```typescript
import { ImageAttachment } from "./providers/types";
import { AttachmentManager } from "./attachmentManager";

export interface ChatEngineOptions {
  messages: ChatMessage[];
  systemPrompt: string;
  allowWrite: boolean;
  images?: ImageAttachment[];
  attachmentManager?: AttachmentManager;
  useTools: boolean;
  onText: (text: string) => void;
  onToolStart: (name: string) => void;
  onToolEnd: (name: string, result: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}
```

- [ ] **Step 2: Add image resolution before the provider loop**

After `let images = opts.images;` (line 38), add:

```typescript
// Resolve ImageAttachment[] to { base64, mediaType }[] for providers
let resolvedImages: { base64: string; mediaType: string }[] | undefined;
if (images?.length && opts.attachmentManager) {
  const resolved = await Promise.all(
    images.map(async (img) => {
      const base64 = await opts.attachmentManager!.readAsBase64(img);
      return base64 ? { base64, mediaType: img.mediaType } : null;
    })
  );
  resolvedImages = resolved.filter((r): r is { base64: string; mediaType: string } => r !== null);
}
```

Update the `provider.streamChat` call to pass `resolvedImages` instead of `images`:

```typescript
images: resolvedImages,
```

After the first iteration, clear `resolvedImages` (the existing `images = undefined` line):

```typescript
images = undefined;
resolvedImages = undefined;
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/chatEngine.ts
git commit -m "feat: resolve ImageAttachment to base64 on-demand in chat engine"
```

---

### Task 5: Smart Context + Panel — Image Extraction and Full Wiring

This task combines the smartContext return type change with the panel.tsx caller update so the build never breaks between commits.

**Files:**
- Modify: `src/smartContext.ts:119-163`
- Modify: `src/panel.tsx`

- [ ] **Step 1: Update buildSmartContext return type**

In `src/smartContext.ts`, change the signature and add imports:

```typescript
import { AttachmentManager } from "./attachmentManager";
import { ImageAttachment } from "./providers/types";

export async function buildSmartContext(
  app: App,
  message: string,
  existingFiles: string[] = [],
  embeddingSearch?: EmbeddingSearch | null,
  attachmentManager?: AttachmentManager | null
): Promise<{ text: string; images: ImageAttachment[] }>
```

Update ALL return paths to return `{ text, images }`:

For the embedding search path, after building the context string:
```typescript
let images: ImageAttachment[] = [];
if (attachmentManager) {
  for (const p of newPassages) {
    const file = app.vault.getAbstractFileByPath(p.path);
    if (file instanceof TFile) {
      const content = await app.vault.cachedRead(file);
      const noteImages = await attachmentManager.extractFromNote(content);
      images.push(...noteImages);
    }
  }
}
return { text: context, images };
```

For the keyword fallback: `return { text: "...", images: [] };`
For early returns (empty results): `return { text: "", images: [] };`

Add `import { TFile } from "obsidian"` if not already present.

- [ ] **Step 2: Add AttachmentManager and ImageAttachment imports, create instance in panel.tsx**

```typescript
import { AttachmentManager } from "./attachmentManager";
import { ImageAttachment } from "./providers/types";
```

Inside the component, after the existing state declarations:

```typescript
const [pendingAttachments, setPendingAttachments] = useState<ImageAttachment[]>([]);
const attachmentManager = useRef(new AttachmentManager(app)).current;
```

- [ ] **Step 2: Replace the handlePaste effect**

Replace the existing `handlePaste` useEffect (the one that uses FileReader and `setPendingImages`) with:

```typescript
useEffect(() => {
  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;

        const chatId = chatFilePathRef.current
          ?.split("/").pop()?.replace(".md", "") || generateId();

        void (async () => {
          const attachment = await attachmentManager.addFromClipboard(blob, chatId);
          if (attachment) {
            setPendingAttachments((prev) => [...prev, attachment]);
          }
        })();
      }
    }
  };

  document.addEventListener("paste", handlePaste);
  return () => document.removeEventListener("paste", handlePaste);
}, [attachmentManager]);
```

Remove the `if (chatMode === "agent") setChatMode("chat")` line from the old paste handler.

- [ ] **Step 3: Update sendMessage to attach images to the user Message**

In the `sendMessage` callback, when creating `userMsg`, attach pending images:

```typescript
const userMsg: Message = {
  id: generateId(),
  role: "user",
  content: hasAudioInput ? `🎙 ${userText || "Voice message"}` : userText,
  isAudio: !!hasAudioInput,
  images: pendingAttachments.length > 0 ? [...pendingAttachments] : undefined,
  timestamp: new Date(),
};
```

- [ ] **Step 4: Update the runChat call to pass attachmentManager and merged images**

In the text message path, update the smart context call and image merging:

```typescript
const smartCtx = await buildSmartContext(app, userText, attachedFiles, getEmbeddingSearch(), attachmentManager);
const contextImages = smartCtx.images;
const allContext = [noteContext, recentContext, smartCtx.text].filter(Boolean).join("");

const allImages = [...pendingAttachments, ...contextImages];
```

Then in the `runChat` call:

```typescript
images: allImages.length > 0 ? allImages : undefined,
attachmentManager,
```

After the runChat call setup, clear pending attachments:

```typescript
if (pendingAttachments.length > 0) setPendingAttachments([]);
```

Also pass `attachmentManager` to the audio analysis `runChat` call (around line 581) for consistency:

```typescript
attachmentManager,
```

- [ ] **Step 5: Remove old pendingImages state and its preview UI**

Remove `pendingImages` state, `setPendingImages`, and the old `pendingImages` preview JSX block. Replace the preview section with the new pending attachments bar (Task 8 will enhance this, for now just show thumbnails):

```tsx
{pendingAttachments.length > 0 && (
  <div className="ca-attached-files">
    {pendingAttachments.map((att) => (
      <AttachmentPreview
        key={att.id}
        attachment={att}
        attachmentManager={attachmentManager}
        onRemove={() => setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))}
      />
    ))}
  </div>
)}
```

Define `AttachmentPreview` inline in `panel.tsx`:

```tsx
function AttachmentPreview({ attachment, attachmentManager, onRemove }: {
  attachment: ImageAttachment;
  attachmentManager: AttachmentManager;
  onRemove: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const url = await attachmentManager.readAsDataUrl(attachment);
      setDataUrl(url);
    })();
  }, [attachment, attachmentManager]);

  const filename = attachment.vaultPath?.split("/").pop()
    || attachment.assetPath?.split("/").pop()
    || "image";
  const sizeKb = (attachment.sizeBytes / 1024).toFixed(0);

  return (
    <span className="ca-attached-file ca-image-preview">
      {dataUrl ? <img src={dataUrl} alt={filename} className="ca-image-thumb" /> : null}
      <span className="ca-attached-file-info">{filename} ({sizeKb}KB)</span>
      <button className="ca-attached-remove" onClick={onRemove}>&#x2715;</button>
    </span>
  );
}
```

- [ ] **Step 6: Build and test**

Run: `npm run build && npm run test`
Expected: Clean build, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/smartContext.ts src/panel.tsx
git commit -m "feat: image extraction in smart context, rewire paste handler with AttachmentManager"
```

---

### Task 6: MessageThread — Render Images and Lightbox

**Files:**
- Modify: `src/components/MessageThread.tsx`
- Create: `src/components/ImageLightbox.tsx`
- Modify: `styles.css`

- [ ] **Step 1: Create ImageLightbox component**

Create `src/components/ImageLightbox.tsx`:

```tsx
import React, { useEffect, useCallback } from "react";

interface ImageLightboxProps {
  images: string[]; // data URLs
  currentIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export function ImageLightbox({ images, currentIndex, onClose, onPrev, onNext }: ImageLightboxProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowLeft" && currentIndex > 0) onPrev();
    if (e.key === "ArrowRight" && currentIndex < images.length - 1) onNext();
  }, [currentIndex, images.length, onClose, onPrev, onNext]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="ca-lightbox-overlay" onClick={onClose}>
      <div className="ca-lightbox-content" onClick={(e) => e.stopPropagation()}>
        <img src={images[currentIndex]} alt="" className="ca-lightbox-image" />
        {images.length > 1 && (
          <div className="ca-lightbox-nav">
            <button
              className="ca-lightbox-arrow"
              onClick={onPrev}
              disabled={currentIndex === 0}
            >&#x2190;</button>
            <span className="ca-lightbox-counter">{currentIndex + 1}/{images.length}</span>
            <button
              className="ca-lightbox-arrow"
              onClick={onNext}
              disabled={currentIndex === images.length - 1}
            >&#x2192;</button>
          </div>
        )}
        <button className="ca-lightbox-close" onClick={onClose}>&#x2715;</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add image thumbnail rendering to MessageThread**

In `MessageThread.tsx`, add a `MessageImages` component that uses IntersectionObserver for lazy loading:

```tsx
function MessageImages({ images, attachmentManager }: {
  images: ImageAttachment[];
  attachmentManager: AttachmentManager;
}) {
  const [dataUrls, setDataUrls] = useState<(string | null)[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current || !ref.current) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        loadedRef.current = true;
        observer.disconnect();
        void (async () => {
          const urls = await Promise.all(
            images.map((img) => attachmentManager.readAsDataUrl(img))
          );
          setDataUrls(urls);
        })();
      }
    });

    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [images, attachmentManager]);

  const validUrls = dataUrls.filter((u): u is string => u !== null);

  return (
    <>
      <div className="ca-msg-images" ref={ref}>
        {images.map((img, i) => (
          <div key={img.id} className="ca-msg-image-thumb" onClick={() => dataUrls[i] && setLightboxIndex(i)}>
            {dataUrls[i] ? (
              <img src={dataUrls[i]!} alt={img.vaultPath || img.assetPath || ""} />
            ) : dataUrls.length > 0 ? (
              <span className="ca-msg-image-broken" title={img.assetPath || img.vaultPath}>&#x1F5BC;</span>
            ) : (
              <span className="ca-msg-image-loading" />
            )}
          </div>
        ))}
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          images={validUrls}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => setLightboxIndex((i) => Math.max(0, (i ?? 0) - 1))}
          onNext={() => setLightboxIndex((i) => Math.min(validUrls.length - 1, (i ?? 0) + 1))}
        />
      )}
    </>
  );
}
```

Add `attachmentManager: AttachmentManager` prop to the `MessageThreadProps` interface (at `src/components/MessageThread.tsx:65-75`). Thread it from `panel.tsx` where `<MessageThread>` is rendered (add `attachmentManager={attachmentManager}` to the JSX). Render `<MessageImages>` inside user messages when `msg.images?.length > 0`.

- [ ] **Step 3: Add lightbox and thumbnail CSS to styles.css**

```css
/* Image thumbnails in messages */
.ca-msg-images { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.ca-msg-image-thumb { cursor: pointer; border-radius: 6px; overflow: hidden; border: 1px solid var(--background-modifier-border); }
.ca-msg-image-thumb img { height: 80px; width: auto; max-width: 200px; object-fit: cover; display: block; }
.ca-msg-image-broken { display: flex; align-items: center; justify-content: center; width: 80px; height: 80px; background: var(--background-secondary); color: var(--text-muted); font-size: 24px; }
.ca-msg-image-loading { display: block; width: 80px; height: 80px; background: var(--background-secondary); border-radius: 6px; animation: ca-pulse 1.5s infinite; }
@keyframes ca-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.8; } }

/* Lightbox */
.ca-lightbox-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.ca-lightbox-content { position: relative; max-width: 90vw; max-height: 90vh; }
.ca-lightbox-image { max-width: 90vw; max-height: 85vh; object-fit: contain; border-radius: 4px; }
.ca-lightbox-close { position: absolute; top: -30px; right: 0; background: none; border: none; color: white; font-size: 20px; cursor: pointer; }
.ca-lightbox-nav { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 8px; }
.ca-lightbox-arrow { background: none; border: none; color: white; font-size: 20px; cursor: pointer; padding: 4px 8px; }
.ca-lightbox-arrow:disabled { opacity: 0.3; cursor: default; }
.ca-lightbox-counter { color: rgba(255,255,255,0.7); font-size: 13px; }
```

- [ ] **Step 4: Build and test**

Run: `npm run build && npm run test`
Expected: Clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/ImageLightbox.tsx src/components/MessageThread.tsx styles.css
git commit -m "feat: render image thumbnails in chat thread with lightbox viewer"
```

---

### Task 7: InputArea — Drop Zone and @-Reference Images

**Files:**
- Modify: `src/components/InputArea.tsx`
- Modify: `styles.css`

- [ ] **Step 1: Add drop zone handlers and props**

Add new props to `InputAreaProps`:

```typescript
onImageDrop?: (file: File) => void;
onImageAttach?: (vaultPath: string) => void;
```

Add drop zone state and handlers:

```typescript
const [isDragging, setIsDragging] = useState(false);

const handleDragOver = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
}, []);

const handleDragLeave = useCallback(() => setIsDragging(false), []);

const handleDrop = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  setIsDragging(false);
  const files = Array.from(e.dataTransfer.files);
  for (const file of files) {
    if (file.type.startsWith("image/") && onImageDrop) {
      onImageDrop(file);
    }
  }
}, [onImageDrop]);
```

Wrap the input area container div with the drag handlers:

```tsx
<div
  className={`ca-input-area ${isDragging ? "ca-drop-active" : ""}`}
  onDragOver={handleDragOver}
  onDragLeave={handleDragLeave}
  onDrop={handleDrop}
>
```

- [ ] **Step 2: Extend the @ file picker to include image files**

In the file search/filter logic, add image extensions to the accepted types. When an image file is selected, call `onImageAttach` instead of `onFileAttach`:

```typescript
const isImage = /\.(png|jpe?g|gif|webp)$/i.test(file.path);
if (isImage && onImageAttach) {
  onImageAttach(file.path);
} else {
  onFileAttach(file.path);
}
```

- [ ] **Step 3: Add drop zone CSS**

```css
.ca-input-area { position: relative; transition: border-color 0.15s; }
.ca-input-area.ca-drop-active { border: 2px dashed var(--interactive-accent); background: var(--background-secondary-alt); }
.ca-input-area.ca-drop-active::after {
  content: "Drop image";
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 14px; color: var(--interactive-accent); background: var(--background-secondary-alt);
  z-index: 10; pointer-events: none; border-radius: 8px;
}
```

- [ ] **Step 4: Wire drop and image-attach handlers in panel.tsx**

In panel.tsx, pass the new handlers to InputArea:

```tsx
onImageDrop={async (file) => {
  const chatId = chatFilePathRef.current?.split("/").pop()?.replace(".md", "") || generateId();
  const att = await attachmentManager.addFromDrop(file, chatId);
  if (att) setPendingAttachments((prev) => [...prev, att]);
}}
onImageAttach={async (vaultPath) => {
  const att = await attachmentManager.addFromVault(vaultPath);
  if (att) setPendingAttachments((prev) => [...prev, att]);
}}
```

- [ ] **Step 5: Build and test**

Run: `npm run build && npm run test`
Expected: Clean build, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/InputArea.tsx src/panel.tsx styles.css
git commit -m "feat: drop zone and @-reference images in InputArea"
```

---

### Task 8: Embedding Indexer — Image Wiki-Link Enrichment

**Files:**
- Modify: `src/embeddingIndexer.ts` (text chunking section)

- [ ] **Step 1: Add image wiki-link replacement in the indexFile function**

In `src/embeddingIndexer.ts`, find the `indexFile` function (around line 257). After the `stripFrontmatter` call (line 259) and before code-block removal (line 262), add image enrichment:

```typescript
// Enrich image references for text search
const enriched = content.replace(
  /!\[\[([^\]]+\.(png|jpe?g|gif|webp))(?:\|([^\]]*))?\]\]/gi,
  (_match, filename, _ext, altText) => {
    return altText
      ? `[Image: ${altText} (${filename})]`
      : `[Image: ${filename}]`;
  }
);
```

Use `enriched` instead of `content` for the chunking input.

- [ ] **Step 3: Build and test**

Run: `npm run build && npm run test`
Expected: Clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/embeddingIndexer.ts
git commit -m "feat: enrich image wiki-links with searchable text in embedding indexer"
```

---

### Task 9: Integration Test — Full Paste-to-Persist Round Trip

**Files:**
- Modify: `src/__tests__/attachmentManager.test.ts`

- [ ] **Step 1: Add extractFromNote test**

```typescript
describe("extractFromNote", () => {
  it("extracts image references from markdown content", async () => {
    const app = mockApp({
      "images/diagram.png": new Uint8Array([1, 2, 3]).buffer,
    });
    app.metadataCache.getFirstLinkpathDest.mockImplementation((link: string) => {
      if (link === "images/diagram.png") return Object.assign(Object.create(TFile.prototype), { path: "images/diagram.png", stat: { size: 3 } });
      return null;
    });
    app.vault.getAbstractFileByPath.mockImplementation((p: string) => {
      if (p === "images/diagram.png") return Object.assign(Object.create(TFile.prototype), { path: p, stat: { size: 3 } });
      return null;
    });

    const mgr = new AttachmentManager(app);
    const images = await mgr.extractFromNote("Here is a diagram:\n![[images/diagram.png]]\nAnd some text.");

    expect(images).toHaveLength(1);
    expect(images[0].source).toBe("context");
    expect(images[0].vaultPath).toBe("images/diagram.png");
  });

  it("skips SVG files", async () => {
    const app = mockApp();
    const mgr = new AttachmentManager(app);
    const images = await mgr.extractFromNote("![[logo.svg]]");
    expect(images).toHaveLength(0);
  });

  it("handles case-insensitive extensions", async () => {
    const app = mockApp({ "photo.JPG": new Uint8Array([1]).buffer });
    app.metadataCache.getFirstLinkpathDest.mockImplementation((link: string) => {
      if (link === "photo.JPG") return Object.assign(Object.create(TFile.prototype), { path: "photo.JPG", stat: { size: 1 } });
      return null;
    });
    app.vault.getAbstractFileByPath.mockImplementation((p: string) => {
      if (p === "photo.JPG") return Object.assign(Object.create(TFile.prototype), { path: p, stat: { size: 1 } });
      return null;
    });

    const mgr = new AttachmentManager(app);
    const images = await mgr.extractFromNote("![[photo.JPG]]");
    expect(images).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 3: Final build verification**

Run: `npm run build`
Expected: Clean build, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/attachmentManager.test.ts
git commit -m "test: add extractFromNote and edge case tests for AttachmentManager"
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `npm run build` — no errors
- [ ] `npm run test` — all tests pass
- [ ] Desktop: paste image into chat → thumbnail shown → sent to LLM → response references the image → image persists in chat history
- [ ] Desktop: drag image onto input → same flow as paste
- [ ] Desktop: type @ and select an image file → attached and sent
- [ ] Desktop: open a chat referencing a note with `![[image.png]]` → images auto-extracted into context
- [ ] Desktop: reload chat with images → images display correctly from saved paths
- [ ] Desktop: delete an asset file → broken-image placeholder shown instead of crash
- [ ] Mobile: paste image → works (drop zone hidden on mobile is fine)
