import { OpenBrainSettings } from "../settings";
import { LLMProvider, ChatOptions, StreamEvent, ChatMessage, ToolDefinition, ToolCall, ToolResultData } from "./types";

export class AnthropicProvider implements LLMProvider {
  id = "anthropic";
  name = "Anthropic (Claude)";
  supportsImages = true;
  supportsTools = true;

  private settings: OpenBrainSettings;

  constructor(settings: OpenBrainSettings) {
    this.settings = settings;
  }

  formatToolMessages(toolCalls: ToolCall[], results: ToolResultData[]): ChatMessage[] {
    return [
      {
        role: "assistant",
        content: toolCalls.map(tc => ({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
      },
      {
        role: "user",
        content: results.map(r => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
          is_error: r.is_error,
        })),
      },
    ];
  }

  async streamChat(opts: ChatOptions): Promise<void> {
    if (!this.settings.apiKey) {
      opts.onEvent({ type: "error", error: "Anthropic API key required. Add it in settings." });
      return;
    }

    // Build Anthropic messages format
    const messages = this.buildMessages(opts.messages, opts.images);

    // Build tools in Anthropic format
    const tools = opts.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema
    }));

    const body: Record<string, unknown> = {
      model: this.settings.anthropicModel || this.settings.model || "claude-sonnet-4-20250514",
      max_tokens: this.settings.maxTokens || 4096,
      system: opts.systemPrompt,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) body.tools = tools;

    try {
      // eslint-disable-next-line no-restricted-globals -- Obsidian's requestUrl does not support streaming responses (ReadableStream). Streaming is required for real-time token delivery.
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.settings.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json();
        opts.onEvent({ type: "error", error: `API error: ${(err as Record<string, Record<string, string>>).error?.message || response.statusText}` });
        return;
      }

      await this.parseStream(response, opts);
    } catch (err: unknown) {
      opts.onEvent({ type: "error", error: `Network error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private buildMessages(messages: ChatMessage[], images?: { base64: string; mediaType: string }[]): unknown[] {
    return messages
      .filter(m => m.role !== "system")
      .map((m, idx, arr) => {
        // Attach images to last user message
        if (idx === arr.length - 1 && m.role === "user" && images?.length && typeof m.content === "string") {
          const content: unknown[] = [{ type: "text", text: m.content }];
          for (const img of images) {
            content.push({
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.base64 }
            });
          }
          return { role: m.role, content };
        }
        return { role: m.role, content: m.content };
      });
  }

  private async parseStream(response: Response, opts: ChatOptions): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) { opts.onEvent({ type: "error", error: "No response body" }); return; }

    const decoder = new TextDecoder();
    let buf = "";
    let currentToolUse: { id: string; name: string; inputJson: string } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const eventType = parsed.type as string;

          if (eventType === "content_block_start") {
            const block = parsed.content_block as Record<string, unknown>;
            if (block?.type === "tool_use") {
              currentToolUse = { id: block.id as string, name: block.name as string, inputJson: "" };
              opts.onEvent({ type: "tool_use_start", toolUse: { id: block.id as string, name: block.name as string, input: {} } });
            }
          } else if (eventType === "content_block_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.type === "text_delta") {
              opts.onEvent({ type: "text", text: delta.text as string });
            } else if (delta?.type === "input_json_delta" && currentToolUse) {
              currentToolUse.inputJson += delta.partial_json as string;
            }
          } else if (eventType === "content_block_stop") {
            if (currentToolUse) {
              try {
                const input = JSON.parse(currentToolUse.inputJson) as Record<string, string>;
                opts.onEvent({ type: "tool_use_end", toolUse: { id: currentToolUse.id, name: currentToolUse.name, input } });
              } catch {
                opts.onEvent({ type: "tool_use_end", toolUse: { id: currentToolUse.id, name: currentToolUse.name, input: {} } });
              }
              currentToolUse = null;
            }
          } else if (eventType === "message_stop") {
            opts.onEvent({ type: "done" });
          }
        } catch { /* ignore parse errors */ }
      }
    }

    opts.onEvent({ type: "done" });
  }
}
