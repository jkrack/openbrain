import { OpenBrainSettings } from "./settings";
import { spawn, execSync, ChildProcess } from "child_process";
import { requestUrl } from "obsidian";
import { startTimer } from "./perf";

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

export interface ClaudeAPIChatOptions extends StreamCallbacks {
  messages: Message[];
  systemPrompt: string;
  noteContext?: string;
  images?: { base64: string; mediaType: string }[];
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

  const args = ["-p", "--output-format", "stream-json", "--verbose", "--disable-slash-commands"];

  // Resume existing session for multi-turn
  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  // Append vault context to system prompt (cap at 4000 chars to limit token overhead)
  const notePath = opts.noteFilePath ? `\nActive note: ${opts.noteFilePath}` : "";
  const trimmedContext = opts.noteContext && opts.noteContext.length > 4000
    ? opts.noteContext.slice(0, 4000) + "\n...(truncated)"
    : opts.noteContext;
  const contextNote = trimmedContext
    ? `\n\n---${notePath}\n${trimmedContext}`
    : "";

  // Tell Claude about the Obsidian CLI when shell access is enabled
  const obsidianCliContext = opts.allowCli ? `

--- Obsidian CLI ---
You have access to the Obsidian CLI. Use it for vault operations instead of raw file I/O when possible.

Key commands:
  obsidian daily                          # Open today's daily note
  obsidian daily:read                     # Read today's daily note
  obsidian daily:append content="text"    # Append to today's daily note
  obsidian search query="search terms"    # Full-text vault search
  obsidian tasks file="path" todo         # Get open tasks from a file
  obsidian tasks daily todo               # Get open tasks from daily note
  obsidian backlinks file="path"          # Find all backlinks to a file
  obsidian links file="path"              # Get outgoing links from a file
  obsidian read file="path"               # Read a file
  obsidian create name="path" content="text"  # Create a new note
  obsidian append file="path" content="text"  # Append to a note
  obsidian properties file="path"         # Read file frontmatter
  obsidian property:set file="path" name="key" value="val"  # Set a property
  obsidian outline file="path"            # Get headings/structure

Prefer these over direct file read/write — they work through Obsidian's APIs and handle links, metadata, and caching correctly.
` : "";

  // Universal boundaries — always appended regardless of skill
  const boundaries = `
RULES: You are inside the OpenBrain Obsidian plugin. No built-in CLI skills. Vault-relative paths only (never /Users/... or /home/...). Stay focused on the vault.`;

  args.push("--append-system-prompt", opts.systemPrompt + contextNote + obsidianCliContext + boundaries);

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

  // Auto-accept tool calls when permissions are granted.
  // Non-interactive spawn can't prompt for approval, so we set
  // the appropriate permission mode based on what's enabled.
  if (opts.allowWrite && opts.allowCli) {
    args.push("--permission-mode", "bypassPermissions");
  } else if (opts.allowWrite) {
    args.push("--permission-mode", "acceptEdits");
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
    "/Applications/Obsidian.app/Contents/MacOS",
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
  const doneSpawn = startTimer("cli-spawn-to-first-token");
  const doneTotal = startTimer("cli-total-response");
  let buffer = "";
  let resultSessionId: string | undefined;
  let receivedDeltas = false;

  proc.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: Record<string, unknown> = JSON.parse(line);

        // Text content deltas
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (
          parsed.type === "content_block_delta" &&
          delta?.type === "text_delta"
        ) {
          if (!receivedDeltas) doneSpawn(); // first token received
          receivedDeltas = true;
          opts.onChunk(delta.text as string);
        }

        // Assistant message with full content (non-streaming fallback)
        const message = parsed.message as Record<string, unknown> | undefined;
        if (!receivedDeltas && parsed.type === "assistant" && message?.content) {
          for (const block of message.content as { type: string; text?: string }[]) {
            if (block.type === "text" && block.text) {
              opts.onChunk(block.text);
            }
          }
        }

        // Result event — contains session_id for continuation
        if (parsed.type === "result") {
          resultSessionId = parsed.session_id as string;
        }
      } catch { /* expected — ignore malformed JSON lines */ }
    }
  });

  let stderrOutput = "";
  proc.stderr.on("data", (data: Buffer) => {
    stderrOutput += data.toString();
  });

  let settled = false;
  const settle = () => { settled = true; doneTotal(); };

  proc.on("close", (code) => {
    if (settled) return;
    settle();
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
    if (settled) return;
    settle();
    opts.onError(
      err.message.includes("ENOENT")
        ? "Claude Code CLI not found. Install it from https://docs.anthropic.com/en/docs/claude-code"
        : `Failed to start CLI: ${err.message}`
    );
  });

  proc.on("exit", (code) => {
    if (settled) return;
    settle();
    // Safety net — if close/error didn't fire, still resolve
    if (code !== 0) {
      opts.onError(`CLI exited with code ${code}`);
    } else {
      opts.onDone(resultSessionId);
    }
  });

  return proc;
}

/**
 * Generate a one-line TLDR summary of a conversation.
 * Tries Claude Code CLI first (reuses session), falls back to API.
 */
export async function summarizeChat(
  settings: OpenBrainSettings,
  messages: Message[],
  sessionId?: string,
  vaultPath?: string
): Promise<string | null> {
  if (messages.length < 2) return null;

  const prompt = "Summarize this entire conversation in ONE sentence (under 80 chars) for a daily note. Just the summary, nothing else.";

  // Try Claude Code CLI with existing session
  if (sessionId) {
    try {
      const claudePath = settings.claudePath || "claude";
      const home = process.env.HOME || "";
      const env = { ...process.env };
      delete env.CLAUDECODE;
      env.PATH = ["/usr/local/bin", "/opt/homebrew/bin", `${home}/.local/bin`, `${home}/.nvm/versions/node`, env.PATH].filter(Boolean).join(":");

      const result = execSync(
        `${claudePath} -p --resume ${sessionId} --output-format text`,
        { input: prompt, encoding: "utf-8", timeout: 15000, env, cwd: vaultPath }
      );
      const summary = result.trim();
      if (summary && summary.length < 200) return summary;
    } catch { /* expected — CLI may not be available */ }
  }

  // Fall back to API
  if (settings.apiKey) {
    try {
      const lastMessages = messages.slice(-6).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 300),
      }));
      lastMessages.push({ role: "user", content: prompt });

      const response = await requestUrl({
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: 100,
          messages: lastMessages,
          stream: false,
        }),
      });

      if (response.status === 200) {
        const result: { content?: { type: string; text?: string }[] } = response.json;
        const text = result.content?.find((b) => b.type === "text")?.text;
        if (text && text.length < 200) return text.trim();
      }
    } catch { /* expected — API may be unavailable */ }
  }

  return null;
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

  const apiBoundaries = "\nRULES: OpenBrain Obsidian plugin. No built-in CLI skills. Vault-relative paths only.";
  const systemContent = opts.noteContext
    ? `${opts.systemPrompt}${apiBoundaries}\n\n---\nActive note content:\n${opts.noteContext}`
    : `${opts.systemPrompt}${apiBoundaries}`;

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

  const apiBoundaries = "\nRULES: OpenBrain Obsidian plugin. No built-in CLI skills. Vault-relative paths only.";
  const systemContent = opts.noteContext
    ? `${opts.systemPrompt}${apiBoundaries}\n\n---\nActive note content:\n${opts.noteContext}`
    : `${opts.systemPrompt}${apiBoundaries}`;

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
    // requestUrl does not support streaming — use globalThis.fetch for ReadableStream
    const response = await globalThis.fetch("https://api.anthropic.com/v1/messages", {
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
      const errBody: { error?: { message?: string } } = await response.json();
      opts.onError(`API error: ${errBody.error?.message || response.statusText}`);
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
            const parsed: Record<string, unknown> = JSON.parse(data);
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (
              parsed.type === "content_block_delta" &&
              delta?.type === "text_delta"
            ) {
              opts.onChunk(delta.text as string);
            }
          } catch { /* expected — ignore parse errors */ }
        }
      }
    }

    opts.onDone();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onError(`Network error: ${message}`);
  }
}

/**
 * Stream text (and optional images) via Anthropic API — direct chat mode.
 * No tool use, no CLI. Fast and simple for research and conversation.
 */
export async function streamClaudeAPIChat(
  settings: OpenBrainSettings,
  opts: ClaudeAPIChatOptions
) {
  if (!settings.apiKey) {
    opts.onError("API key required for chat mode. Add it in OpenBrain settings.");
    return;
  }

  const apiBoundaries = "\nRULES: OpenBrain Obsidian plugin. No built-in CLI skills. Vault-relative paths only.";
  const systemContent = opts.noteContext
    ? `${opts.systemPrompt}${apiBoundaries}\n\n---\nActive note content:\n${opts.noteContext}`
    : `${opts.systemPrompt}${apiBoundaries}`;

  // Build API messages from conversation history
  type ApiContent = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
  const apiMessages = opts.messages.map((m) => {
    // For the last user message, attach images if present
    if (m === opts.messages[opts.messages.length - 1] && m.role === "user" && opts.images?.length) {
      const content: ApiContent[] = [{ type: "text", text: m.content }];
      for (const img of opts.images) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.base64,
          },
        });
      }
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  });

  try {
    // requestUrl does not support streaming — use globalThis.fetch for ReadableStream
    const response = await globalThis.fetch("https://api.anthropic.com/v1/messages", {
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
      const errBody: { error?: { message?: string } } = await response.json();
      opts.onError(`API error: ${errBody.error?.message || response.statusText}`);
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
            const parsed: Record<string, unknown> = JSON.parse(data);
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (
              parsed.type === "content_block_delta" &&
              delta?.type === "text_delta"
            ) {
              opts.onChunk(delta.text as string);
            }
          } catch { /* expected — ignore parse errors */ }
        }
      }
    }

    opts.onDone();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onError(`Network error: ${message}`);
  }
}

/**
 * Stream via OpenRouter API — supports any model (GPT-4o, Claude, Gemini, Llama, etc.)
 * Uses OpenAI-compatible format.
 */
export async function streamOpenRouterChat(
  settings: OpenBrainSettings,
  opts: ClaudeAPIChatOptions
) {
  if (!settings.openrouterApiKey) {
    opts.onError("OpenRouter API key required. Add it in OpenBrain settings.");
    return;
  }

  const apiBoundaries = "\nRULES: OpenBrain Obsidian plugin. No built-in CLI skills. Vault-relative paths only.";
  const systemContent = opts.noteContext
    ? `${opts.systemPrompt}${apiBoundaries}\n\n---\nActive note content:\n${opts.noteContext}`
    : `${opts.systemPrompt}${apiBoundaries}`;

  type OrContent = string | { type: string; text?: string; image_url?: { url: string } }[];
  const apiMessages: { role: string; content: OrContent }[] = [
    { role: "system", content: systemContent },
  ];

  for (const m of opts.messages) {
    if (m === opts.messages[opts.messages.length - 1] && m.role === "user" && opts.images?.length) {
      const content: { type: string; text?: string; image_url?: { url: string } }[] = [{ type: "text", text: m.content }];
      for (const img of opts.images) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        });
      }
      apiMessages.push({ role: m.role, content });
    } else {
      apiMessages.push({ role: m.role, content: m.content });
    }
  }

  try {
    // requestUrl does not support streaming — use globalThis.fetch for ReadableStream
    const response = await globalThis.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.openrouterApiKey}`,
        "HTTP-Referer": "https://github.com/jkrack/openbrain",
        "X-Title": "OpenBrain",
      },
      body: JSON.stringify({
        model: settings.openrouterModel || "anthropic/claude-sonnet-4.6",
        messages: apiMessages,
        max_tokens: settings.maxTokens,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errBody: { error?: { message?: string } } = await response.json();
      opts.onError(`OpenRouter error: ${errBody.error?.message || response.statusText}`);
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
            const parsed: { choices?: { delta?: { content?: string } }[] } = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) opts.onChunk(delta);
          } catch { /* expected — ignore parse errors */ }
        }
      }
    }

    opts.onDone();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onError(`Network error: ${message}`);
  }
}
