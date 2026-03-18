import { App } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenRouterProvider } from "./providers/openrouter";
import { OllamaProvider } from "./providers/ollama";
import { LLMProvider, ChatMessage, StreamEvent, ToolCall, ToolResultData, Message } from "./providers/types";
import { getActiveTools } from "./tools";
import { executeTool } from "./toolEngine";
import { startTimer } from "./perf";

export interface ChatEngineOptions {
  messages: ChatMessage[];
  systemPrompt: string;
  allowWrite: boolean;
  images?: { base64: string; mediaType: string }[];
  useTools: boolean;
  onText: (text: string) => void;
  onToolStart: (name: string) => void;
  onToolEnd: (name: string, result: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
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

  while (maxIterations > 0) {
    maxIterations--;
    const pendingToolCalls: ToolCall[] = [];
    let hasToolUse = false;

    try {
      await provider.streamChat({
        messages: conversationMessages,
        systemPrompt: opts.systemPrompt,
        tools,
        images,
        onEvent: (event: StreamEvent) => {
          switch (event.type) {
            case "text":
              if (!receivedFirstToken) {
                firstTokenTimer();
                receivedFirstToken = true;
              }
              if (event.text) opts.onText(event.text);
              break;
            case "tool_use_start":
              if (event.toolUse) opts.onToolStart(event.toolUse.name);
              break;
            case "tool_use_end":
              if (event.toolUse) {
                hasToolUse = true;
                pendingToolCalls.push(event.toolUse);
              }
              break;
            case "error":
              opts.onError(event.error || "Unknown error");
              break;
            case "done":
              break;
          }
        }
      });
    } catch (err: unknown) {
      opts.onError(`Chat error: ${err instanceof Error ? err.message : String(err)}`);
      doneTimer();
      return;
    }

    if (!hasToolUse || pendingToolCalls.length === 0) break;

    // Execute each tool
    const results: ToolResultData[] = [];
    for (const tc of pendingToolCalls) {
      const result = await executeTool(app, settings, tc.name, tc.id, tc.input);
      opts.onToolEnd(tc.name, result.is_error ? `Error: ${result.content}` : result.content.slice(0, 100));
      results.push(result);
    }

    // Let the provider format the tool messages in its native format
    const toolMessages = provider.formatToolMessages(pendingToolCalls, results);
    conversationMessages.push(...toolMessages);

    images = undefined; // Don't resend images
  }

  doneTimer();
  opts.onDone();
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
