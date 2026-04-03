import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../sttClient", () => ({
  sendRequest: vi.fn(),
  isDaemonRunning: vi.fn(),
  ensureDaemon: vi.fn(),
  getSocketPath: vi.fn(() => "/tmp/test.sock"),
  getDefaultBinaryPath: vi.fn(() => "/tmp/test-bin"),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  readFile: vi.fn(),
}));

describe("stt (daemon-based)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkSttInstallation", () => {
    it("returns ready when daemon is running", async () => {
      const { isDaemonRunning, sendRequest } = await import("../sttClient");
      (isDaemonRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (sendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        type: "status",
        id: "check",
        state: "ready",
        model: "parakeet-tdt-0.6b-v3",
        modelReady: true,
        uptimeSeconds: 100,
      });

      const { checkSttInstallation } = await import("../stt");
      const status = await checkSttInstallation({} as any);
      expect(status.ready).toBe(true);
      expect(status.modelName).toContain("Parakeet");
    });

    it("returns not ready when daemon is not running", async () => {
      const { isDaemonRunning } = await import("../sttClient");
      (isDaemonRunning as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { checkSttInstallation } = await import("../stt");
      const status = await checkSttInstallation({} as any);
      expect(status.ready).toBe(false);
    });
  });

  describe("transcribeWavFile", () => {
    it("sends file path to daemon and returns text", async () => {
      const { sendRequest, isDaemonRunning, ensureDaemon } = await import("../sttClient");
      (isDaemonRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (ensureDaemon as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (sendRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        type: "result",
        id: "req-1",
        text: "hello world",
        processingMs: 150,
        language: "en",
      });

      const { transcribeWavFile } = await import("../stt");
      const result = await transcribeWavFile("/tmp/test.wav", {} as any);
      expect(result.text).toBe("hello world");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      expect(sendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "transcribe",
          audio: "/tmp/test.wav",
          audioFormat: "path",
        }),
      );
    });
  });
});
