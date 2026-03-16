# Chat Input Redesign & Streaming Fix

## Problem

Two issues in the OpenBrain chat interface:

1. **Response concatenation bug:** The CLI streaming handler in `claude.ts` fires `onChunk()` for both `content_block_delta` events (streaming) and `assistant` full-message events (fallback). When the CLI streams normally, response text is emitted via deltas, then re-emitted in full via the assistant message — producing doubled, concatenated text with missing spacing (e.g., "context.The", "content.I", "for?I").

2. **Cramped chat input area:** The textarea, mic button, and send button are three separate bordered elements squeezed into one row. This doesn't follow the unified input card pattern used by Claude/ChatGPT, feels visually cluttered, and uses emoji characters instead of proper themed icons.

## Design

### 1. Streaming Bug Fix

Add a `receivedDeltas` boolean flag in the CLI streaming handler (`streamClaudeCode` in `src/claude.ts`). When `content_block_delta` events arrive, set it to `true`. When the `assistant` full-message event arrives, skip `onChunk()` if deltas were already received. The full-message path remains as a fallback for non-streaming CLI responses.

**File:** `src/claude.ts` (~3 lines added)

### 2. Lucide Icon Wrapper

Create `src/components/ObsidianIcon.tsx` — a React component wrapping Obsidian's `setIcon()` API to render Lucide SVG icons. Obsidian bundles the full Lucide icon library.

```tsx
function ObsidianIcon({ name, className }: { name: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.empty();
      setIcon(ref.current, name);
    }
  }, [name]);
  return <span ref={ref} className={`ca-icon ${className ?? ""}`} />;
}
```

Icon replacements:

| Location | Before (emoji) | After (Lucide) |
|----------|----------------|----------------|
| Mic button | `⏺` | `mic` |
| Stop button | `■` | `square` |
| Processing | `…` | `loader` |
| Send button | `↑` | `arrow-up` |
| Remove/close | `✕` | `x` |
| Edit/pencil | `✏️` | `pencil` |

### 3. Chat Input Area Redesign

Replace the current inline layout with a unified input card containing a textarea on top and a toolbar row below.

**Current layout:**
```
.ca-input-row (flex, row)
  ├── .ca-input-wrapper
  │     ├── textarea.ca-input (has own border)
  │     └── dropdown menus
  └── children (mic btn, send btn — own borders)
```

**New layout:**
```
.ca-input-card (unified card — has border/radius)
  ├── .ca-input-wrapper
  │     ├── textarea.ca-input (no border, transparent bg)
  │     └── dropdown menus
  └── .ca-input-toolbar (flex, row)
        ├── .ca-toolbar-left (mic + mode toggle)
        └── .ca-toolbar-right (send button)
```

**Visual:**
```
╭──────────────────────────────────────╮
│  Ask anything... (@ to ref a file)   │
│                                      │
├──────────────────────────────────────┤
│  [🎤] [⏺ Toggle]              [↑]  │
╰──────────────────────────────────────╯
```

**Component ownership:** InputArea owns the entire card including mic, send, and toolbar. Panel passes callbacks (`onMicClick`, `micState`, `toggleElement`) as props instead of passing buttons as `children`.

**CSS changes:**

| Element | Before | After |
|---------|--------|-------|
| `.ca-input-card` | *(new)* | Border, border-radius 10px, background secondary |
| `.ca-input-card:focus-within` | *(new)* | Border-color accent |
| `.ca-input` | Own border, border-radius, background | No border, transparent bg, padding 10px 12px |
| `.ca-input-toolbar` | *(new)* | Flex row, space-between, padding 4px 8px 8px |
| `.ca-mic-btn` | 32px square, own border | Borderless, transparent background |
| `.ca-send-btn` | Rectangular with padding | 32×32 circle, border-radius 50% |
| `.ca-icon svg` | *(new)* | width/height 16px |

## Files Changed

| File | Change |
|------|--------|
| `src/claude.ts` | Add `receivedDeltas` guard flag in CLI streaming handler |
| `src/components/ObsidianIcon.tsx` | **New** — Lucide icon wrapper component |
| `src/components/InputArea.tsx` | Restructure to unified card. Own mic/send/toolbar. New props for callbacks |
| `src/panel.tsx` | Remove mic/send button JSX. Pass callbacks + toggle element as props |
| `src/components/AudioControls.tsx` | Replace emoji with ObsidianIcon |
| `src/components/MessageThread.tsx` | Replace emoji with ObsidianIcon |
| `styles.css` | New card/toolbar classes, updated input/button styles, icon sizing |

## What Does Not Change

- `@` mention and `/` slash command behavior
- Keyboard shortcuts (Enter to send, Shift+Enter for newline)
- Audio recording flow (icon swap only)
- Streaming for Anthropic API and OpenRouter sources
- Message rendering (MarkdownBlock unchanged)
- Session/history management

## Risks

- **Low:** `setIcon()` is stable Obsidian API
- **Low:** CSS changes isolated to input area classes
- **Very low:** Streaming fix is a simple guard flag with clear fallback
