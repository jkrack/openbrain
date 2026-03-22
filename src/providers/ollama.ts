import { OpenBrainSettings } from "../settings";
import { LLMProvider, ChatOptions, StreamEvent, ChatMessage, ToolCall, ToolResultData } from "./types";

export class OllamaProvider implements LLMProvider {
  id = "ollama";
  name = "Ollama (local)";
  supportsImages = true; // Some models support it
  supportsTools = true;  // Some models support function calling

  private settings: OpenBrainSettings;

  constructor(settings: OpenBrainSettings) {
    this.settings = settings;
  }

  formatToolMessages(toolCalls: ToolCall[], results: ToolResultData[]): ChatMessage[] {
    // Ollama uses OpenAI-compatible format — same as OpenRouter
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
    const baseUrl = this.settings.ollamaUrl || "http://localhost:11434";
    const model = this.settings.ollamaModel || "llama3";

    const messages = this.buildMessages(opts.messages, opts.systemPrompt, opts.images);

    // Ollama supports OpenAI-compatible tool calling for some models
    const tools = opts.tools?.map(t => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) body.tools = tools;

    try {
      // requestUrl does not support ReadableStream; window.fetch is required for streaming
      const response = await window.fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        opts.onEvent({ type: "error", error: `Ollama error: ${text || response.statusText}` });
        return;
      }

      await this.parseStream(response, opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("fetch") || message.includes("ECONNREFUSED")) {
        opts.onEvent({ type: "error", error: `Cannot connect to Ollama at ${baseUrl}. Is it running? Start with: ollama serve` });
      } else {
        opts.onEvent({ type: "error", error: `Ollama error: ${message}` });
      }
    }
  }

  private buildMessages(messages: ChatMessage[], systemPrompt: string, images?: { base64: string; mediaType: string }[]): unknown[] {
    const result: unknown[] = [{ role: "system", content: systemPrompt }];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "system") continue;

      if (i === messages.length - 1 && m.role === "user" && images?.length && typeof m.content === "string") {
        // Ollama uses "images" field with base64 data
        result.push({
          role: m.role,
          content: m.content,
          images: images.map(img => img.base64)
        });
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;

          // Ollama native format: { message: { content: "..." }, done: false }
          const msg = parsed.message as Record<string, unknown> | undefined;

          if (msg?.content) {
            opts.onEvent({ type: "text", text: msg.content as string });
          }

          // Tool calls (if model supports them)
          const toolCalls = msg?.tool_calls as Record<string, unknown>[] | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const fn = tc.function as Record<string, unknown>;
              const id = `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              const name = fn?.name as string || "";
              const args = fn?.arguments as Record<string, string> || {};
              opts.onEvent({ type: "tool_use_start", toolUse: { id, name, input: {} } });
              opts.onEvent({ type: "tool_use_end", toolUse: { id, name, input: args } });
            }
          }

          if (parsed.done === true) {
            opts.onEvent({ type: "done" });
          }
        } catch { /* ignore */ }
      }
    }

    opts.onEvent({ type: "done" });
  }
}
