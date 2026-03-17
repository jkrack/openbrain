import { OpenBrainSettings } from "../settings";
import { LLMProvider, ChatOptions, StreamEvent, ChatMessage, ToolDefinition, ToolCall, ToolResultData } from "./types";

export class OpenRouterProvider implements LLMProvider {
  id = "openrouter";
  name = "OpenRouter";
  supportsImages = true;
  supportsTools = true;

  private settings: OpenBrainSettings;

  constructor(settings: OpenBrainSettings) {
    this.settings = settings;
  }

  formatToolMessages(toolCalls: ToolCall[], results: ToolResultData[]): ChatMessage[] {
    // Use the same Anthropic content block format — buildMessages converts to OpenAI format
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
    if (!this.settings.openrouterApiKey) {
      opts.onEvent({ type: "error", error: "OpenRouter API key required. Add it in settings." });
      return;
    }

    const messages = this.buildMessages(opts.messages, opts.systemPrompt, opts.images);

    // OpenAI format tools
    const tools = opts.tools?.map(t => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));

    const body: Record<string, unknown> = {
      model: this.settings.openrouterModel || "anthropic/claude-sonnet-4.6",
      max_tokens: this.settings.maxTokens || 4096,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) body.tools = tools;

    try {
      const response = await globalThis.fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.settings.openrouterApiKey}`,
          "HTTP-Referer": "https://github.com/jkrack/openbrain",
          "X-Title": "OpenBrain",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json();
        opts.onEvent({ type: "error", error: `OpenRouter error: ${(err as Record<string, Record<string, string>>).error?.message || response.statusText}` });
        return;
      }

      await this.parseStream(response, opts);
    } catch (err: unknown) {
      opts.onEvent({ type: "error", error: `Network error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private buildMessages(messages: ChatMessage[], systemPrompt: string, images?: { base64: string; mediaType: string }[]): unknown[] {
    const result: unknown[] = [{ role: "system", content: systemPrompt }];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "system") continue;

      // Handle content block arrays (tool_use from assistant, tool_result from user)
      if (Array.isArray(m.content)) {
        const blocks = m.content as unknown as Record<string, unknown>[];

        // Assistant message with tool_use blocks → OpenAI tool_calls format
        if (m.role === "assistant" && blocks.some(b => b.type === "tool_use")) {
          const textParts = blocks.filter(b => b.type === "text").map(b => b.text as string).join("");
          const toolCalls = blocks.filter(b => b.type === "tool_use").map(b => ({
            id: b.id as string,
            type: "function",
            function: { name: b.name as string, arguments: JSON.stringify(b.input) }
          }));
          result.push({ role: "assistant", content: textParts || null, tool_calls: toolCalls });
          continue;
        }

        // User message with tool_result blocks → separate "tool" role messages
        if (m.role === "user" && blocks.some(b => b.type === "tool_result")) {
          for (const b of blocks) {
            if (b.type === "tool_result") {
              result.push({ role: "tool", tool_call_id: b.tool_use_id as string, content: b.content as string });
            }
          }
          continue;
        }

        // Other array content — stringify
        result.push({ role: m.role, content: JSON.stringify(m.content) });
        continue;
      }

      // Attach images to last user message
      if (i === messages.length - 1 && m.role === "user" && images?.length && typeof m.content === "string") {
        const content: unknown[] = [{ type: "text", text: m.content }];
        for (const img of images) {
          content.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
        }
        result.push({ role: m.role, content });
      } else {
        result.push({ role: m.role, content: m.content });
      }
    }
    return result;
  }

  private async parseStream(response: Response, opts: ChatOptions): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) { opts.onEvent({ type: "error", error: "No response body" }); return; }

    const decoder = new TextDecoder();
    let buf = "";
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

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
          const choices = parsed.choices as Record<string, unknown>[];
          if (!choices?.[0]) continue;

          const delta = choices[0].delta as Record<string, unknown>;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            opts.onEvent({ type: "text", text: delta.content as string });
          }

          // Tool calls (OpenAI format)
          const tc = delta.tool_calls as Record<string, unknown>[];
          if (tc) {
            for (const call of tc) {
              const idx = call.index as number;
              const fn = call.function as Record<string, string> | undefined;

              if (call.id) {
                toolCalls.set(idx, { id: call.id as string, name: fn?.name || "", args: "" });
                opts.onEvent({ type: "tool_use_start", toolUse: { id: call.id as string, name: fn?.name || "", input: {} } });
              }

              if (fn?.arguments) {
                const existing = toolCalls.get(idx);
                if (existing) existing.args += fn.arguments;
              }
            }
          }

          // Check for finish
          const finishReason = choices[0].finish_reason as string | null;
          if (finishReason === "tool_calls") {
            // Emit completed tool calls
            for (const [, tc] of toolCalls) {
              try {
                const input = JSON.parse(tc.args) as Record<string, string>;
                opts.onEvent({ type: "tool_use_end", toolUse: { id: tc.id, name: tc.name, input } });
              } catch {
                opts.onEvent({ type: "tool_use_end", toolUse: { id: tc.id, name: tc.name, input: {} } });
              }
            }
            toolCalls.clear();
          }
        } catch { /* ignore */ }
      }
    }

    opts.onEvent({ type: "done" });
  }
}
