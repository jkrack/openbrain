import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createSession, addSegment, readSession } from "../diskRecorder";

vi.mock("../stt", () => ({
  transcribeBlob: vi.fn(),
}));

import { transcribeSegment, transcribeAllPending } from "../progressiveTranscriber";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ob-transcriber-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("progressiveTranscriber", () => {
  it("transcribes a single segment and updates session.json", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);

    const mockTranscribe = vi.fn().mockResolvedValue({ text: "Hello world", durationMs: 100 });

    await transcribeSegment(session.dir, 0, mockTranscribe);

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("Hello world");
    expect(mockTranscribe).toHaveBeenCalledOnce();
  });

  it("marks ERROR on transcription failure", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);

    const mockTranscribe = vi.fn().mockRejectedValue(new Error("API timeout"));

    await transcribeSegment(session.dir, 0, mockTranscribe);

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("ERROR");
  });

  it("transcribes all pending segments", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 142);

    let callCount = 0;
    const mockTranscribe = vi.fn().mockImplementation(async () => {
      callCount++;
      return { text: `Segment ${callCount}`, durationMs: 100 };
    });

    await transcribeAllPending(session.dir, mockTranscribe);

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("Segment 1");
    expect(loaded.segments[1].transcription).toBe("Segment 2");
    expect(loaded.segments[2].transcription).toBe("Segment 3");
  });

  it("skips already-transcribed segments", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 300);

    const { markTranscription } = await import("../diskRecorder");
    await markTranscription(session.dir, 0, "Already done");

    const mockTranscribe = vi.fn().mockResolvedValue({ text: "New transcription", durationMs: 100 });

    await transcribeAllPending(session.dir, mockTranscribe);

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("Already done");
    expect(loaded.segments[1].transcription).toBe("New transcription");
    expect(mockTranscribe).toHaveBeenCalledOnce();
  });
});
