import { join } from "path";
import { readSession, markTranscription } from "./diskRecorder";

export type TranscribeFn = (wavPath: string) => Promise<{ text: string; durationMs: number }>;

export async function transcribeSegment(
  sessionDir: string,
  segmentIndex: number,
  transcribeFn: TranscribeFn
): Promise<void> {
  const session = await readSession(sessionDir);
  const segment = session.segments[segmentIndex];
  const wavPath = join(sessionDir, segment.file);

  try {
    const result = await transcribeFn(wavPath);
    await markTranscription(sessionDir, segmentIndex, result.text);
  } catch {
    await markTranscription(sessionDir, segmentIndex, "ERROR");
  }
}

export async function transcribeAllPending(
  sessionDir: string,
  transcribeFn: TranscribeFn
): Promise<void> {
  const session = await readSession(sessionDir);

  for (let i = 0; i < session.segments.length; i++) {
    if (session.segments[i].transcription === null) {
      await transcribeSegment(sessionDir, i, transcribeFn);
    }
  }
}
