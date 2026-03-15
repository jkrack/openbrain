import { OpenBrainSettings } from "./settings";
import { spawn, ChildProcess } from "child_process";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  isAudio?: boolean;
  timestamp: Date;
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onDone: (sessionId?: string) => void;
  onError: (err: string) => void;
}

export interface ClaudeCodeOptions extends StreamCallbacks {
  prompt: string;
  noteContext?: string;
  noteFilePath?: string;
  systemPrompt: string;
  sessionId?: string;
  allowWrite: boolean;
  allowCli: boolean;
  vaultPath?: string;
}

export interface ClaudeAPIOptions extends StreamCallbacks {
  messages: Message[];
  systemPrompt: string;
  noteContext?: string;
  audioBlob: Blob;
  audioPrompt?: string;
}

/**
 * Stream via Claude Code CLI — full agentic capabilities, no API key needed.
 * Used for all text-based messages.
 */
export function streamClaudeCode(
  settings: OpenBrainSettings,
  opts: ClaudeCodeOptions
): ChildProcess {
  const claudePath = settings.claudePath || "claude";

  const args = ["-p", "--output-format", "stream-json", "--verbose"];

  // Resume existing session for multi-turn
  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  // Append vault context to system prompt
  const notePath = opts.noteFilePath ? `\nActive note file path: ${opts.noteFilePath}` : "";
  const contextNote = opts.noteContext
    ? `\n\n---${notePath}\nActive note content:\n${opts.noteContext}`
    : "";
  args.push("--append-system-prompt", opts.systemPrompt + contextNote);

  // Control tool access based on toggles
  const disallowed: string[] = [];
  if (!opts.allowWrite) {
    disallowed.push("Edit", "Write", "NotebookEdit");
  }
  if (!opts.allowCli) {
    disallowed.push("Bash");
  }
  if (disallowed.length > 0) {
    args.push("--disallowed-tools", ...disallowed);
  }

  // Spawn the CLI — must unset CLAUDECODE to avoid nested-session block.
  // Electron/Obsidian on macOS doesn't inherit the user's shell PATH,
  // so we add common bin directories where claude may be installed.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const home = env.HOME || "";
  const extraPaths = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    `${home}/.local/bin`,
    `${home}/.nvm/versions/node`,
  ];
  env.PATH = [...extraPaths, env.PATH].filter(Boolean).join(":");

  const proc = spawn(claudePath, args, {
    env,
    cwd: opts.vaultPath || undefined,
  });

  // Send prompt via stdin
  proc.stdin.write(opts.prompt);
  proc.stdin.end();

  // Parse streaming JSON output
  let buffer = "";
  let resultSessionId: string | undefined;

  proc.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        // Text content deltas
        if (
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "text_delta"
        ) {
          opts.onChunk(parsed.delta.text);
        }

        // Assistant message with full content (non-streaming fallback)
        if (parsed.type === "assistant" && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === "text") {
              opts.onChunk(block.text);
            }
          }
        }

        // Result event — contains session_id for continuation
        if (parsed.type === "result") {
          resultSessionId = parsed.session_id;
        }
      } catch {
        // ignore malformed JSON lines
      }
    }
  });

  let stderrOutput = "";
  proc.stderr.on("data", (data: Buffer) => {
    stderrOutput += data.toString();
  });

  proc.on("close", (code) => {
    if (code !== 0 && stderrOutput) {
      opts.onError(
        stderrOutput.includes("command not found") || stderrOutput.includes("ENOENT")
          ? "Claude Code CLI not found. Install it from https://docs.anthropic.com/en/docs/claude-code"
          : `CLI error: ${stderrOutput.trim()}`
      );
    } else {
      opts.onDone(resultSessionId);
    }
  });

  proc.on("error", (err) => {
    opts.onError(
      err.message.includes("ENOENT")
        ? "Claude Code CLI not found. Install it from https://docs.anthropic.com/en/docs/claude-code"
        : `Failed to start CLI: ${err.message}`
    );
  });

  return proc;
}

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
) {
  if (!settings.apiKey) {
    opts.onError("API key required for voice recording. Add it in OpenBrain settings.");
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
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: settings.maxTokens,
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

      if (!response.ok) {
        const err = await response.json();
        transcriptions.push(`[Segment ${i + 1} failed: ${err.error?.message || response.statusText}]`);
        continue;
      }

      const result = await response.json();
      const text = result.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("") || "";
      transcriptions.push(text);
    } catch (err: any) {
      transcriptions.push(`[Segment ${i + 1} failed: ${err.message}]`);
    }
  }

  // Combine all transcriptions and send to Claude Code for analysis
  const combined = transcriptions.join("\n\n");
  const analysisPrompt = opts.audioPrompt
    ? `${opts.audioPrompt}\n\nTranscription:\n${combined}`
    : `Here is a transcription of a ${opts.segments.length}-segment audio recording. Summarize the key points and action items.\n\nTranscription:\n${combined}`;

  opts.onChunk(analysisPrompt.includes("transcribe only")
    ? combined
    : combined + "\n\n---\n");
  opts.onDone();
}

/**
 * Stream via Anthropic API — used for single audio/voice messages.
 * Requires API key in settings.
 */
export async function streamClaudeAPI(
  settings: OpenBrainSettings,
  opts: ClaudeAPIOptions
) {
  if (!settings.apiKey) {
    opts.onError("API key required for voice recording. Add it in OpenBrain settings.");
    return;
  }

  const systemContent = opts.noteContext
    ? `${opts.systemPrompt}\n\n---\nActive note content:\n${opts.noteContext}`
    : opts.systemPrompt;

  const base64 = await blobToBase64(opts.audioBlob);
  const mediaType = opts.audioBlob.type || "audio/webm";

  const userContent = [
    {
      type: "text",
      text:
        opts.audioPrompt ||
        "Please transcribe this audio. After transcribing, briefly summarize the key points or action items if any are present.",
    },
    {
      type: "document",
      source: {
        type: "base64",
        media_type: mediaType,
        data: base64,
      },
    },
  ];

  const apiMessages = [
    ...opts.messages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: userContent },
  ];

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: settings.maxTokens,
        system: systemContent,
        messages: apiMessages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      opts.onError(`API error: ${err.error?.message || response.statusText}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      opts.onError("No response body");
      return;
    }

    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (
              parsed.type === "content_block_delta" &&
              parsed.delta?.type === "text_delta"
            ) {
              opts.onChunk(parsed.delta.text);
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    }

    opts.onDone();
  } catch (err: any) {
    opts.onError(`Network error: ${err.message}`);
  }
}
