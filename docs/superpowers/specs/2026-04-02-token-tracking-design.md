# Token Usage Tracking

## Problem

OpenBrain has no visibility into token consumption. Users can't see how many tokens a conversation uses, what it costs, or how usage trends over time. The perf timers track latency but not volume.

## Solution

Capture token counts from each provider's streaming response, accumulate per-conversation in ChatStateManager, persist in chat file frontmatter, display a live counter in the chat header, and aggregate into a usage dashboard in settings.

## Data Capture

Each provider's streaming parser already processes SSE events. Add token usage extraction:

**Anthropic:** The `message_start` SSE event includes `message.usage.input_tokens`. The final `message_delta` event includes `usage.output_tokens`. Both are present in every streamed response. **Note:** The current `parseStream` in `anthropic.ts` does not handle `message_start` or `message_delta` events — new cases must be added to the event type switch alongside the existing `content_block_start`, `content_block_delta`, etc.

**OpenRouter:** The final SSE chunk includes `usage.prompt_tokens` and `usage.completion_tokens` at the top level of the parsed object (not inside `choices`). **Important:** This field is only present when the request includes `stream_options: { include_usage: true }` in the body. The current request body in `openrouter.ts` does not include this — it must be added.

**Ollama:** The final response chunk (where `done: true`) includes `prompt_eval_count` (input) and `eval_count` (output) on the same object. Extract usage at the same point as the `done` check, before emitting the done event.

### New Callback

Add `onUsage` to `ChatOptions` in `providers/types.ts`:

```typescript
onUsage?: (usage: { inputTokens: number; outputTokens: number; model: string }) => void;
```

Each provider calls `onUsage` once per streaming response, after parsing the usage data from the final event. If the provider doesn't return usage data (e.g., older Ollama versions), `onUsage` is not called.

**Agentic loop note:** The chat engine runs an agentic loop (up to 10 iterations per user message). Each iteration calls `streamChat` independently, so `onUsage` fires once per LLM turn — not once per user message. This is correct and expected: all tokens across the full loop should be counted. The `addTokens` method accumulates, so multiple callbacks per message work naturally.

## Per-Conversation Counter

`ChatStateManager` gets two new fields:

```typescript
inputTokens: number;   // accumulated across all messages in this conversation
outputTokens: number;  // accumulated across all messages in this conversation
```

`chatEngine.ts` passes an `onUsage` callback to the provider that adds to these counters:

```typescript
onUsage: (usage) => {
  chatState.addTokens(usage.inputTokens, usage.outputTokens);
}
```

The `addTokens` method adds to the running totals and triggers a change event.

### Chat Header Display

`ChatHeader` shows a small token label when tokens > 0: `"1.2k in · 800 out"`. Tokens are formatted with `k` suffix above 1000. Displayed right-aligned in the header alongside existing permission toggles.

## Chat Frontmatter Persistence

`chatHistory.ts` adds `input_tokens` and `output_tokens` to the YAML frontmatter:

```yaml
---
type: openbrain-chat
format_version: 2
title: Sprint planning
input_tokens: 4523
output_tokens: 1891
...
---
```

These fields are read on chat load (populating ChatStateManager) and written on every save (capturing the latest totals). The `ChatMeta` interface gains `inputTokens`, `outputTokens`, and `model` fields (all optional — missing values default to 0/"").

**Format version:** Do NOT bump `format_version`. These are additive optional fields. The existing `parseChat` helper returns `""` for missing frontmatter keys, which converts to `0` for numbers. Old chat files work without changes.

This means:
- Token data persists across Obsidian restarts
- Token data syncs across devices via vault sync
- The usage dashboard can aggregate by scanning chat frontmatter
- No separate storage file needed

## Cost Estimation

A `tokenCost.ts` utility provides cost estimates:

```typescript
interface TokenCost {
  inputCost: number;   // USD
  outputCost: number;  // USD
  totalCost: number;   // USD
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): TokenCost | null;
```

Hardcoded price table for common models (per 1M tokens):

| Model pattern | Input | Output |
|--------------|-------|--------|
| `claude-sonnet-4` | $3.00 | $15.00 |
| `claude-opus-4` | $15.00 | $75.00 |
| `claude-haiku-4` | $0.80 | $4.00 |
| `gpt-4o` | $2.50 | $10.00 |
| `gpt-4o-mini` | $0.15 | $0.60 |

Model matching is prefix-based — `claude-sonnet-4-20250514` matches `claude-sonnet-4`. Returns `null` for unknown models (dashboard shows tokens only, no cost).

The price table is a simple object literal. No settings UI for custom rates — YAGNI.

## Usage Dashboard in Settings

A new "Usage" section in the **General** settings tab. Scans chat file frontmatter on render to aggregate usage.

### Display

**Today:**
- Input tokens: 12,450
- Output tokens: 5,230
- Estimated cost: ~$0.12

**This Week:**
- Input tokens: 45,200
- Output tokens: 18,900
- Estimated cost: ~$0.42

**This Month:**
- Input tokens: 186,000
- Output tokens: 72,400
- Estimated cost: ~$1.72

**By Model:**
| Model | Input | Output | Est. Cost |
|-------|-------|--------|-----------|
| claude-sonnet-4 | 150k | 60k | $1.35 |
| llama3 (local) | 36k | 12.4k | free |

**Top Conversations:**
- Sprint planning (3,200 in / 1,800 out) — ~$0.04
- Weekly review (2,100 in / 900 out) — ~$0.02

No charts — clean text and tables. Lightweight to render.

### Aggregation

Scan `settings.chatFolder` for markdown files with `type: openbrain-chat` frontmatter via `app.metadataCache`. Read `input_tokens`, `output_tokens`, `updated`, and `model` fields. Group by date ranges using the `updated` field (format: `"YYYY-MM-DD HH:mm"`, parseable with `new Date()`). Cache the scan result for the lifetime of the settings tab render.

**Note:** `metadataCache` is async and may not reflect a file just written in the current session. This is acceptable for a settings panel — it shows usage from completed conversations, not the one currently in progress (which is visible in the chat header counter).

## Model in Frontmatter

Add `model` field to chat frontmatter so the dashboard can aggregate by model:

```yaml
model: claude-sonnet-4-20250514
```

The model string comes from the `onUsage` callback payload (`usage.model`), which each provider sets from its own model config. `chatEngine.ts` stores the most recent model on ChatStateManager, and `chatHistory.ts` writes it from there. Do NOT read the model from settings directly — the `onUsage` callback is the source of truth since it reflects what the provider actually used.

## New Files

| File | Purpose |
|------|---------|
| `src/tokenCost.ts` | Price table + `estimateCost()` function |

## Modified Files

| File | Change |
|------|--------|
| `src/providers/types.ts` | Add `onUsage` callback to `ChatOptions` |
| `src/providers/anthropic.ts` | Parse `usage` from `message_start` and `message_delta` events, call `onUsage` |
| `src/providers/openrouter.ts` | Parse `usage` from final SSE chunk, call `onUsage` |
| `src/providers/ollama.ts` | Parse `prompt_eval_count`/`eval_count`, call `onUsage` |
| `src/chatEngine.ts` | Pass `onUsage` through to provider, accumulate on ChatStateManager |
| `src/chatStateManager.ts` | Add `inputTokens`, `outputTokens` fields + `addTokens()` method |
| `src/chatHistory.ts` | Read/write `input_tokens`, `output_tokens`, `model` in frontmatter |
| `src/settings.ts` | Add "Usage" section in General tab with aggregated stats |
| `src/components/ChatHeader.tsx` | Add `inputTokens` and `outputTokens` props. Show live token counter label when > 0. |

## What This Does NOT Include

- No per-message token breakdown (only per-conversation totals)
- No custom price rates in settings
- No export/CSV of usage data
- No budget alerts or spending limits
- No charts or graphs — text and tables only
