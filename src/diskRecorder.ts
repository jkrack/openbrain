import { mkdir, writeFile, readFile, readdir, unlink } from "fs/promises";
import { join } from "path";

export interface SegmentEntry {
  file: string;
  duration: number;
  transcription: string | null;
}

export interface RecordingSession {
  id: string;
  dir: string;
  startedAt: string;
  status: "recording" | "transcribing" | "completed" | "error";
  segmentDuration: number;
  segments: SegmentEntry[];
}

function sessionJsonPath(dir: string): string {
  return join(dir, "session.json");
}

function toSessionData(session: RecordingSession): object {
  const { dir, ...data } = session;
  return data;
}

export async function createSession(
  baseDir: string,
  segmentDuration: number
): Promise<RecordingSession> {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const rand = Math.random().toString(36).slice(2, 6);
  const id = `session-${timestamp}-${rand}`;
  const dir = join(baseDir, id);
  await mkdir(dir, { recursive: true });

  const session: RecordingSession = {
    id,
    dir,
    startedAt: now.toISOString(),
    status: "recording",
    segmentDuration,
    segments: [],
  };

  await writeFile(sessionJsonPath(dir), JSON.stringify(toSessionData(session), null, 2));
  return session;
}

export async function readSession(dir: string): Promise<RecordingSession> {
  const raw = await readFile(sessionJsonPath(dir), "utf-8");
  const data = JSON.parse(raw) as Omit<RecordingSession, "dir">;
  return { ...data, dir };
}

export async function addSegment(
  dir: string,
  wavBuffer: Buffer,
  duration: number
): Promise<string> {
  const session = await readSession(dir);
  const index = session.segments.length + 1;
  const filename = `segment-${String(index).padStart(3, "0")}.wav`;

  await writeFile(join(dir, filename), wavBuffer);

  session.segments.push({ file: filename, duration, transcription: null });
  await writeFile(sessionJsonPath(dir), JSON.stringify(toSessionData(session), null, 2));

  return filename;
}

export async function markTranscription(
  dir: string,
  segmentIndex: number,
  text: string
): Promise<void> {
  const session = await readSession(dir);
  session.segments[segmentIndex].transcription = text;
  await writeFile(sessionJsonPath(dir), JSON.stringify(toSessionData(session), null, 2));
}

export async function markCompleted(dir: string): Promise<void> {
  const session = await readSession(dir);
  session.status = "completed";
  await writeFile(sessionJsonPath(dir), JSON.stringify(toSessionData(session), null, 2));
}

export async function assembleTranscription(dir: string): Promise<string> {
  const session = await readSession(dir);
  return session.segments
    .map((s) => s.transcription)
    .filter((t): t is string => t !== null && t !== "ERROR")
    .join("\n\n");
}

/**
 * Delete WAV segment files from completed sessions older than retentionDays.
 * Keeps session.json for history. Pass 0 to delete immediately after completion.
 */
export async function cleanupOldSegments(
  baseDir: string,
  retentionDays: number
): Promise<void> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await readdir(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const dir = join(baseDir, entry.name);
    try {
      const session = await readSession(dir);
      if (session.status !== "completed") continue;

      const sessionTime = new Date(session.startedAt).getTime();
      if (sessionTime > cutoff) continue;

      for (const seg of session.segments) {
        const wavPath = join(dir, seg.file);
        try { await unlink(wavPath); } catch { /* may already be deleted */ }
      }
    } catch {
      // Corrupted session — skip
    }
  }
}

export async function findIncompleteSessions(baseDir: string): Promise<string[]> {
  const entries = await readdir(baseDir, { withFileTypes: true });
  const incomplete: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const dir = join(baseDir, entry.name);
    try {
      const session = await readSession(dir);
      if (session.status !== "completed") {
        incomplete.push(dir);
      }
    } catch {
      // Corrupted session — skip
    }
  }

  return incomplete;
}
