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
        if (files[p])
          return Object.assign(Object.create(TFile.prototype), {
            path: p,
            stat: { size: files[p].byteLength },
          });
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
      const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
        type: "image/png",
      });
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
      const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
      const app = mockApp({
        "OpenBrain/chats/assets/chat-abc/img1.png": data,
      });
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
