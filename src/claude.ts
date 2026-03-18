/**
 * Audio transcription via Anthropic API.
 * This is the only remaining use of the direct Anthropic API —
 * all text chat goes through the provider system in chatEngine.ts.
 */

import { OpenBrainSettings } from "./settings";
import { requestUrl } from "obsidian";

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Transcribe multiple audio segments sequentially via the Anthropic API.
 * Each segment is sent as a separate request; results are concatenated.
 */
export async function transcribeAudioSegments(
  settings: OpenBrainSettings,
  opts: {
    segments: Blob[];
    systemPrompt: string;
    noteContext?: string;
    audioPrompt?: string;
    onChunk: (chunk: string) => void;
    onProgress: (current: number, total: number) => void;
    onDone: () => void;
    onError: (err: string) => void;
  }
): Promise<void> {
  if (!settings.apiKey) {
    opts.onError("Audio transcription via API requires an Anthropic API key. Enable local STT or add a key in settings.");
    return;
  }

  const systemContent = opts.noteContext
    ? `${opts.systemPrompt}\n\n---\nActive note content:\n${opts.noteContext}`
    : opts.systemPrompt;

  const transcriptions: string[] = [];

  for (let i = 0; i < opts.segments.length; i++) {
    opts.onProgress(i + 1, opts.segments.length);

    const segment = opts.segments[i];
    const base64 = await blobToBase64(segment);
    const mediaType = segment.type || "audio/webm";

    const prompt = opts.segments.length > 1
      ? `Transcribe this audio (segment ${i + 1} of ${opts.segments.length}). Output only the transcription text, no commentary.`
      : (opts.audioPrompt || "Please transcribe this audio. After transcribing, briefly summarize the key points or action items if any are present.");

    try {
      const response = await requestUrl({
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: settings.model || "claude-sonnet-4-20250514",
          max_tokens: settings.maxTokens || 4096,
          system: systemContent,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "document",
                  source: { type: "base64", media_type: mediaType, data: base64 },
                },
              ],
            },
          ],
          stream: false,
        }),
      });

      if (response.status !== 200) {
        const err: { error?: { message?: string } } = response.json;
        transcriptions.push(`[Segment ${i + 1} failed: ${err.error?.message || "API error"}]`);
        continue;
      }

      const result: { content?: { type: string; text?: string }[] } = response.json;
      const text = result.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("") || "";
      transcriptions.push(text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      transcriptions.push(`[Segment ${i + 1} failed: ${message}]`);
    }
  }

  const combined = transcriptions.join("\n\n");
  const analysisPrompt = opts.audioPrompt
    ? `${opts.audioPrompt}\n\nTranscription:\n${combined}`
    : `Here is a transcription of a ${opts.segments.length}-segment audio recording. Summarize the key points and action items.\n\nTranscription:\n${combined}`;

  opts.onChunk(analysisPrompt.includes("transcribe only")
    ? combined
    : combined + "\n\n---\n");
  opts.onDone();
}
