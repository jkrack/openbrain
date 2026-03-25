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

The existing sidebar view (`OpenBrainView`) stays unchanged. Both views can coexist.

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
- Skills — opens skills browser in center pane
- Graph — opens graph stats dashboard in center pane
- Tasks — opens task dashboard in center pane
- Settings — opens modal overlay (does not displace center pane)

### Center Pane — Workspace

The primary content area. Shows one of:

**Chat view** (default): Same message thread, input area, audio controls as the sidebar panel. Content max-width ~680px, centered. Header shows chat title, permission toggles, and "Attach" button.

**Skills browser**: List of available skills with descriptions, trigger info, and "Run" button. Clicking a skill starts a new chat with that skill active.

**Graph dashboard**: Graph stats (entity counts, most connected, orphans) and a mini graph walk interface.

**Task dashboard**: The existing `TaskDashboardView` content rendered inline.

Clicking a chat in the left panel always returns to chat view.

### Right Panel — Context

Three collapsible sections, collapse state persisted across sessions:

**Active Context**: Files, people, and projects currently in scope for the conversation. Shows what was injected by smart context and @ mentions.

**Knowledge Graph**: Related notes from `getGraphContext()` traversal — path, hop distance, relationship type. Updated live as the conversation progresses.

**Tool Activity**: Real-time feed of tool calls — tool name, status (running/complete/error), duration. Gives visibility into what OpenBrain is doing.

The right panel adapts when the center pane shows non-chat content (e.g., shows task-relevant context when viewing tasks).

## Detach / Attach Interaction

### Detach (sidebar → popout)

**Triggers:**
- ↗ button in the existing sidebar panel header
- Command palette: "OpenBrain: Detach to window"

**Behavior:**
1. `workspace.openPopoutLeaf()` creates a new native window
2. Set view state to `DetachedOpenBrainView` on the new leaf
3. Transfer current chat state (chat path, scroll position, active skill)
4. Close the sidebar panel
5. Window remembers size and position across sessions (stored in settings)

### Attach (popout → sidebar)

**Trigger:** "Attach" button in the detached window header

**Behavior:**
1. Prompt: "Close this window, or keep both open?"
2. **Close:** Popout window closes. Sidebar reopens with the same chat state.
3. **Keep both:** Sidebar opens alongside. Both views show the same chat and stay synced — messages sent in either appear in both.

### Sync (when both are open)

Both views share the same underlying chat state via the plugin instance. Messages, tool calls, and recording state are reflected in both. The plugin already manages state centrally — both views read from the same source.

## New Files

| File | Purpose |
|------|---------|
| `src/detachedView.ts` | New `ItemView` subclass for the popout window. Registers as `DETACHED_OPEN_BRAIN_VIEW_TYPE`. Mounts `DetachedPanel` React component. |
| `src/components/DetachedPanel.tsx` | Three-panel layout container. Manages center pane routing (chat/skills/graph/tasks). |
| `src/components/ChatListSidebar.tsx` | Left panel: chat history list + bottom nav. Loads chat list from vault, groups by date. |
| `src/components/ContextPanel.tsx` | Right panel: collapsible Active Context, Knowledge Graph, and Tool Activity sections. |
| `src/components/CenterPane.tsx` | Router component: renders chat view, skills browser, graph dashboard, or task dashboard based on left panel selection. |

## Modified Files

| File | Change |
|------|--------|
| `src/main.ts` | Register `DetachedOpenBrainView`. Add detach/attach commands. Handle state transfer between views. Store window size/position in settings. |
| `src/settings.ts` | Add `detachedWindowSize` and `detachedWindowPosition` to settings interface and defaults. |
| `src/view.ts` | Add detach button (↗) to the existing sidebar header. |
| `src/panel.tsx` | Extract shared chat state logic into a hook (`useChatState`) that both sidebar and detached panels can consume. |
| `styles.css` | Add three-panel layout styles (`.ob-detached-*` prefix). |

## Components Reused Without Changes

- `ChatHeader` — portable, props-only
- `AudioControls` — portable, props-only
- `PersonPicker` — portable, props-only
- `ImageLightbox` — portable, props-only
- `InputArea` — works via VaultIndex prop, no Obsidian-specific calls
- `MessageThread` — uses `MarkdownRenderer` but that's available in the popout (same Obsidian context)

## What This Does NOT Include

- No custom Electron BrowserWindow — uses Obsidian's built-in popout API
- No separate process or IPC — same plugin instance, same memory space
- No mobile support — `openPopoutLeaf()` is desktop-only, gated by `Platform.isDesktop`
- No new settings tab — window preferences stored silently
- No refactoring of existing sidebar — it stays exactly as-is
