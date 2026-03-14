# Chat History Persistence — Design Spec

## Problem

OpenBrain conversations are ephemeral — stored only in React state. Closing the panel, clicking clear, or restarting Obsidian means total data loss. Users need persistent chat history they can browse, resume, and reference.

## Solution

Save every conversation as a plain `.md` file in the vault with YAML frontmatter. This leverages Obsidian's native capabilities: search, graph view, backlinks, and Bases for structured browsing. An Obsidian Base provides a table view of all past chats.

## Chat File Format

Each conversation is a markdown file in a configurable folder (default: `OpenBrain/chats/`). Filename format: `YYYY-MM-DD-HHmmss.md` (timestamp of first message).

### Frontmatter

```yaml
---
type: openbrain-chat
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
- `created`: ISO timestamp of first message.
- `updated`: ISO timestamp of last message. Updated on every save.
- `skill`: Name of the active skill (or `General` if none). Filterable in Bases.
- `session_id`: Claude Code CLI session ID for resuming multi-turn conversations.
- `message_count`: Total messages. Updated on save.
- `has_audio`: Whether any message was voice input.
- `title`: Auto-generated from first user message (first 60 chars, cleaned). Editable by user.
- `tags`: Default `openbrain/chat`. User can add more.

### Body Format

Alternating heading blocks with metadata encoded in HTML comments:

```markdown
<!-- msg:user:1710425422000:false -->
### User
What's on my schedule today?

<!-- msg:assistant:1710425425000:false -->
### Assistant
Looking at your daily note, you have three meetings scheduled...

<!-- msg:user:1710425440000:true -->
### User
Voice message

<!-- msg:assistant:1710425445000:false -->
### Assistant
**Transcription** (3.6s):
Here's what I captured from your recording...
```

HTML comment format: `<!-- msg:{role}:{timestamp_ms}:{isAudio} -->`

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

- `serializeChat(messages, meta): string` — Convert messages + metadata to markdown string.
- `parseChat(content): ChatFile` — Parse a markdown chat file back into messages + metadata.
- `saveChat(app, path, messages, meta): Promise<string>` — Write/update a chat file in the vault. Returns the vault path. Creates the chats folder if missing.
- `loadChat(app, path): Promise<ChatFile>` — Read and parse a chat file from the vault.
- `generateChatTitle(messages): string` — Extract title from first user message.
- `generateChatFilename(): string` — Generate `YYYY-MM-DD-HHmmss.md` filename.
- `listRecentChats(app, folder, limit): Promise<ChatMeta[]>` — List recent chats by reading frontmatter (for context injection).

### Panel Integration (`src/panel.tsx`)

New state:
```typescript
const [chatFilePath, setChatFilePath] = useState<string | null>(null);
```

New props from view:
```typescript
interface PanelProps {
  // ... existing props ...
  onSaveChat?: (path: string) => void;    // Notify view of current chat path
  initialChatPath?: string;                // Load an existing chat on mount
}
```

Auto-save behavior:
- Debounced save (500ms) triggered on:
  - New user message added
  - Assistant message streaming completes (not during streaming)
  - Skill change while messages exist
- First save creates the file; subsequent saves update it
- `chatFilePath` tracks whether this is a new or existing chat

Clear button (↺) behavior change:
- Saves current conversation first (if any messages exist)
- Then resets to fresh state (`chatFilePath = null`, empty messages)
- User never loses data accidentally

Save button (💾) in header:
- Forces immediate save regardless of debounce
- Visual feedback: brief checkmark animation

### View Integration (`src/view.ts`)

New methods:
- `loadChatFromPath(path: string)` — Load a saved chat into the panel
- Store `currentChatPath` for restore-on-reopen

### Main Plugin (`src/main.ts`)

New setting: `chatFolder: string` (default: `"OpenBrain/chats"`)
New setting: `lastChatPath: string` (default: `""`)

New command:
```typescript
this.addCommand({
  id: "open-chat-history",
  name: "Open chat history",
  callback: () => {
    // Open the Base file or the chats folder
    const basePath = `${settings.chatFolder}/Chat History.base`;
    app.workspace.openLinkText(basePath, "");
  },
});
```

Restore behavior on view open:
- If `lastChatPath` is set and the file exists, load that chat
- Otherwise start fresh

### Chat Loading from Vault

When user opens a chat `.md` file from the Base (or any link):
- Detect it has `type: openbrain-chat` in frontmatter
- Option 1: Register a custom view for these files (complex)
- Option 2 (simpler): Add a "Resume in OpenBrain" button/command that loads the chat into the panel

We go with Option 2: a command "Resume chat in OpenBrain" that reads the active note, checks for `type: openbrain-chat`, parses it, and loads it into the panel. This avoids hijacking Obsidian's default markdown rendering.

### Context Injection

When starting a new chat, recent chat history can be injected as context:

- `listRecentChats()` reads frontmatter from the last N chat files (by `updated` date)
- For each, reads the last few messages (configurable, default: last 4 messages per chat, last 3 chats)
- Appended to the system prompt as: `\n\n--- Recent conversation context ---\n{summary}`
- Controlled by a toggle (stored in settings: `includeRecentChats: boolean`, default: false)

This is lightweight — only frontmatter + last few messages are read, not entire conversations.

## Obsidian Base

A `.base` file at `OpenBrain/chats/Chat History.base` that queries all notes with `type: openbrain-chat`:

Columns:
- `title` — Chat title (linked to the note)
- `created` — Date created
- `skill` — Skill used
- `message_count` — Number of messages
- `has_audio` — Audio indicator

Default sort: `created` descending (newest first).

The Base file is created once when the chats folder is first initialized. It's a standard Obsidian Base definition file.

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
| `src/chatHistory.ts` | **Create** | Serialize/parse/save/load chat files |
| `src/panel.tsx` | **Modify** | Auto-save, save button, load from path, debounce |
| `src/view.ts` | **Modify** | `loadChatFromPath()`, current chat tracking |
| `src/main.ts` | **Modify** | New commands, settings, restore on open |
| `src/settings.ts` | **Modify** | Chat history settings section |
| `styles.css` | **Modify** | Save button styles |

## Edge Cases

- **Concurrent edits**: If user manually edits a chat `.md` while it's active in the panel, the next auto-save overwrites. This is acceptable — the panel is the source of truth for active chats.
- **Large conversations**: Files grow linearly with message count. A 100-message conversation is ~20KB of markdown — not a concern.
- **Streaming messages**: Don't save during streaming (content is incomplete). Save after `onDone` fires.
- **Empty chats**: Don't create a file for chats with zero messages. Only save on first real message.
- **Skill switch mid-chat**: Save current chat, start new chat file with new skill context.

## Verification

1. `npm run build` — must succeed
2. Send a message → chat auto-saves to `OpenBrain/chats/YYYY-MM-DD-HHmmss.md`
3. Close and reopen panel → last chat restored with all messages
4. Click clear → current chat saved, fresh panel starts
5. Open Base → see table of all past chats, sorted by date
6. Click a chat in Base → open as markdown note → click "Resume in OpenBrain" → loads in panel
7. Session continuity: resume a chat → Claude Code remembers the conversation (via session_id)
8. Voice messages preserved with `has_audio` flag and 🎙 markers
