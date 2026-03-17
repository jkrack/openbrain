import { App } from "obsidian";
import { OpenBrainSettings } from "./settings";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenRouterProvider } from "./providers/openrouter";
import { OllamaProvider } from "./providers/ollama";
import { LLMProvider, ChatMessage, StreamEvent } from "./providers/types";
import { getActiveTools } from "./tools";
import { executeTool, ToolResult } from "./toolEngine";
import { startTimer } from "./perf";

export interface ChatEngineOptions {
  messages: ChatMessage[];
  systemPrompt: string;
  allowWrite: boolean;
  images?: { base64: string; mediaType: string }[];
  useTools: boolean; // false for "Chat" mode
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

  // Select provider
  const provider = getProvider(settings);

  // Get tools if enabled
  const tools = opts.useTools ? getActiveTools(opts.allowWrite) : undefined;

  // Boundaries appended to system prompt
  const boundaries = "\nRULES: OpenBrain Obsidian plugin. Vault-relative paths only (never /Users/ or /home/). Stay focused on the vault.";
  const systemPrompt = opts.systemPrompt + boundaries;

  // Build conversation for the agentic loop
  const conversationMessages = [...opts.messages];
  let maxIterations = 10; // prevent infinite tool loops
  let images = opts.images;

  while (maxIterations > 0) {
    maxIterations--;
    const pendingToolCalls: { id: string; name: string; input: Record<string, string> }[] = [];
    let hasToolUse = false;

    try {
      await provider.streamChat({
        messages: conversationMessages,
        systemPrompt,
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
              if (event.toolUse) {
                opts.onToolStart(event.toolUse.name);
              }
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
      const message = err instanceof Error ? err.message : String(err);
      opts.onError(`Chat error: ${message}`);
      doneTimer();
      return;
    }

    // If no tool calls, we're done
    if (!hasToolUse || pendingToolCalls.length === 0) {
      break;
    }

    // Execute tools and build results
    // Add the assistant's response (with tool_use blocks) to conversation
    const assistantContent: unknown[] = [];
    for (const tc of pendingToolCalls) {
      assistantContent.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input
      });
    }
    conversationMessages.push({
      role: "assistant",
      content: assistantContent as ChatMessage["content"]
    });

    // Execute each tool
    const toolResults: ToolResult[] = [];
    for (const tc of pendingToolCalls) {
      const result = await executeTool(app, settings, tc.name, tc.id, tc.input);
      opts.onToolEnd(tc.name, result.is_error ? `Error: ${result.content}` : result.content.slice(0, 100));
      toolResults.push(result);
    }

    // Add tool results to conversation
    conversationMessages.push({
      role: "user",
      content: toolResults.map(r => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error
      })) as ChatMessage["content"]
    });

    // Clear images after first iteration (don't resend)
    images = undefined;
  }

  doneTimer();
  opts.onDone();
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
