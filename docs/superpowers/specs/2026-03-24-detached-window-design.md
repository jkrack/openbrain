# Detached OpenBrain Window

## Problem

OpenBrain lives in Obsidian's sidebar. The sidebar is constrained — narrow, single-column, competing with the file explorer and other panels. As OpenBrain grows (knowledge graph, skills, task dashboard), the sidebar can't surface everything effectively. Users who spend extended time in OpenBrain want a workspace-level experience without leaving Obsidian.

## Solution

A detachable three-panel window that pops out of the sidebar into its own native Obsidian window via `workspace.openPopoutLeaf()`. Same vault APIs, same chat engine, same tools — but a layout that uses the space like a real app.

## Architecture

The detached view is a new `ItemView` subclass (`DetachedOpenBrainView`) that renders a three-panel React layout instead of the single-column sidebar layout. Obsidian's `workspace.openPopoutLeaf()` handles the native window — no custom Electron BrowserWindow needed.

All business logic is shared:
- Chat engine (`chatEngine.ts`)
- Tool system (`tools.ts`, `toolEngine.ts`)
- Smart context + graph (`smartContext.ts`, `vaultIndex.ts`)
- Audio recording (`useAudioRecorder.ts`)
- Skills, scheduler, knowledgeGraph
- Vault APIs (same `app` object passed through)

### State Sharing: ChatStateManager

Currently, chat state lives in React `useState` hooks inside `panel.tsx` (~25 `useState` calls). Two separate React trees (sidebar and popout) cannot share React state directly.

To enable both views to show the same chat and stay synced, introduce a `ChatStateManager` class on the plugin instance:

```typescript
class ChatStateManager extends EventEmitter {
  messages: Message[] = [];
  isStreaming = false;
  chatFilePath: string | null = null;
  activeSkillId: string | null = null;
  toolActivity: ToolCallEntry[] = [];
  // ... other shared state

  // Mutation methods that emit change events
  addMessage(msg: Message): void { ... this.emit("change"); }
  setStreaming(v: boolean): void { ... this.emit("change"); }
  loadChat(path: string): Promise<void> { ... }
  sendMessage(text: string): Promise<void> { ... }
}
```

Both views subscribe via `useEffect` + `setState`, re-rendering on change events. This is the mechanism that makes "keep both open" mode work. The `sendMessage` and streaming callbacks route through the manager, not the React component, so either view can initiate a message and both see the updates.

**This is the largest refactoring task** — extracting ~800 lines of state and effects from `panel.tsx` into `ChatStateManager`. The sidebar panel's rendered output stays identical, but its internals change significantly. This must be done carefully in its own phase with the sidebar working identically before and after.

### Popout Window Gotchas

**`document` scoping**: Popout windows have their own `document` object. Any code that calls `document.addEventListener()` directly (e.g., the paste handler in `panel.tsx`) will silently fail in the popout because it registers on the main window's `document`. All global event listeners must use `containerEl.ownerDocument` instead. This applies to paste, keyboard shortcuts, and any other document-level listeners.

**`MarkdownRenderer`**: Works in popout windows — `app` is shared and the renderer writes to DOM elements passed by reference. No issue here.

## Three-Panel Layout

```
┌──────────┬─────────────────────────┬────────────┐
│          │                         │            │
│   Left   │      Center Pane        │   Right    │
│   Nav    │                         │  Context   │
│          │   Chat / Skills /       │   Panel    │
│  Chats   │   Graph / Tasks         │            │
│  list    │                         │  Active    │
│          │   (max-width: 680px     │  Context   │
│  ------  │    centered content)    │  --------  │
│  Skills  │                         │  Graph     │
│  Graph   │                         │  --------  │
│  Tasks   │                         │  Tools     │
│  Settings│   [Message input]       │            │
└──────────┴─────────────────────────┴────────────┘
  ~220px          flexible              ~250px
```

### Left Panel — Navigation

Always visible. Two zones:

**Chat list** (top, scrollable):
- "New Chat" button
- Chats grouped by date (Today, Yesterday, Earlier)
- Active chat highlighted
- Click to switch chats (loads in center pane)

**Bottom nav** (pinned):
- Skills — opens skills browser in center pane (new UI, built from scratch)
- Graph — opens graph stats dashboard in center pane (new UI, built from scratch)
- Tasks — opens task list in center pane (adapts existing `TaskTray` component to full-pane layout)
- Settings — opens modal overlay (does not displace center pane)

### Center Pane — Workspace

The primary content area. Shows one of:

**Chat view** (default): Same message thread, input area, audio controls as the sidebar panel. Content max-width ~680px, centered. Header shows chat title, permission toggles, and "Attach" button.

**Skills browser** (new UI): List of available skills with descriptions, trigger info, and "Run" button. Clicking a skill starts a new chat with that skill active. Simple list view — not a complex feature.

**Graph dashboard** (new UI): Renders output of `vault_graph_stats` tool + a search box for `vault_entity_search` + a mini graph walk interface. Reads from VaultIndex methods, no new backend needed.

**Task dashboard**: Adapts the existing React `TaskTray` component to a full-width layout instead of a slide-out tray.

Clicking a chat in the left panel always returns to chat view.

### Right Panel — Context

Three collapsible sections, collapse state persisted in settings:

**Active Context**: Files, people, and projects currently in scope for the conversation. Shows what was injected by smart context and @ mentions.

**Knowledge Graph**: Related notes from `getGraphContext()` traversal — path, hop distance, relationship type. Refreshes when the vault index updates (subscribes to vault index change events via the existing modify/create/delete handlers).

**Tool Activity**: Structured feed of tool calls from `ChatStateManager.toolActivity` — tool name, status (running/complete/error), duration. Currently tool use only appears as inline text in messages; the `ChatStateManager` adds a structured log alongside.

The right panel adapts when the center pane shows non-chat content (e.g., shows task-relevant context when viewing tasks).

## Detach / Attach Interaction

### Detach (sidebar → popout)

**Triggers:**
- ↗ button in the existing sidebar panel header
- Command palette: "OpenBrain: Detach to window"

**Behavior:**
1. **Block if streaming** — if a response is actively streaming, show notice: "Wait for the response to complete before detaching." This avoids the complexity of transferring streaming callbacks mid-flight.
2. Force-save current chat (flush any debounced auto-save timer)
3. `workspace.openPopoutLeaf()` creates a new native window with stored size/position
4. Set view state to `DetachedOpenBrainView` on the new leaf
5. `ChatStateManager` already holds the state — the new view subscribes and renders it
6. Close the sidebar panel
7. Window remembers size and position across sessions (stored in settings via `WorkspaceWindowInitData`)

### Attach (popout → sidebar)

**Trigger:** "Attach" button in the detached window header

**Behavior:**
1. **Block if streaming** — same guard as detach
2. Prompt: "Close this window, or keep both open?"
3. **Close:** Popout window closes. Sidebar reopens. Both read from `ChatStateManager`, so state is already there.
4. **Keep both:** Sidebar opens alongside. Both views subscribe to `ChatStateManager` and stay synced automatically.

### Workspace Restoration (Obsidian restart)

Override `getState()` and `setState()` in `DetachedOpenBrainView`:

- `getState()` returns: `{ chatPath, centerPaneRoute, rightPanelCollapseState }`
- `setState()` restores the above on Obsidian restart

Note: Obsidian may restore a popout leaf as an inline leaf rather than a popout on restart. If the restored leaf is not in a popout window, the detached view should detect this and offer to re-detach, or gracefully render in whatever container it finds itself in.

## Implementation Phases

### Phase 1: ChatStateManager + Detached Shell

Extract chat state from `panel.tsx` into `ChatStateManager` on the plugin instance. Both the existing sidebar and the new detached view consume it. The detached view renders chat-only in the center pane (no skills browser, graph dashboard, or task view yet). Left panel shows chat list. Right panel shows stubs.

**This phase validates:** `openPopoutLeaf()` works, state sync works, detach/attach works, `document` scoping is handled.

### Phase 2: Right Context Panel

Build `ContextPanel` with the three collapsible sections. Wire Active Context to smart context injection data. Wire Knowledge Graph to `getGraphContext()`. Wire Tool Activity to `ChatStateManager.toolActivity`.

### Phase 3: Center Pane Routing

Build skills browser, graph dashboard, and task dashboard views in the center pane. Add left panel navigation routing. Settings modal.

## New Files

| File | Purpose |
|------|---------|
| `src/chatStateManager.ts` | Shared chat state with event emitter. Holds messages, streaming state, tool activity. Both views subscribe. |
| `src/detachedView.ts` | New `ItemView` subclass for the popout window. Registers as `DETACHED_OPEN_BRAIN_VIEW_TYPE`. Mounts `DetachedPanel` React component. Implements `getState()`/`setState()` for workspace restoration. |
| `src/components/DetachedPanel.tsx` | Three-panel layout container. Manages center pane routing (chat/skills/graph/tasks). |
| `src/components/ChatListSidebar.tsx` | Left panel: chat history list + bottom nav. Loads chat list from vault, groups by date. |
| `src/components/ContextPanel.tsx` | Right panel: collapsible Active Context, Knowledge Graph, and Tool Activity sections. |
| `src/components/CenterPane.tsx` | Router component: renders chat view, skills browser, graph dashboard, or task dashboard based on left panel selection. |

## Modified Files

| File | Change |
|------|--------|
| `src/main.ts` | Register `DetachedOpenBrainView`. Add detach/attach commands. Instantiate `ChatStateManager`. Handle state transfer between views. |
| `src/settings.ts` | Add `detachedWindowSize` and `detachedWindowPosition` to settings interface and defaults. Add right panel collapse state. |
| `src/view.ts` | Add detach button (↗) to the existing sidebar header. |
| `src/panel.tsx` | **Significant refactor:** Replace local `useState` chat state with `ChatStateManager` subscription. The rendered output is identical but state is externalized. This is the largest change — must be done carefully with tests verifying the sidebar works identically before and after. |
| `styles.css` | Add three-panel layout styles (`.ob-detached-*` prefix). |

## Components Reused Without Changes

- `ChatHeader` — portable, props-only
- `AudioControls` — portable, props-only
- `PersonPicker` — portable, props-only
- `ImageLightbox` — portable, props-only
- `InputArea` — works via VaultIndex prop, no Obsidian-specific calls
- `MessageThread` — uses `MarkdownRenderer`, works in popout (same `app` context)

## What This Does NOT Include

- No custom Electron BrowserWindow — uses Obsidian's built-in popout API
- No separate process or IPC — same plugin instance, same memory space
- No mobile support — `openPopoutLeaf()` is desktop-only, gated by `Platform.isDesktop`
- No new settings tab — window preferences stored silently
