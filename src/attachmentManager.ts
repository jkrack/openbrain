import { App, TFile, Notice } from "obsidian";
import { ImageAttachment } from "./providers/types";

// ── Constants ────────────────────────────────────────────────────────────

const ASSETS_BASE = "OpenBrain/chats/assets";
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const EMBED_REGEX = /!\[\[([^\]]+\.(png|jpe?g|gif|webp))(?:\|[^\]]*)?\]\]/gi;

const SIZE_WARN_BYTES = 5 * 1024 * 1024;   // 5 MB
const SIZE_REJECT_BYTES = 20 * 1024 * 1024; // 20 MB
const COMPRESS_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB
const COMPRESS_QUALITY = 0.8;
const COMPRESS_MAX_DIM = 2048;

// ── Helpers ──────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function extFromMediaType(mediaType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return map[mediaType] ?? "png";
}

function mediaTypeFromExt(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext.toLowerCase()] ?? "image/png";
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── AttachmentManager ────────────────────────────────────────────────────

export class AttachmentManager {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Ingest a blob from clipboard paste. Saves to assets folder. */
  async addFromClipboard(blob: Blob, chatId: string): Promise<ImageAttachment> {
    return this.ingestBlob(blob, chatId, "paste");
  }

  /** Ingest a File object from drag-and-drop. Saves to assets folder. */
  async addFromDrop(file: File, chatId: string): Promise<ImageAttachment> {
    const blob = new Blob([await file.arrayBuffer()], { type: file.type });
    return this.ingestBlob(blob, chatId, "drop");
  }

  /**
   * Reference an existing vault image without copying it.
   * The attachment will use vaultPath directly (no assetPath).
   */
  async addFromVault(vaultPath: string): Promise<ImageAttachment | null> {
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) return null;

    const sizeBytes = file.stat.size;
    if (sizeBytes > SIZE_REJECT_BYTES) {
      new Notice(`Image is too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB). Maximum is 20 MB.`);
      return null;
    }

    const ext = vaultPath.split(".").pop() ?? "png";
    const mediaType = mediaTypeFromExt(ext);

    return {
      id: generateId(),
      source: "vault",
      vaultPath,
      mediaType,
      sizeBytes,
    };
  }

  /**
   * Scan note content for ![[image]] embeds and resolve them via metadataCache.
   * SVG is intentionally excluded (security risk).
   */
  extractFromNote(content: string): ImageAttachment[] {
    const results: ImageAttachment[] = [];
    const regex = new RegExp(EMBED_REGEX.source, "gi");
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const rawPath = match[1];
      // Resolve via metadataCache to get the actual vault path
      const resolved = this.app.metadataCache.getFirstLinkpathDest(rawPath, "");

      // Skip unresolved references — only include images that exist in the vault
      if (!(resolved instanceof TFile)) continue;

      const vaultPath = resolved.path;

      const ext = vaultPath.split(".").pop() ?? "png";
      const mediaType = mediaTypeFromExt(ext);

      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      const sizeBytes = file instanceof TFile ? file.stat.size : 0;

      results.push({
        id: generateId(),
        source: "context",
        vaultPath,
        mediaType,
        sizeBytes,
      });
    }

    return results;
  }

  /**
   * Read an attachment's asset file from the vault and return base64-encoded data.
   * Returns null if the file is missing or unreadable.
   */
  async readAsBase64(attachment: ImageAttachment): Promise<string | null> {
    const path = attachment.assetPath ?? attachment.vaultPath;
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

  /**
   * Read an attachment and return a data URL (data:mediaType;base64,...).
   * Returns null if the file is missing.
   */
  async readAsDataUrl(attachment: ImageAttachment): Promise<string | null> {
    const base64 = await this.readAsBase64(attachment);
    if (!base64) return null;
    return `data:${attachment.mediaType};base64,${base64}`;
  }

  /**
   * Write a blob to the assets folder under OpenBrain/chats/assets/{chatId}/{id}.{ext}.
   * Creates parent folders as needed.
   */
  async saveToAssets(blob: Blob, chatId: string, id: string, ext: string): Promise<string> {
    const folderPath = `${ASSETS_BASE}/${chatId}`;
    const filePath = `${folderPath}/${id}.${ext}`;

    await this.ensureFolder(folderPath);

    const buffer = await blob.arrayBuffer();
    await this.app.vault.createBinary(filePath, buffer);

    return filePath;
  }

  /**
   * Ensure a folder hierarchy exists. Creates each missing segment.
   * Mirrors the pattern used in chatHistory.ts.
   */
  async ensureFolder(folderPath: string): Promise<void> {
    if (!folderPath || this.app.vault.getAbstractFileByPath(folderPath)) return;

    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  /**
   * Optionally compress a PNG or JPEG blob that exceeds COMPRESS_THRESHOLD_BYTES.
   * GIF and WebP are returned unchanged.
   * Uses OffscreenCanvas + createImageBitmap (available in browser/Obsidian renderer).
   */
  async maybeCompress(blob: Blob, mediaType: string): Promise<Blob> {
    // Only compress PNG/JPEG; leave GIF and WebP alone
    if (mediaType !== "image/png" && mediaType !== "image/jpeg") {
      return blob;
    }
    if (blob.size <= COMPRESS_THRESHOLD_BYTES) {
      return blob;
    }

    try {
      const bitmap = await createImageBitmap(blob);
      let { width, height } = bitmap;

      // Scale down if either dimension exceeds the max
      if (width > COMPRESS_MAX_DIM || height > COMPRESS_MAX_DIM) {
        const scale = COMPRESS_MAX_DIM / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      // OffscreenCanvas is available in Electron/Obsidian but not in older lib typings.
      // Access via globalThis to avoid compile-time name resolution.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const OC = (globalThis as any)["OffscreenCanvas"] as (new (w: number, h: number) => {
        getContext(id: "2d"): CanvasRenderingContext2D | null;
        convertToBlob(opts: { type: string; quality: number }): Promise<Blob>;
      }) | undefined;
      if (!OC) return blob;

      const canvas = new OC(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return blob;

      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();

      const outputType = mediaType === "image/jpeg" ? "image/jpeg" : "image/png";
      const compressed = await canvas.convertToBlob({ type: outputType, quality: COMPRESS_QUALITY });

      // Only use compressed version if it's actually smaller
      return compressed.size < blob.size ? compressed : blob;
    } catch {
      // If compression fails (e.g., no OffscreenCanvas in test env), return original
      return blob;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private async ingestBlob(
    blob: Blob,
    chatId: string,
    source: "paste" | "drop"
  ): Promise<ImageAttachment> {
    const mediaType = blob.type || "image/png";

    if (blob.size > SIZE_REJECT_BYTES) {
      new Notice(`Image is too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). Maximum is 20 MB.`);
      throw new Error(`Image too large: ${blob.size} bytes`);
    }
    if (blob.size > SIZE_WARN_BYTES) {
      new Notice(`Large image (${(blob.size / 1024 / 1024).toFixed(1)} MB) — this may slow things down.`);
    }

    const compressed = await this.maybeCompress(blob, mediaType);
    const ext = extFromMediaType(compressed.type || mediaType);
    const id = generateId();

    const assetPath = await this.saveToAssets(compressed, chatId, id, ext);

    return {
      id,
      source,
      assetPath,
      mediaType: compressed.type || mediaType,
      sizeBytes: compressed.size,
    };
  }
}
