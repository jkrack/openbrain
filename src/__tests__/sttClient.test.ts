import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// --- Module mocks ---

const mockSocket = new EventEmitter() as EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
mockSocket.write = vi.fn();
mockSocket.end = vi.fn();
mockSocket.destroy = vi.fn();

vi.mock("net", () => ({
  createConnection: vi.fn(() => mockSocket),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    pid: 12345,
  })),
}));

import { access } from "fs/promises";
import { createConnection } from "net";

import {
  getSocketPath,
  isDaemonRunning,
  sendRequest,
  getDefaultBinaryPath,
} from "../sttClient";

beforeEach(() => {
  vi.clearAllMocks();
  mockSocket.removeAllListeners();
});

describe("sttClient", () => {
  describe("getSocketPath", () => {
    it("returns a path containing .openbrain/stt.sock", () => {
      const p = getSocketPath();
      expect(p).toContain(".openbrain");
      expect(p).toMatch(/stt\.sock$/);
    });
  });

  describe("isDaemonRunning", () => {
    it("returns false when socket file does not exist", async () => {
      vi.mocked(access).mockRejectedValueOnce(new Error("ENOENT"));

      const result = await isDaemonRunning();
      expect(result).toBe(false);
    });
  });

  describe("sendRequest", () => {
    it("sends newline-delimited JSON and parses a result response", async () => {
      const response = {
        type: "result",
        id: "test-1",
        text: "hello world",
        processingMs: 42,
      };

      const promise = sendRequest(
        { type: "transcribe", id: "test-1", audio: "base64data" },
        5000
      );

      // Simulate connect + data events on next tick
      await new Promise((r) => setTimeout(r, 0));
      mockSocket.emit("connect");

      await new Promise((r) => setTimeout(r, 0));
      mockSocket.emit("data", Buffer.from(JSON.stringify(response) + "\n"));

      const result = await promise;
      expect(result).toEqual(response);
      expect(mockSocket.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"transcribe"')
      );
      // Verify newline delimiter
      const written = mockSocket.write.mock.calls[0][0] as string;
      expect(written.endsWith("\n")).toBe(true);
    });

    it("rejects when the daemon returns an error response", async () => {
      const response = {
        type: "error",
        id: "test-2",
        error: "model not loaded",
      };

      const promise = sendRequest(
        { type: "transcribe", id: "test-2" },
        5000
      );

      await new Promise((r) => setTimeout(r, 0));
      mockSocket.emit("connect");

      await new Promise((r) => setTimeout(r, 0));
      mockSocket.emit("data", Buffer.from(JSON.stringify(response) + "\n"));

      await expect(promise).rejects.toThrow("model not loaded");
    });

    it("rejects on socket error", async () => {
      const promise = sendRequest({ type: "status", id: "test-3" }, 5000);

      await new Promise((r) => setTimeout(r, 0));
      mockSocket.emit("error", new Error("connection refused"));

      await expect(promise).rejects.toThrow("STT daemon connection failed");
    });

    it("generates an id when none is provided", async () => {
      const response = { type: "status", id: "auto", state: "ready", model: "test", modelReady: true, uptimeSeconds: 10 };

      const promise = sendRequest({ type: "status" }, 5000);

      await new Promise((r) => setTimeout(r, 0));
      mockSocket.emit("connect");

      await new Promise((r) => setTimeout(r, 0));
      const written = mockSocket.write.mock.calls[0][0] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed.id).toMatch(/^req-/);

      mockSocket.emit("data", Buffer.from(JSON.stringify(response) + "\n"));
      await promise;
    });
  });

  describe("getDefaultBinaryPath", () => {
    it("returns path under pluginDir/bin/openbrain-stt", () => {
      const p = getDefaultBinaryPath("/path/to/plugin");
      expect(p).toBe("/path/to/plugin/bin/openbrain-stt");
    });
  });
});
