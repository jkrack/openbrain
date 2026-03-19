import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createSession,
  addSegment,
  readSession,
  assembleTranscription,
  markCompleted,
  findIncompleteSessions,
} from "../diskRecorder";
import { transcribeAllPending } from "../progressiveTranscriber";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ob-integration-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("floating recorder integration", () => {
  it("simulates a full recording session: create -> segments -> transcribe -> assemble", async () => {
    // 1. Start session
    const session = await createSession(testDir, 300);
    expect(session.status).toBe("recording");

    // 2. Add 3 segments (simulating 5-min chunks)
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 142);

    // Verify files on disk
    const files = await readdir(session.dir);
    expect(files).toContain("session.json");
    expect(files).toContain("segment-001.wav");
    expect(files).toContain("segment-002.wav");
    expect(files).toContain("segment-003.wav");

    // 3. Transcribe all segments
    let callCount = 0;
    const mockTranscribe = vi.fn().mockImplementation(async () => {
      callCount++;
      return { text: `Transcription for segment ${callCount}.`, durationMs: 50 };
    });

    await transcribeAllPending(session.dir, mockTranscribe);
    expect(mockTranscribe).toHaveBeenCalledTimes(3);

    // 4. Assemble
    const fullText = await assembleTranscription(session.dir);
    expect(fullText).toBe(
      "Transcription for segment 1.\n\n" +
      "Transcription for segment 2.\n\n" +
      "Transcription for segment 3."
    );

    // 5. Mark complete
    await markCompleted(session.dir);
    const final = await readSession(session.dir);
    expect(final.status).toBe("completed");
  });

  it("recovers incomplete session on restart", async () => {
    // Simulate a crash: session created with segments but not completed
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 200);

    // Verify it shows as incomplete
    const incomplete = await findIncompleteSessions(testDir);
    expect(incomplete).toHaveLength(1);

    // Recover
    const mockTranscribe = vi.fn().mockResolvedValue({ text: "Recovered text.", durationMs: 50 });
    await transcribeAllPending(session.dir, mockTranscribe);

    const text = await assembleTranscription(session.dir);
    expect(text).toBe("Recovered text.\n\nRecovered text.");

    await markCompleted(session.dir);

    // Now should not show as incomplete
    const stillIncomplete = await findIncompleteSessions(testDir);
    expect(stillIncomplete).toHaveLength(0);
  });
});
