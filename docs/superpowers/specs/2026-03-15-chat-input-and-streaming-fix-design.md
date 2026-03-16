# Chat Input Redesign & Streaming Fix

## Problem

Two issues in the OpenBrain chat interface:

1. **Response concatenation bug:** The CLI streaming handler in `claude.ts` fires `onChunk()` for both `content_block_delta` events (streaming) and `assistant` full-message events (fallback). When the CLI streams normally, response text is emitted via deltas, then re-emitted in full via the assistant message — producing doubled, concatenated text with missing spacing (e.g., "context.The", "content.I", "for?I").

2. **Cramped chat input area:** The textarea, mic button, and send button are three separate bordered elements squeezed into one row. This doesn't follow the unified input card pattern used by Claude/ChatGPT, feels visually cluttered, and uses emoji characters instead of proper themed icons.

## Design

### 1. Streaming Bug Fix

Add a `receivedDeltas` boolean flag in the CLI streaming handler (`streamClaudeCode` in `src/claude.ts`). When `content_block_delta` events arrive, set it to `true`. When the `assistant` full-message event arrives, skip `onChunk()` if deltas were already received. The full-message path remains as a fallback for non-streaming CLI responses.

The flag is scoped to the `streamClaudeCode` function closure, which is called fresh for each user message. No reset logic is needed — each invocation gets its own flag.

**Assumption:** The `assistant` full-message event contains the same text content as the streamed deltas. If the CLI ever emits an `assistant` message with content not covered by deltas (e.g., tool-use results), that content would be dropped. This is an acceptable trade-off — the current CLI behavior always duplicates delta content in the assistant message. If this assumption changes, the guard can be refined to track which text blocks were already emitted.

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

**Complete icon replacement table:**

| File | Location | Before (emoji) | After (Lucide) |
|------|----------|----------------|----------------|
| `panel.tsx` | Mic button (idle) | `⏺` | `mic` |
| `panel.tsx` | Mic button (recording) | `■` | `square` |
| `panel.tsx` | Mic button (processing) | `…` | `loader` |
| `panel.tsx` | Send button | `↑` | `arrow-up` |
| `AudioControls.tsx` | Edit/pencil button | `✏️` (`\u270E`) | `pencil` |
| `AudioControls.tsx` | Discard button | `✕` (`\u2715`) | `x` |
| `InputArea.tsx` | Attached file remove button | `✕` (`\u2715`) | `x` |
| `MessageThread.tsx` | Copy button (idle) | `⧉` (`\u29C9`) | `copy` |
| `MessageThread.tsx` | Copy button (copied) | `✓` (`\u2713`) | `check` |

**Out of scope for icon replacement:** The `AudioControls.tsx` "Send" button (line 83) uses the text label `"Send"`, which is intentional and stays as-is. The `MessageThread.tsx` empty-state diamond (`\u25C8` at line 99) and audio tag microphone emoji (line 138) are decorative indicators, not action buttons — they stay as-is for now and can be addressed in a future pass.

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
        ├── .ca-toolbar-left (mic button)
        └── .ca-toolbar-right (send button)
```

**Visual:**
```
╭──────────────────────────────────────╮
│  Ask anything... (@ to ref a file)   │
│                                      │
├──────────────────────────────────────┤
│  [🎤]                          [↑]  │
╰──────────────────────────────────────╯
```

**Note on mode toggle:** The `Vault`/`Chat` mode toggle is currently in the header (`ChatHeader.tsx`) and stays there. It is not part of this input area redesign.

#### New InputArea Props

InputArea currently accepts `children?: React.ReactNode` for the mic and send buttons. Replace `children` with explicit props:

```typescript
// New props (replacing children)
onMicClick: () => void;
micState: "idle" | "recording" | "processing";
isSendDisabled: boolean;
```

- `onMicClick` — callback for the mic button click
- `micState` — drives which icon to show (`mic`, `square`, or `loader`) and CSS class (`recording`, `processing`)
- `isSendDisabled` — controls whether the send button is disabled (replaces the inline `isStreaming || isRecording || !input.trim()` check)

The `isStreaming` prop is retained for disabling the textarea. The `isRecording` prop is retained for disabling the textarea. The mic button is disabled when `isStreaming` is true OR `micState === "processing"` — InputArea handles both conditions internally using the existing `isStreaming` prop and the new `micState` prop.

Remove: `children` prop from `InputAreaProps`.

#### CSS changes

| Element | Before | After |
|---------|--------|-------|
| `.ca-input-card` | *(new)* | `border: 1px solid var(--background-modifier-border); border-radius: 8px; background: var(--background-secondary);` |
| `.ca-input-card:focus-within` | *(new)* | `border-color: var(--interactive-accent);` |
| `.ca-input` | Own border, border-radius 8px, background | `border: none; background: transparent; padding: 10px 12px;` |
| `.ca-input-toolbar` | *(new)* | `display: flex; justify-content: space-between; align-items: center; padding: 4px 8px 8px;` |
| `.ca-mic-btn` | 32px square, own border | `border: none; background: transparent;` |
| `.ca-mic-btn:hover:not(:disabled)` | Background hover | `background: var(--background-modifier-hover); border-radius: 8px;` |
| `.ca-mic-btn:disabled` | *(no change)* | `opacity: 0.4; cursor: not-allowed;` |
| `.ca-mic-btn.recording` | Red background, pulse | *(no change — keep existing recording style)* |
| `.ca-send-btn` | Rectangular, `padding: 0 12px` | `width: 32px; height: 32px; border-radius: 50%; padding: 0;` |
| `.ca-send-btn:disabled` | `opacity: 0.4` | *(no change)* |
| `.ca-icon svg` | *(new)* | `width: 16px; height: 16px;` |

Border-radius uses `8px` for input-area elements to match the existing input control convention (`.ca-mic-btn` and `.ca-send-btn` both use `8px`). Note: message bubbles (`.ca-msg-content`) use `10px` — the plugin has mixed radii, but `8px` is consistent for interactive controls.

## Files Changed

| File | Change |
|------|--------|
| `src/claude.ts` | Add `receivedDeltas` guard flag in CLI streaming handler |
| `src/components/ObsidianIcon.tsx` | **New** — Lucide icon wrapper component |
| `src/components/InputArea.tsx` | Restructure to unified card layout. Own mic/send/toolbar. Replace `children` with `onMicClick`, `micState`, `isSendDisabled` props |
| `src/panel.tsx` | Remove mic/send button JSX. Pass new callback props to InputArea |
| `src/components/AudioControls.tsx` | Replace `\u270E` and `\u2715` with `<ObsidianIcon name="pencil" />` and `<ObsidianIcon name="x" />` |
| `src/components/MessageThread.tsx` | Replace `\u29C9` and `\u2713` in CopyButton with `<ObsidianIcon name="copy" />` and `<ObsidianIcon name="check" />` |
| `styles.css` | New `.ca-input-card`, `.ca-input-toolbar` classes. Update `.ca-input` (remove border), `.ca-mic-btn` (borderless), `.ca-send-btn` (circular 32px). Add `.ca-icon` sizing |

## What Does Not Change

- `@` mention and `/` slash command behavior
- Keyboard shortcuts (Enter to send, Shift+Enter for newline)
- Audio recording flow (icon swap only)
- Streaming for Anthropic API and OpenRouter sources
- Message rendering (MarkdownBlock unchanged)
- Session/history management
- Mode toggle location (stays in header)
- Empty-state diamond icon and audio tag microphone emoji in MessageThread
- "Send" text label in AudioControls

## Risks

- **Low:** `setIcon()` is stable Obsidian API, already used in the plugin for ribbon icon and mic command
- **Low:** CSS changes isolated to input area classes with consistent 8px border-radius convention
- **Very low:** Streaming fix is a simple guard flag scoped to each function invocation with a clear fallback path
