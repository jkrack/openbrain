# Chat History Persistence — Design Spec

## Problem

OpenBrain conversations are ephemeral — stored only in React state. Closing the panel, clicking clear, or restarting Obsidian means total data loss. Users need persistent chat history they can browse, resume, and reference.

## Solution

Save every conversation as a plain `.md` file in the vault with YAML frontmatter. This leverages Obsidian's native capabilities: search, graph view, backlinks, and Bases for structured browsing. An Obsidian Base provides a table view of all past chats.

## Chat File Format

Each conversation is a markdown file in a configurable folder (default: `OpenBrain/chats/`). Filename format: `YYYY-MM-DD-HHmmss.md` (timestamp of first message).

### Format Version

All chat files include a `format_version` field in frontmatter. This enables future format migrations without breaking existing files.

- **Version 1**: Initial format (this spec).
- `parseChat()` rejects files with `format_version > 1` and returns an error message telling the user to update the plugin.
- Files missing `format_version` are treated as version 1 (backward compat with any manually created files).

### Frontmatter

```yaml
---
type: openbrain-chat
format_version: 1
created: 2026-03-14T14:30:22
updated: 2026-03-14T14:35:10
skill: Voice Capture
session_id: abc123
message_count: 8
has_audio: true
title: Discussion about project timelines
tags:
  - openbrain/chat
---
```

Properties:
- `type`: Always `openbrain-chat`. Used by Bases to query chat notes.
- `format_version`: Integer. Current version: `1`. For future-proofing format changes.
- `created`: ISO timestamp of first message.
- `updated`: ISO timestamp of last message. Updated on every save.
- `skill`: Name of the active skill (or `General` if none). Filterable in Bases.
- `session_id`: Claude Code CLI session ID for resuming multi-turn conversations.
- `message_count`: Total messages. Updated on save.
- `has_audio`: Whether any message was voice input.
- `title`: Auto-generated from first user message (first 60 chars, cleaned). Editable by user.
- `tags`: Default `openbrain/chat`. User can add more.

**Naming convention**: Frontmatter uses `snake_case` (Obsidian convention for YAML properties). The TypeScript `ChatMeta` interface uses `camelCase`. Mapping is explicit in `serializeChat()` and `parseChat()`:

| Frontmatter key | TypeScript property |
|---|---|
| `format_version` | `formatVersion` |
| `session_id` | `sessionId` |
| `message_count` | `messageCount` |
| `has_audio` | `hasAudio` |

All other keys (`type`, `created`, `updated`, `skill`, `title`, `tags`) are identical in both.

### Body Format

Alternating heading blocks with metadata encoded in HTML comments:

```markdown
<!-- msg:a1b2c3:user:1710425422000:false -->
### User
What's on my schedule today?

<!-- msg:d4e5f6:assistant:1710425425000:false -->
### Assistant
Looking at your daily note, you have three meetings scheduled...

<!-- msg:g7h8i9:user:1710425440000:true -->
### User
🎙 Voice message

<!-- msg:j0k1l2:assistant:1710425445000:false -->
### Assistant
**Transcription** (3.6s):
Here's what I captured from your recording...
```

HTML comment format: `<!-- msg:{id}:{role}:{timestamp_ms}:{isAudio} -->`

Fields map directly to `Message` interface properties:
- `id` → `Message.id` (string, e.g. `"a1b2c3"`)
- `role` → `Message.role` (`"user"` | `"assistant"`)
- `timestamp_ms` → `Message.timestamp` (milliseconds since epoch → `new Date(ms)`)
- `isAudio` → `Message.isAudio` (`"true"` | `"false"` → boolean)

This preserves full round-trip fidelity: `Message[] → serialize → parse → Message[]` produces identical objects.

Design choices:
- Invisible when reading the note in Obsidian
- Parseable back into `Message` objects with full fidelity
- `###` headings make the conversation scannable and foldable
- Markdown content renders naturally in Obsidian's preview mode

## Architecture

### New Module: `src/chatHistory.ts`

Single module handling all persistence operations:

```typescript
interface ChatFile {
  path: string;           // Vault path: "OpenBrain/chats/2026-03-14-143022.md"
  frontmatter: ChatMeta;  // Parsed frontmatter
  messages: Message[];    // Parsed message array
}

interface ChatMeta {
  type: "openbrain-chat";
  formatVersion: number;
  created: string;
  updated: string;
  skill: string;
  sessionId: string;
  messageCount: number;
  hasAudio: boolean;
  title: string;
  tags: string[];
}
```

Core functions:

- `serializeChat(messages, meta): string` — Convert messages + metadata to markdown string. Maps `ChatMeta` camelCase to frontmatter snake_case. Serializes each message as an HTML comment + heading + content block.
- `parseChat(content): ChatFile | { error: string }` — Parse a markdown chat file back into messages + metadata. Returns an error object if `format_version > 1` or the file is malformed (missing frontmatter, invalid comment format). Logs a warning for messages with unparseable comments and skips them rather than failing the entire file.
- `saveChat(app, path, messages, meta): Promise<string>` — Write/update a chat file in the vault. Returns the vault path. Creates the chats folder if missing. Catches vault write errors and shows a Notice on failure.
- `loadChat(app, path): Promise<ChatFile | null>` — Read and parse a chat file from the vault. Returns `null` if file doesn't exist or parsing fails.
- `generateChatTitle(messages): string` — Extract title from first user message (first 60 chars, strip markdown formatting and special chars). If the first user message is a voice marker (`🎙`), falls back to "Voice chat — " + timestamp.
- `generateChatFilename(): string` — Generate `YYYY-MM-DD-HHmmss-xxx.md` filename using `moment().format()` plus a 3-char random suffix to avoid collisions when multiple chats start within the same second.
- `listRecentChats(app, folder, limit): Promise<ChatMeta[]>` — List recent chats by reading frontmatter only (via Obsidian's `metadataCache`). Sorted by `updated` descending. Used for context injection.
- `initChatFolder(app, folder): Promise<void>` — Create the chats folder and Base file if they don't exist. Called once on plugin load.

### Panel Integration (`src/panel.tsx`)

New state:
```typescript
const [chatFilePath, setChatFilePath] = useState<string | null>(null);
```

New props from view:
```typescript
interface PanelProps {
  // ... existing props ...
  onChatPathChange?: (path: string | null) => void;  // Notify view when chat path changes
  initialChatPath?: string;                           // Load an existing chat on mount
}
```

**`onChatPathChange` callback**: Called whenever the active chat file changes — on first save (path goes from `null` to a path), on clear (path goes to `null`), or on load (path set from `initialChatPath`). The view (`OpenBrainView`) receives this and stores it as `currentChatPath` for restore-on-reopen. It also persists it to `settings.lastChatPath` via `plugin.saveSettings()`.

**Auto-save behavior** — debounced save (500ms) triggered on:
- New user message added
- Assistant message streaming completes (not during streaming — save after `onDone` fires)
- Skill change while messages exist

Implementation: a `useEffect` watching `[messages, isStreaming]`. When `messages.length > 0` and `isStreaming === false`, schedule a debounced save. The debounce timer is stored in a ref and cleared on unmount.

- First save creates the file and calls `onChatPathChange(path)`; subsequent saves update it
- `chatFilePath` tracks whether this is a new or existing chat

**Clear button (↺) behavior change**:
```typescript
async function clearConversation() {
  // Cancel any pending debounced save FIRST to prevent it firing after reset
  if (debouncedSaveRef.current) {
    clearTimeout(debouncedSaveRef.current);
    debouncedSaveRef.current = null;
  }
  if (messages.length > 0 && chatFilePath) {
    await saveChat(app, chatFilePath, messages, buildMeta());
  }
  // Only clear state after save completes
  setMessages([]);
  setChatFilePath(null);
  setSessionId(undefined);
  onChatPathChange?.(null);
}
```
The debounce cancel prevents a stale save from firing between the explicit save and state reset. The `await` ensures save completes before state resets.

**Save button (💾) in header**:
- Forces immediate save regardless of debounce (cancels pending debounce, calls `saveChat` directly)
- Visual feedback: button text changes to ✓ for 1.5 seconds via a `showSaveConfirm` state

**Load on mount**: If `initialChatPath` is provided, `useEffect` on mount calls `loadChat()` and populates `messages`, `chatFilePath`, `sessionId`, and `activeSkillId` from the loaded data.

### View Integration (`src/view.ts`)

The `OpenBrainView` class already creates the React panel via `createRoot()`. Communication between view and panel:

- **View → Panel**: Props. `initialChatPath` is passed when rendering. To load a different chat after mount, the view updates a `loadChatRequest` ref containing `{ path, nonce }` and re-renders. The nonce (a counter) ensures React detects the change even when loading the same path twice (e.g., after an external edit).
- **Panel → View**: Callback prop `onChatPathChange`. The view stores `currentChatPath` and persists it.

New props:
```typescript
interface LoadChatRequest {
  path: string;
  nonce: number;  // Incremented each call to force useEffect re-run
}
```

New methods on `OpenBrainView`:
- `loadChatFromPath(path: string)` — Increments a nonce counter, re-renders the panel with `loadChatRequest={{ path, nonce }}`. Called from the "Resume chat in OpenBrain" command.

### Main Plugin (`src/main.ts`)

New settings:
- `chatFolder: string` (default: `"OpenBrain/chats"`)
- `lastChatPath: string` (default: `""`)

New commands:
```typescript
this.addCommand({
  id: "open-chat-history",
  name: "Open chat history",
  callback: () => {
    const basePath = `${settings.chatFolder}/Chat History.base`;
    app.workspace.openLinkText(basePath, "");
  },
});

this.addCommand({
  id: "resume-chat-in-openbrain",
  name: "Resume chat in OpenBrain",
  checkCallback: (checking) => {
    const file = app.workspace.getActiveFile();
    if (!file) return false;
    const meta = app.metadataCache.getFileCache(file)?.frontmatter;
    if (meta?.type !== "openbrain-chat") return false;
    if (checking) return true;
    // Load into panel
    const view = app.workspace.getLeavesOfType("open-brain-view")[0]?.view;
    if (view instanceof OpenBrainView) {
      view.loadChatFromPath(file.path);
    }
  },
});
```

**Restore on view open**: `onOpen()` checks `settings.lastChatPath`. If set and the file exists in the vault, passes it as `initialChatPath` to the panel. Otherwise starts fresh.

**Plugin load**: Calls `initChatFolder(app, settings.chatFolder)` to ensure the chats folder and Base file exist.

### Chat Loading from Vault

When user opens a chat `.md` file from the Base (or any link), they see it rendered as a normal Obsidian markdown note (headings, paragraphs, hidden HTML comments). To resume in the panel, they use the command palette: **"Resume chat in OpenBrain"**.

This command:
1. Checks the active note has `type: openbrain-chat` in frontmatter (via `metadataCache`)
2. Gets the view instance via `workspace.getLeavesOfType()`
3. Calls `view.loadChatFromPath(file.path)`
4. Activates the OpenBrain panel leaf so it's visible

This avoids hijacking Obsidian's default markdown rendering.

### Context Injection

When starting a new chat, recent chat history can be injected as context:

- `listRecentChats()` reads frontmatter from chat files using `metadataCache` (no file I/O for listing)
- For the last 3 chats (by `updated` date), reads the last 4 messages each from the file body
- Appended to the system prompt as: `\n\n--- Recent conversation context ---\n{summary}`
- Controlled by a toggle in settings: `includeRecentChats: boolean` (default: `false`)

This is lightweight — `metadataCache` is in-memory, and only 3 files are read partially.

## Obsidian Base

A `.base` file at `OpenBrain/chats/Chat History.base` provides a table view of all chats. Created by `initChatFolder()` on first run.

### Base File Content

```yaml
filters: 'type == "openbrain-chat"'
properties:
  title:
    displayName: Title
  created:
    displayName: Created
  skill:
    displayName: Skill
  message_count:
    displayName: Messages
  has_audio:
    displayName: Audio
views:
  - type: table
    name: Chat History
    order:
      - title
      - created
      - skill
      - message_count
      - has_audio
```

Notes are auto-sorted by `created` descending (Obsidian's default for date properties). The `title` column links to the chat file. The filter `type == "openbrain-chat"` scopes the Base to only show chat files.

The Base file is created once by `initChatFolder()` and never overwritten — users can customize columns, add filters, or change the view type.

## Settings

New fields in `OpenBrainSettings`:
```typescript
chatFolder: string;          // Default: "OpenBrain/chats"
lastChatPath: string;        // Default: "" — path of last active chat
includeRecentChats: boolean; // Default: false — inject recent chat context
```

New settings UI section "Chat History":
- Text field: Chat folder path
- Toggle: Include recent chats as context
- Button: Open chat history (opens the Base)

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/chatHistory.ts` | **Create** | Serialize/parse/save/load chat files, init folder + Base |
| `src/panel.tsx` | **Modify** | Auto-save with debounce, save button, load from path, clear-saves-first |
| `src/view.ts` | **Modify** | `loadChatFromPath()`, current chat tracking, `onChatPathChange` handler |
| `src/main.ts` | **Modify** | New commands, settings, restore on open, `initChatFolder()` call |
| `src/settings.ts` | **Modify** | Chat history settings section |
| `styles.css` | **Modify** | Save button + confirmation styles |

## Edge Cases

- **Concurrent edits**: If user manually edits a chat `.md` while it's active in the panel, the next auto-save overwrites. This is acceptable — the panel is the source of truth for active chats.
- **Large conversations**: Files grow linearly with message count. A 100-message conversation is ~20KB of markdown — not a concern.
- **Streaming messages**: Don't save during streaming (content is incomplete). The `useEffect` checks `isStreaming === false` before scheduling a save.
- **Empty chats**: Don't create a file for chats with zero messages. Only save on first real message (`messages.length > 0` guard).
- **Skill switch mid-chat**: Update the `skill` field in frontmatter on next save. Don't start a new file — the conversation is continuous.
- **Clear button race condition**: Resolved by `await saveChat()` before state reset. See clearConversation implementation above.
- **Corrupt/malformed files**: `parseChat()` returns `{ error: string }` for unparseable files. `loadChat()` returns `null` and logs a console warning. Panel shows a Notice: "Could not load chat file."
- **Chat folder renamed in settings**: Existing files in the old folder remain (user can move them manually). New chats go to the new folder. `lastChatPath` may point to a file in the old folder — if missing, start fresh.
- **Vault sync conflicts**: Obsidian handles file conflicts at the sync layer. Our auto-save writes via `vault.modify()` which integrates with Obsidian's sync.

## Verification

1. `npm run build` — must succeed
2. Send a message → chat auto-saves to `OpenBrain/chats/YYYY-MM-DD-HHmmss.md`
3. Close and reopen panel → last chat restored with all messages
4. Click clear → current chat saved, fresh panel starts
5. Open Base → see table of all past chats, sorted by date
6. Click a chat in Base → open as markdown note → click "Resume in OpenBrain" → loads in panel
7. Session continuity: resume a chat → Claude Code remembers the conversation (via session_id)
8. Voice messages preserved with `has_audio` flag and 🎙 markers
