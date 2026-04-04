import { App } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenRouterProvider } from "./providers/openrouter";
import { OllamaProvider } from "./providers/ollama";
import { LLMProvider, ChatMessage, StreamEvent, ToolCall, ToolResultData, Message, ImageAttachment } from "./providers/types";
import { getActiveTools } from "./tools";
import { executeTool } from "./toolEngine";
import { startTimer } from "./perf";
import { AttachmentManager } from "./attachmentManager";

// AG-UI–inspired typed event system.
// Consumers receive a single onEvent callback with discriminated events,
// making it impossible to accidentally mix content with status metadata.
export type ChatEvent =
  | { type: "content"; text: string }        // Model-generated content (for responses & post-actions)
  | { type: "tool_start"; toolName: string }  // Tool execution beginning (display-only status)
  | { type: "tool_end"; toolName: string; result: string }  // Tool execution complete
  | { type: "done" }                          // Chat loop finished
  | { type: "error"; message: string };       // Error occurred

export interface ChatEngineOptions {
  messages: ChatMessage[];
  systemPrompt: string;
  allowWrite: boolean;
  images?: ImageAttachment[];
  attachmentManager?: AttachmentManager;
  useTools: boolean;
  onEvent: (event: ChatEvent) => void;
}

export async function runChat(
  app: App,
  settings: OpenBrainSettings,
  opts: ChatEngineOptions
): Promise<void> {
  const doneTimer = startTimer("chat-total");
  const firstTokenTimer = startTimer("time-to-first-token");
  let receivedFirstToken = false;

  const provider = getProvider(settings);
  const tools = opts.useTools ? getActiveTools(opts.allowWrite) : undefined;

  const conversationMessages = [...opts.messages];
  let maxIterations = 10;
  let images = opts.images;
  let resolvedImages: { base64: string; mediaType: string }[] | undefined;
  if (images?.length && opts.attachmentManager) {
    const resolved = await Promise.all(
      images.map(async (img) => {
        const base64 = await opts.attachmentManager!.readAsBase64(img);
        return base64 ? { base64, mediaType: img.mediaType } : null;
      })
    );
    resolvedImages = resolved.filter((r): r is { base64: string; mediaType: string } => r !== null);
  }

  while (maxIterations > 0) {
    maxIterations--;
    const pendingToolCalls: ToolCall[] = [];
    let hasToolUse = false;

    try {
      await provider.streamChat({
        messages: conversationMessages,
        systemPrompt: opts.systemPrompt,
        tools,
        images: resolvedImages,
        onEvent: (event: StreamEvent) => {
          switch (event.type) {
            case "text":
              if (!receivedFirstToken) {
                firstTokenTimer();
                receivedFirstToken = true;
              }
              if (event.text) opts.onEvent({ type: "content", text: event.text });
              break;
            case "tool_use_start":
              if (event.toolUse) opts.onEvent({ type: "tool_start", toolName: event.toolUse.name });
              break;
            case "tool_use_end":
              if (event.toolUse) {
                hasToolUse = true;
                pendingToolCalls.push(event.toolUse);
              }
              break;
            case "error":
              opts.onEvent({ type: "error", message: event.error || "Unknown error" });
              break;
            case "done":
              break;
          }
        }
      });
    } catch (err: unknown) {
      opts.onEvent({ type: "error", message: `Chat error: ${err instanceof Error ? err.message : String(err)}` });
      doneTimer();
      return;
    }

    if (!hasToolUse || pendingToolCalls.length === 0) break;

    // Execute each tool
    const results: ToolResultData[] = [];
    for (const tc of pendingToolCalls) {
      const result = await executeTool(app, settings, tc.name, tc.id, tc.input);
      opts.onEvent({ type: "tool_end", toolName: tc.name, result: result.is_error ? `Error: ${result.content}` : result.content.slice(0, 100) });
      results.push(result);
    }

    // Let the provider format the tool messages in its native format
    const toolMessages = provider.formatToolMessages(pendingToolCalls, results);
    conversationMessages.push(...toolMessages);

    images = undefined; // Don't resend images
    resolvedImages = undefined;
  }

  doneTimer();
  opts.onEvent({ type: "done" });
}

/**
 * Generate a one-line TLDR summary of a conversation using the configured provider.
 */
export async function summarizeChat(
  settings: OpenBrainSettings,
  messages: Message[]
): Promise<string | null> {
  if (messages.length < 2) return null;

  const provider = getProvider(settings);
  const prompt = "Summarize this entire conversation in ONE sentence (under 80 chars) for a daily note. Just the summary, nothing else.";

  const apiMessages: ChatMessage[] = messages.slice(-6).map(m => ({
    role: m.role,
    content: m.content.slice(0, 300)
  }));
  apiMessages.push({ role: "user", content: prompt });

  let summary = "";

  try {
    await provider.streamChat({
      messages: apiMessages,
      systemPrompt: "Respond with ONLY a one-sentence summary. Nothing else.",
      onEvent: (event) => {
        if (event.type === "text" && event.text) summary += event.text;
      }
    });
  } catch {
    return null;
  }

  const trimmed = summary.trim();
  return (trimmed && trimmed.length < 200) ? trimmed : null;
}

function getProvider(settings: OpenBrainSettings): LLMProvider {
  switch (settings.chatProvider) {
    case "openrouter":
      return new OpenRouterProvider(settings);
    case "ollama":
      return new OllamaProvider(settings);
    default:
      return new AnthropicProvider(settings);
  }
}
