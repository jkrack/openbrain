# API-First Architecture Migration — Design Spec

## Problem

Claude Code CLI adds excessive complexity for a plugin:
- 23+ second response times (CLI startup + thinking overhead)
- Built-in skills/memory/hooks interfere with OpenBrain's behavior
- PATH issues, dock icon flicker, permission mode hacks in Electron
- Non-interactive spawn limitations (can't prompt for approval)
- Users still need Claude Code installed ($20/month subscription)

## Solution

Replace Claude Code CLI with direct API calls + Obsidian CLI for vault operations. Support multiple providers: Anthropic, OpenRouter, and Ollama (local).

## Architecture

```
Current:
  User message → panel.tsx → spawn Claude Code CLI → stdout streaming
                                    ↓
                              Claude reads/writes files via its own tools

New:
  User message → panel.tsx → API streaming (Anthropic / OpenRouter / Ollama)
                                    ↓
                              Claude returns tool_use blocks
                                    ↓
                              OpenBrain executes tools via Obsidian CLI + vault API
                                    ↓
                              Results sent back → Claude continues
```

The key change: **we** execute tools, not Claude Code. Claude's API returns structured `tool_use` blocks, we execute them via Obsidian CLI or vault API, and send results back.

## Provider Architecture

```typescript
interface LLMProvider {
  id: string;
  name: string;
  streamChat(opts: ChatOptions): AsyncIterable<StreamEvent>;
  supportsImages: boolean;
  supportsTools: boolean;
  requiresApiKey: boolean;
}

// Three providers
AnthropicProvider    // api.anthropic.com — Claude models, tool_use, images
OpenRouterProvider   // openrouter.ai — any model, tool_use, images
OllamaProvider       // localhost:11434 — local models, no API key, free
```

## Tool System

Define vault tools that Claude can call via the API's tool_use feature:

```typescript
const VAULT_TOOLS = [
  {
    name: "vault_search",
    description: "Search the vault for notes matching a query",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" }
      },
      required: ["query"]
    }
  },
  {
    name: "vault_read",
    description: "Read a note's content",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative file path" }
      },
      required: ["path"]
    }
  },
  {
    name: "vault_create",
    description: "Create a new note",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative file path" },
        content: { type: "string", description: "Note content" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "vault_edit",
    description: "Edit an existing note by replacing text",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative file path" },
        old_text: { type: "string", description: "Text to find" },
        new_text: { type: "string", description: "Replacement text" }
      },
      required: ["path", "old_text", "new_text"]
    }
  },
  {
    name: "vault_append",
    description: "Append content to a note",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative file path" },
        content: { type: "string", description: "Content to append" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "daily_read",
    description: "Read today's daily note",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "daily_append",
    description: "Append to a section of today's daily note",
    input_schema: {
      type: "object",
      properties: {
        section: { type: "string", description: "Section heading (e.g., Capture, Focus)" },
        content: { type: "string", description: "Content to append" }
      },
      required: ["section", "content"]
    }
  },
  {
    name: "vault_tasks",
    description: "Get open tasks from a file or the daily note",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File path (omit for daily note)" },
        filter: { type: "string", enum: ["todo", "done"], description: "Task status filter" }
      }
    }
  },
  {
    name: "vault_list",
    description: "List files in a folder",
    input_schema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder path" }
      }
    }
  },
  // --- Graph & Structure ---
  {
    name: "vault_backlinks",
    description: "Find all notes that link TO this file",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    }
  },
  {
    name: "vault_links",
    description: "Get all outgoing links FROM this file",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    }
  },
  {
    name: "vault_outline",
    description: "Get the heading structure of a note",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    }
  },
  // --- Properties & Tags ---
  {
    name: "vault_properties",
    description: "Read frontmatter properties from a note",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    }
  },
  {
    name: "vault_property_set",
    description: "Set a frontmatter property on a note",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        name: { type: "string" },
        value: { type: "string" },
        type: { type: "string", enum: ["text", "number", "date", "list"] }
      },
      required: ["path", "name", "value"]
    }
  },
  {
    name: "vault_tags",
    description: "List all tags in the vault with counts",
    input_schema: { type: "object", properties: {} }
  },
  // --- File Operations ---
  {
    name: "vault_rename",
    description: "Rename a note (updates all links automatically)",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        new_name: { type: "string", description: "New name without path" }
      },
      required: ["path", "new_name"]
    }
  },
  {
    name: "vault_move",
    description: "Move a note to a different folder",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        to: { type: "string", description: "Destination folder" }
      },
      required: ["path", "to"]
    }
  },
  {
    name: "vault_delete",
    description: "Delete a note (moves to Obsidian trash)",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    }
  },
  // --- Vault Health ---
  {
    name: "vault_orphans",
    description: "Find notes with no incoming links",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "vault_deadends",
    description: "Find broken links pointing to nonexistent notes",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "vault_unresolved",
    description: "Find unresolved wikilinks",
    input_schema: { type: "object", properties: {} }
  },
  // --- Contextual Search ---
  {
    name: "vault_search_context",
    description: "Search with surrounding context shown around matches",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"]
    }
  }
];
```

**22 tools total**, gated by permissions:

| Permission | Tools |
|---|---|
| **Always available** (14) | search, search_context, read, list, backlinks, links, outline, properties, tags, tasks, daily_read, orphans, deadends, unresolved |
| **Requires write** (8) | create, edit, append, daily_append, property_set, rename, move, delete |

Tools are **gated by permissions** — write tools (create, edit, append, daily_append) only included when write is enabled. Search/read always available.

## Tool Execution Loop

```
1. Send user message + tools to API
2. Stream response
3. If response contains tool_use blocks:
   a. Execute each tool via Obsidian CLI / vault API
   b. Collect results
   c. Send tool results back to API
   d. Stream the continuation
   e. Repeat if more tool_use blocks
4. When response has no tool_use (stop_reason: "end_turn"), done
```

This is the standard agentic loop for Claude's API.

## Provider Implementations

### Anthropic (api.anthropic.com)

```
POST /v1/messages
- model: claude-sonnet-4-20250514
- tools: VAULT_TOOLS (filtered by permissions)
- stream: true
- messages: conversation history
```

Streaming returns `content_block_start`, `content_block_delta`, `content_block_stop` events. Tool use blocks have type `tool_use` with `id`, `name`, `input`.

### OpenRouter (openrouter.ai)

```
POST /api/v1/chat/completions
- model: user-selected
- tools: VAULT_TOOLS (OpenAI format)
- stream: true
```

OpenAI-compatible tool calling. Tool calls in `choices[0].delta.tool_calls`.

### Ollama (localhost:11434)

```
POST /api/chat
- model: user-selected (llama3, mistral, etc.)
- tools: VAULT_TOOLS (OpenAI format — Ollama supports it)
- stream: true
```

No API key needed. Runs entirely local. Tool support depends on model — some Ollama models support function calling, some don't. Fall back to prompt-based tool use for models without native support.

## Session Management

Claude Code CLI handled sessions via `--resume`. With direct API, we manage conversation history ourselves.

We already store messages in `Message[]`. For the API, we just send the full array. For long conversations, we truncate older messages to stay within context limits.

```typescript
function buildApiMessages(messages: Message[], maxTokenEstimate = 100000): ApiMessage[] {
  // Always include system message
  // Include last N messages that fit in context
  // For very long conversations, summarize older messages
}
```

## Settings Changes

```typescript
interface OpenBrainSettings {
  // Remove
  // claudePath: string;        // No longer needed

  // Keep
  apiKey: string;               // Anthropic key
  openrouterApiKey: string;     // OpenRouter key

  // Add
  provider: "anthropic" | "openrouter" | "ollama";
  ollamaUrl: string;            // default: http://localhost:11434
  ollamaModel: string;          // default: llama3
  anthropicModel: string;       // default: claude-sonnet-4-20250514
  openrouterModel: string;      // existing

  // Keep but rename conceptually
  // chatMode → removed (only one mode now — API with optional tools)
  // allowVaultWrite → still controls which tools are available
  // allowCliExec → controls whether vault_search uses Obsidian CLI
}
```

The mode toggle (Vault/Chat) becomes simpler:
- **Full** mode: all tools available (replaces "Vault")
- **Chat** mode: no tools, just conversation (replaces "Chat")

## Migration Path

### Phase 1: Add tool execution engine (no UI changes)
- Create `src/toolEngine.ts` — executes vault tools, returns results
- Create `src/providers/anthropic.ts` — streaming with tool_use support
- Create `src/providers/openrouter.ts` — streaming with tool calling
- Create `src/providers/ollama.ts` — streaming with optional tools

### Phase 2: Wire into panel (replace CLI calls)
- Update `panel.tsx` to use providers instead of `streamClaudeCode`
- Implement the tool execution loop
- Show tool execution status in UI ("Reading file...", "Searching vault...")

### Phase 3: Remove Claude Code CLI dependency
- Remove `streamClaudeCode` function
- Remove `spawn`, `ChildProcess` imports
- Remove `--permission-mode`, `--disable-slash-commands` flags
- Remove `claudePath` setting
- Update README, onboarding, setup check

### Phase 4: Add Ollama provider
- Settings UI for Ollama URL + model
- Model discovery (list available models from Ollama API)
- Fallback for models without tool support

## Backward Compatibility

- Keep `claudePath` in settings for one version with a deprecation notice
- If set and new provider not configured, fall back to CLI (migration period)
- Remove CLI fallback in v2.0.0

## Performance Expectations

| Metric | Claude Code CLI | Direct API |
|--------|----------------|------------|
| Time to first token | 5-23s | 1-3s |
| Tool execution | Claude does it (opaque) | We do it (visible, fast) |
| Cold start | 3-5s per spawn | 0 (HTTP request) |
| Session resume | CLI manages | We manage (message array) |
| Images | Not supported | Native |
| Streaming | JSON stdout parsing | SSE (standard) |

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/providers/anthropic.ts` | **Create** | Anthropic API with tool_use streaming |
| `src/providers/openrouter.ts` | **Create** | OpenRouter with tool calling |
| `src/providers/ollama.ts` | **Create** | Ollama local with optional tools |
| `src/providers/types.ts` | **Create** | Shared LLMProvider interface |
| `src/toolEngine.ts` | **Create** | Execute vault tools, return results |
| `src/tools.ts` | **Create** | Tool definitions (VAULT_TOOLS) |
| `src/panel.tsx` | **Modify** | Use providers + tool loop instead of CLI |
| `src/claude.ts` | **Modify** | Remove streamClaudeCode, keep API helpers |
| `src/settings.ts` | **Modify** | Provider selection, Ollama config |
| `src/components/ChatHeader.tsx` | **Modify** | Simplified mode toggle |
