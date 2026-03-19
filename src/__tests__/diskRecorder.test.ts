import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  createSession,
  addSegment,
  markTranscription,
  readSession,
  assembleTranscription,
  markCompleted,
  findIncompleteSessions,
  type RecordingSession,
} from "../diskRecorder";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ob-disk-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("diskRecorder", () => {
  it("creates a session directory with session.json", async () => {
    const session = await createSession(testDir, 300);
    expect(session.status).toBe("recording");
    expect(session.segments).toEqual([]);
    expect(session.segmentDuration).toBe(300);

    const loaded = await readSession(session.dir);
    expect(loaded.id).toBe(session.id);
  });

  it("adds a segment entry to session.json", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);

    const loaded = await readSession(session.dir);
    expect(loaded.segments).toHaveLength(1);
    expect(loaded.segments[0].file).toBe("segment-001.wav");
    expect(loaded.segments[0].duration).toBe(300);
    expect(loaded.segments[0].transcription).toBeNull();
  });

  it("marks a segment transcription", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await markTranscription(session.dir, 0, "Hello world");

    const loaded = await readSession(session.dir);
    expect(loaded.segments[0].transcription).toBe("Hello world");
  });

  it("assembles transcriptions in order", async () => {
    const session = await createSession(testDir, 300);
    const wavBuf = Buffer.alloc(44);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 300);
    await addSegment(session.dir, wavBuf, 142);
    await markTranscription(session.dir, 0, "First segment.");
    await markTranscription(session.dir, 1, "Second segment.");
    await markTranscription(session.dir, 2, "Third segment.");

    const text = await assembleTranscription(session.dir);
    expect(text).toBe("First segment.\n\nSecond segment.\n\nThird segment.");
  });

  it("marks session as completed", async () => {
    const session = await createSession(testDir, 300);
    await markCompleted(session.dir);

    const loaded = await readSession(session.dir);
    expect(loaded.status).toBe("completed");
  });

  it("finds incomplete sessions", async () => {
    const s1 = await createSession(testDir, 300);
    const s2 = await createSession(testDir, 300);
    await markCompleted(s1.dir);

    const incomplete = await findIncompleteSessions(testDir);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toBe(s2.dir);
  });
});
