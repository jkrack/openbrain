export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  // Image
  source?: { type: "base64"; media_type: string; data: string };
  // Tool use (from model)
  id?: string;
  name?: string;
  input?: Record<string, string>;
  // Tool result (from us)
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface StreamEvent {
  type: "text" | "tool_use_start" | "tool_use_input" | "tool_use_end" | "done" | "error";
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, string> };
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface ChatOptions {
  messages: ChatMessage[];
  systemPrompt: string;
  tools?: ToolDefinition[];
  images?: { base64: string; mediaType: string }[];
  onEvent: (event: StreamEvent) => void;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, string>;
}

export interface ToolResultData {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export interface LLMProvider {
  id: string;
  name: string;
  streamChat(opts: ChatOptions): Promise<void>;
  supportsImages: boolean;
  supportsTools: boolean;
  /** Format tool calls + results as messages for the next API call */
  formatToolMessages(toolCalls: ToolCall[], results: ToolResultData[]): ChatMessage[];
}
