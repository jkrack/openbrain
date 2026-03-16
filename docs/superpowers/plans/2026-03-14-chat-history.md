# Chat History Persistence — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every OpenBrain conversation as a `.md` file in the vault with YAML frontmatter, enabling browse/resume/search via Obsidian's native features and Bases.

**Architecture:** New `src/chatHistory.ts` module handles all serialize/parse/save/load logic. `panel.tsx` gains debounced auto-save, a save button, and load-on-mount. `view.ts` gains `loadChatFromPath()` with nonce-based re-render. `main.ts` adds commands, settings, and folder init.

**Tech Stack:** Obsidian API (`vault`, `metadataCache`), React 18, TypeScript, moment.js (bundled with Obsidian)

**Spec:** `docs/superpowers/specs/2026-03-14-chat-history-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/chatHistory.ts` | **Create** | `ChatMeta` interface, `serializeChat()`, `parseChat()`, `saveChat()`, `loadChat()`, `generateChatTitle()`, `generateChatFilename()`, `listRecentChats()`, `initChatFolder()` |
| `src/settings.ts` | **Modify** | Add `chatFolder`, `lastChatPath`, `includeRecentChats` to settings interface + defaults + UI |
| `src/view.ts` | **Modify** | Add `LoadChatRequest` type, `loadChatFromPath()`, `currentChatPath`, persist `lastChatPath` |
| `src/panel.tsx` | **Modify** | Add `chatFilePath` state, debounced auto-save, save button, load-on-mount, clear-saves-first, `onChatPathChange` callback |
| `src/main.ts` | **Modify** | Add `open-chat-history` + `resume-chat-in-openbrain` commands, call `initChatFolder()` on load, restore last chat on view open |
| `styles.css` | **Modify** | Save button + confirmation checkmark styles |

---

## Chunk 1: Core Serialization Module

### Task 1: ChatMeta interface and generateChatTitle

**Files:**
- Create: `src/chatHistory.ts`

- [ ] **Step 1: Create chatHistory.ts with ChatMeta and ChatFile interfaces**

```typescript
// src/chatHistory.ts
import { App, TFile, Notice } from "obsidian";
import { Message } from "./claude";

export interface ChatMeta {
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

export interface ChatFile {
  path: string;
  frontmatter: ChatMeta;
  messages: Message[];
}
```

- [ ] **Step 2: Implement generateChatTitle**

```typescript
export function generateChatTitle(messages: Message[]): string {
  const firstUserMsg = messages.find((m) => m.role === "user");
  if (!firstUserMsg) return "Untitled chat";

  const content = firstUserMsg.content.trim();

  // Voice-only message fallback
  if (content.startsWith("🎙") || content === "") {
    const ts = firstUserMsg.timestamp;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `Voice chat — ${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
  }

  // Strip markdown formatting and special chars, take first 60 chars
  const cleaned = content
    .replace(/[#*_`~\[\]()>!|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

  return cleaned || "Untitled chat";
}
```

- [ ] **Step 3: Implement generateChatFilename**

```typescript
export function generateChatFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  const suffix = Math.random().toString(36).slice(2, 5);
  return `${y}-${mo}-${d}-${h}${mi}${s}-${suffix}.md`;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/chatHistory.ts
git commit -m "feat(chatHistory): add ChatMeta interface, title and filename generators"
```

---

### Task 2: serializeChat

**Files:**
- Modify: `src/chatHistory.ts`

- [ ] **Step 1: Implement serializeChat**

This converts `Message[]` + `ChatMeta` into a markdown string with YAML frontmatter and HTML comment metadata per message.

```typescript
export function serializeChat(messages: Message[], meta: ChatMeta): string {
  // Build YAML frontmatter with snake_case keys
  const fm = [
    "---",
    `type: ${meta.type}`,
    `format_version: ${meta.formatVersion}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `skill: ${meta.skill}`,
    `session_id: ${meta.sessionId}`,
    `message_count: ${meta.messageCount}`,
    `has_audio: ${meta.hasAudio}`,
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    "tags:",
    ...meta.tags.map((t) => `  - ${t}`),
    "---",
    "",
  ].join("\n");

  // Build message body
  const body = messages
    .map((msg) => {
      const ts = msg.timestamp.getTime();
      const audio = msg.isAudio ? "true" : "false";
      const comment = `<!-- msg:${msg.id}:${msg.role}:${ts}:${audio} -->`;
      const heading = msg.role === "user" ? "### User" : "### Assistant";
      return `${comment}\n${heading}\n${msg.content}`;
    })
    .join("\n\n");

  return fm + body + "\n";
}
```

- [ ] **Step 2: Commit**

```bash
git add src/chatHistory.ts
git commit -m "feat(chatHistory): add serializeChat for markdown+frontmatter output"
```

---

### Task 3: parseChat

**Files:**
- Modify: `src/chatHistory.ts`

- [ ] **Step 1: Implement parseChat**

Parses a markdown chat file back into `ChatFile` or returns `{ error: string }`.

```typescript
export function parseChat(
  content: string,
  path: string
): ChatFile | { error: string } {
  // Extract frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return { error: "Missing frontmatter" };

  const fmBlock = fmMatch[1];

  // Simple YAML parser for our known flat structure
  const get = (key: string): string => {
    const m = fmBlock.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };

  const formatVersion = parseInt(get("format_version") || "1", 10);
  if (formatVersion > 1) {
    return {
      error: `Chat format version ${formatVersion} is not supported. Please update the OpenBrain plugin.`,
    };
  }

  // Parse tags
  const tagsMatch = fmBlock.match(/tags:\n((?:\s+-\s+.+\n?)*)/);
  const tags = tagsMatch
    ? tagsMatch[1]
        .split("\n")
        .map((l) => l.replace(/^\s+-\s+/, "").trim())
        .filter(Boolean)
    : ["openbrain/chat"];

  const frontmatter: ChatMeta = {
    type: "openbrain-chat",
    formatVersion,
    created: get("created"),
    updated: get("updated"),
    skill: get("skill") || "General",
    sessionId: get("session_id"),
    messageCount: parseInt(get("message_count") || "0", 10),
    hasAudio: get("has_audio") === "true",
    title: get("title"),
    tags,
  };

  // Parse messages from body (after frontmatter)
  const body = content.slice(fmMatch[0].length);
  const msgRegex =
    /<!-- msg:([^:]+):([^:]+):(\d+):(true|false) -->\n### (?:User|Assistant)\n([\s\S]*?)(?=\n\n<!-- msg:|$)/g;

  const messages: Message[] = [];
  let match;
  while ((match = msgRegex.exec(body)) !== null) {
    messages.push({
      id: match[1],
      role: match[2] as "user" | "assistant",
      timestamp: new Date(parseInt(match[3], 10)),
      isAudio: match[4] === "true",
      content: match[5].trimEnd(),
    });
  }

  return { path, frontmatter, messages };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/chatHistory.ts
git commit -m "feat(chatHistory): add parseChat for reading markdown chat files"
```

---

### Task 4: saveChat and loadChat

**Files:**
- Modify: `src/chatHistory.ts`

- [ ] **Step 1: Implement saveChat**

```typescript
export async function saveChat(
  app: App,
  path: string,
  messages: Message[],
  meta: ChatMeta
): Promise<string> {
  const content = serializeChat(messages, meta);
  try {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await app.vault.modify(existing, content);
    } else {
      // Ensure parent folder exists
      const folder = path.substring(0, path.lastIndexOf("/"));
      if (folder && !app.vault.getAbstractFileByPath(folder)) {
        await app.vault.createFolder(folder);
      }
      await app.vault.create(path, content);
    }
    return path;
  } catch (e) {
    console.error("OpenBrain: failed to save chat", e);
    new Notice("OpenBrain: Failed to save chat file.");
    return path;
  }
}
```

- [ ] **Step 2: Implement loadChat**

```typescript
export async function loadChat(
  app: App,
  path: string
): Promise<ChatFile | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;

  try {
    const content = await app.vault.read(file);
    const result = parseChat(content, path);
    if ("error" in result) {
      console.warn("OpenBrain: failed to parse chat file:", result.error);
      new Notice("Could not load chat file.");
      return null;
    }
    return result;
  } catch (e) {
    console.error("OpenBrain: failed to read chat file", e);
    return null;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/chatHistory.ts
git commit -m "feat(chatHistory): add saveChat and loadChat vault operations"
```

---

### Task 5: listRecentChats and initChatFolder

**Files:**
- Modify: `src/chatHistory.ts`

- [ ] **Step 1: Implement listRecentChats**

Uses `metadataCache` for fast listing without reading file bodies.

```typescript
export function listRecentChats(
  app: App,
  folder: string,
  limit: number = 10
): ChatMeta[] {
  const dir = app.vault.getAbstractFileByPath(folder);
  if (!dir) return [];

  const chatFiles: ChatMeta[] = [];
  const files = app.vault.getMarkdownFiles().filter(
    (f) => f.path.startsWith(folder + "/") && f.path.endsWith(".md")
  );

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (fm?.type !== "openbrain-chat") continue;

    chatFiles.push({
      type: "openbrain-chat",
      formatVersion: fm.format_version ?? 1,
      created: fm.created ?? "",
      updated: fm.updated ?? "",
      skill: fm.skill ?? "General",
      sessionId: fm.session_id ?? "",
      messageCount: fm.message_count ?? 0,
      hasAudio: fm.has_audio ?? false,
      title: fm.title ?? "Untitled",
      tags: fm.tags ?? ["openbrain/chat"],
    });
  }

  // Sort by updated descending
  chatFiles.sort((a, b) => (b.updated > a.updated ? 1 : -1));
  return chatFiles.slice(0, limit);
}
```

- [ ] **Step 2: Implement initChatFolder**

Creates the chats folder and Base file on first run.

```typescript
const BASE_CONTENT = `filters: 'type == "openbrain-chat"'
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
`;

export async function initChatFolder(
  app: App,
  folder: string
): Promise<void> {
  // Create folder if missing
  if (!app.vault.getAbstractFileByPath(folder)) {
    await app.vault.createFolder(folder);
  }

  // Create Base file if missing (never overwrite)
  const basePath = `${folder}/Chat History.base`;
  if (!app.vault.getAbstractFileByPath(basePath)) {
    await app.vault.create(basePath, BASE_CONTENT);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/chatHistory.ts
git commit -m "feat(chatHistory): add listRecentChats and initChatFolder"
```

---

## Chunk 2: Settings & View Integration

### Task 6: Add chat history settings

**Files:**
- Modify: `src/settings.ts:4-34` (interface + defaults)
- Modify: `src/settings.ts:36-294` (settings tab UI)

- [ ] **Step 1: Add new fields to OpenBrainSettings interface**

Add after `audioDeviceId` (line 17):

```typescript
  chatFolder: string;
  lastChatPath: string;
  includeRecentChats: boolean;
```

- [ ] **Step 2: Add defaults to DEFAULT_SETTINGS**

Add after `audioDeviceId: ""` (line 33):

```typescript
  chatFolder: "OpenBrain/chats",
  lastChatPath: "",
  includeRecentChats: false,
```

- [ ] **Step 3: Add Chat History section to settings tab UI**

Add a new section in the `display()` method after the existing sections (before the closing brace). Place it after the Audio Input section:

```typescript
    // ── Chat History ──
    containerEl.createEl("h3", { text: "Chat History" });

    new Setting(containerEl)
      .setName("Chat folder")
      .setDesc("Vault folder where chat files are saved")
      .addText((text) =>
        text
          .setPlaceholder("OpenBrain/chats")
          .setValue(this.plugin.settings.chatFolder)
          .onChange(async (value) => {
            this.plugin.settings.chatFolder = value || "OpenBrain/chats";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include recent chats as context")
      .setDesc("Inject recent chat summaries into new conversations")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeRecentChats)
          .onChange(async (value) => {
            this.plugin.settings.includeRecentChats = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Open chat history")
      .setDesc("View all past chats in an Obsidian Base")
      .addButton((btn) =>
        btn.setButtonText("Open").onClick(() => {
          const basePath = `${this.plugin.settings.chatFolder}/Chat History.base`;
          this.app.workspace.openLinkText(basePath, "");
        })
      );
```

- [ ] **Step 4: Commit**

```bash
git add src/settings.ts
git commit -m "feat(settings): add chat history settings section"
```

---

### Task 7: View integration — loadChatFromPath + chat tracking

**Files:**
- Modify: `src/view.ts`

- [ ] **Step 1: Add LoadChatRequest type and new fields to OpenBrainView**

Add after the `RecordingStatus` interface:

```typescript
export interface LoadChatRequest {
  path: string;
  nonce: number;
}
```

Add new fields to `OpenBrainView` class:

```typescript
  currentChatPath: string | null = null;
  private loadNonce: number = 0;
  private loadChatRequest: LoadChatRequest | undefined;
```

- [ ] **Step 2: Add loadChatFromPath method**

```typescript
  loadChatFromPath(path: string): void {
    this.loadNonce++;
    this.loadChatRequest = { path, nonce: this.loadNonce };
    this.rerender();
  }
```

- [ ] **Step 3: Add onChatPathChange handler**

```typescript
  private handleChatPathChange = (path: string | null): void => {
    this.currentChatPath = path;
    // Persist to settings
    const plugin = (this as any).plugin;
    if (plugin?.settings) {
      plugin.settings.lastChatPath = path ?? "";
      plugin.saveSettings();
    }
  };
```

- [ ] **Step 4: Update rerender() to pass new props**

Update the `rerender()` method to include `loadChatRequest` and `onChatPathChange` in the Panel props. Note: `view.ts` is a `.ts` file (not `.tsx`), so we must use `React.createElement`, matching the existing pattern:

```typescript
  rerender(): void {
    if (!this.root) return;

    this.root.render(
      React.createElement(OpenBrainPanel, {
        settings: this.settings,
        app: this.app,
        initialPrompt: this.initialPrompt,
        component: this,
        skills: this.skills,
        registerToggleRecording: (fn: () => void) => {
          this.toggleRecordingFn = fn;
        },
        onStatusChange: (status: RecordingStatus) => {
          this.onStatusChange?.(status);
        },
        loadChatRequest: this.loadChatRequest,
        onChatPathChange: this.handleChatPathChange,
      })
    );
  }
```

- [ ] **Step 5: Update onOpen() to restore last chat**

In `onOpen()`, after `createRoot()`, check for `lastChatPath`:

```typescript
  async onOpen(): Promise<void> {
    this.root = createRoot(this.containerEl.children[1]);
    // Restore last chat if exists
    const plugin = (this as any).plugin;
    if (plugin?.settings?.lastChatPath) {
      const file = this.app.vault.getAbstractFileByPath(plugin.settings.lastChatPath);
      if (file) {
        this.loadChatRequest = { path: plugin.settings.lastChatPath, nonce: ++this.loadNonce };
      }
    }
    this.rerender();
  }
```

- [ ] **Step 6: Store plugin reference**

The view needs access to the plugin for settings persistence. Add to constructor or store a reference:

```typescript
  plugin: any;  // Set by main.ts when creating the view
```

Update the view registration in main.ts to pass the plugin reference (handled in Task 9).

- [ ] **Step 7: Commit**

```bash
git add src/view.ts
git commit -m "feat(view): add loadChatFromPath, chat tracking, and lastChatPath restore"
```

---

## Chunk 3: Panel Integration

### Task 8: Panel — auto-save, save button, load, clear

**Files:**
- Modify: `src/panel.tsx`
- Modify: `styles.css`

This is the largest task. The panel needs:
1. New props: `loadChatRequest`, `onChatPathChange`
2. New state: `chatFilePath`
3. Debounced auto-save effect
4. Save button in header
5. Load-on-mount from `loadChatRequest`
6. Updated `clearConversation` to save-first + cancel debounce

- [ ] **Step 1: Update PanelProps interface**

Add to `PanelProps` in `src/panel.tsx`:

```typescript
  loadChatRequest?: { path: string; nonce: number };
  onChatPathChange?: (path: string | null) => void;
```

- [ ] **Step 2: Add chatFilePath state and debounce ref**

Inside the `OpenBrainPanel` component, add:

```typescript
const [chatFilePath, setChatFilePath] = useState<string | null>(null);
const [showSaveConfirm, setShowSaveConfirm] = useState(false);
const debouncedSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

- [ ] **Step 3: Add buildMeta helper**

```typescript
function buildMeta(): ChatMeta {
  const now = new Date().toISOString();
  const firstMsg = messages[0];
  return {
    type: "openbrain-chat",
    formatVersion: 1,
    created: firstMsg ? firstMsg.timestamp.toISOString() : now,
    updated: now,
    skill: activeSkillId
      ? skills.find((s) => s.id === activeSkillId)?.name ?? "General"
      : "General",
    sessionId: sessionId ?? "",
    messageCount: messages.length,
    hasAudio: messages.some((m) => m.isAudio),
    title: generateChatTitle(messages),
    tags: ["openbrain/chat"],
  };
}
```

- [ ] **Step 4: Add debounced auto-save effect**

```typescript
useEffect(() => {
  if (messages.length === 0 || isStreaming) return;

  if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);

  debouncedSaveRef.current = setTimeout(async () => {
    const meta = buildMeta();
    const folder = settings.chatFolder || "OpenBrain/chats";
    const path = chatFilePath ?? `${folder}/${generateChatFilename()}`;
    await saveChat(app, path, messages, meta);
    if (!chatFilePath) {
      setChatFilePath(path);
      onChatPathChange?.(path);
    }
  }, 500);

  return () => {
    if (debouncedSaveRef.current) clearTimeout(debouncedSaveRef.current);
  };
}, [messages, isStreaming]);
```

- [ ] **Step 5: Add load-on-mount effect for loadChatRequest**

```typescript
useEffect(() => {
  if (!loadChatRequest) return;

  (async () => {
    const chatFile = await loadChat(app, loadChatRequest.path);
    if (chatFile) {
      setMessages(chatFile.messages);
      setChatFilePath(chatFile.path);
      setSessionId(chatFile.frontmatter.sessionId || undefined);
      // Find matching skill
      const matchSkill = skills.find(
        (s) => s.name === chatFile.frontmatter.skill
      );
      setActiveSkillId(matchSkill?.id ?? null);
      onChatPathChange?.(chatFile.path);
    }
  })();
}, [loadChatRequest?.nonce]);
```

- [ ] **Step 6: Update clearConversation**

Replace the existing `clearConversation` function:

```typescript
async function clearConversation() {
  // Cancel pending debounced save
  if (debouncedSaveRef.current) {
    clearTimeout(debouncedSaveRef.current);
    debouncedSaveRef.current = null;
  }
  // Save before clearing if there's content
  if (messages.length > 0 && chatFilePath) {
    await saveChat(app, chatFilePath, messages, buildMeta());
  }
  setMessages([]);
  setChatFilePath(null);
  setSessionId(undefined);
  abortRef.current = true;
  if (procRef.current) {
    procRef.current.kill();
    procRef.current = null;
  }
  setIsStreaming(false);
  onChatPathChange?.(null);
}
```

- [ ] **Step 7: Add manual save handler**

```typescript
async function handleManualSave() {
  if (messages.length === 0) return;
  // Cancel pending debounce
  if (debouncedSaveRef.current) {
    clearTimeout(debouncedSaveRef.current);
    debouncedSaveRef.current = null;
  }
  const meta = buildMeta();
  const folder = settings.chatFolder || "OpenBrain/chats";
  const path = chatFilePath ?? `${folder}/${generateChatFilename()}`;
  await saveChat(app, path, messages, meta);
  if (!chatFilePath) {
    setChatFilePath(path);
    onChatPathChange?.(path);
  }
  setShowSaveConfirm(true);
  setTimeout(() => setShowSaveConfirm(false), 1500);
}
```

- [ ] **Step 8: Add save button to header JSX**

Add after the clear button in the header:

```tsx
<button
  className="ca-icon-btn ca-save-btn"
  onClick={handleManualSave}
  title="Save chat"
  disabled={messages.length === 0}
>
  {showSaveConfirm ? "✓" : "💾"}
</button>
```

- [ ] **Step 9: Add imports at top of panel.tsx**

```typescript
import {
  ChatMeta,
  saveChat,
  loadChat,
  generateChatTitle,
  generateChatFilename,
} from "./chatHistory";
```

- [ ] **Step 10: Add save button styles to styles.css**

```css
/* Save button */
.ca-save-btn {
  font-size: 14px;
  transition: opacity 0.2s;
}
.ca-save-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.ca-save-btn.ca-save-confirm {
  color: var(--text-success);
}
```

- [ ] **Step 11: Commit**

```bash
git add src/panel.tsx styles.css
git commit -m "feat(panel): add auto-save, save button, load chat, clear-saves-first"
```

---

## Chunk 4: Main Plugin Integration

### Task 9: Commands, init, and restore

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add import**

```typescript
import { initChatFolder } from "./chatHistory";
```

- [ ] **Step 2: Call initChatFolder on plugin load**

In `onload()`, after loading settings and skills:

```typescript
// Initialize chat folder and Base
initChatFolder(this.app, this.settings.chatFolder);
```

- [ ] **Step 3: Pass plugin reference to view**

Update the view registration to pass the plugin:

```typescript
this.registerView("open-brain-view", (leaf) => {
  const view = new OpenBrainView(leaf, this.settings, this.skills);
  view.plugin = this;
  return view;
});
```

- [ ] **Step 4: Add "Open chat history" command**

```typescript
this.addCommand({
  id: "open-chat-history",
  name: "Open chat history",
  callback: () => {
    const basePath = `${this.settings.chatFolder}/Chat History.base`;
    this.app.workspace.openLinkText(basePath, "");
  },
});
```

- [ ] **Step 5: Add "Resume chat in OpenBrain" command**

```typescript
this.addCommand({
  id: "resume-chat-in-openbrain",
  name: "Resume chat in OpenBrain",
  checkCallback: (checking) => {
    const file = this.app.workspace.getActiveFile();
    if (!file) return false;
    const meta = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (meta?.type !== "openbrain-chat") return false;
    if (checking) return true;
    const leaves = this.app.workspace.getLeavesOfType("open-brain-view");
    if (leaves.length > 0) {
      const view = leaves[0].view;
      if (view instanceof OpenBrainView) {
        view.loadChatFromPath(file.path);
        this.app.workspace.revealLeaf(leaves[0]);
      }
    } else {
      // Open view first, then load
      this.activateView().then(() => {
        const newLeaves = this.app.workspace.getLeavesOfType("open-brain-view");
        if (newLeaves.length > 0) {
          const view = newLeaves[0].view;
          if (view instanceof OpenBrainView) {
            view.loadChatFromPath(file.path);
          }
        }
      });
    }
  },
});
```

- [ ] **Step 6: Add OpenBrainView import if not already present**

```typescript
import { OpenBrainView } from "./view";
```

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): add chat history commands, folder init, and view plugin ref"
```

---

### Task 10: Context injection for new chats

**Files:**
- Modify: `src/panel.tsx`

When `includeRecentChats` is enabled, inject recent chat summaries into the system prompt for new conversations.

- [ ] **Step 1: Add import for listRecentChats and loadChat**

Already imported `loadChat` in Task 8. Add `listRecentChats`:

```typescript
import {
  ChatMeta,
  saveChat,
  loadChat,
  generateChatTitle,
  generateChatFilename,
  listRecentChats,
} from "./chatHistory";
```

- [ ] **Step 2: Add context injection helper**

Add this function inside the `OpenBrainPanel` component:

```typescript
async function getRecentChatContext(): Promise<string> {
  if (!settings.includeRecentChats) return "";

  const folder = settings.chatFolder || "OpenBrain/chats";
  const recentMetas = listRecentChats(app, folder, 3);
  if (recentMetas.length === 0) return "";

  const summaries: string[] = [];
  for (const meta of recentMetas) {
    const filePath = `${folder}/${meta.created.replace(/[-:T]/g, "").slice(0, 14)}`; // approximation
    // Find the actual file by iterating vault files
    const files = app.vault.getMarkdownFiles().filter(
      (f) => f.path.startsWith(folder + "/")
    );
    for (const file of files) {
      const cache = app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.session_id === meta.sessionId) {
        const chatFile = await loadChat(app, file.path);
        if (chatFile) {
          const lastMsgs = chatFile.messages.slice(-4);
          const preview = lastMsgs
            .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
            .join("\n");
          summaries.push(
            `**${meta.title}** (${meta.skill}, ${meta.updated}):\n${preview}`
          );
        }
        break;
      }
    }
  }

  if (summaries.length === 0) return "";
  return "\n\n--- Recent conversation context ---\n" + summaries.join("\n\n");
}
```

- [ ] **Step 3: Inject context in sendMessage**

In the `sendMessage` function, when building the system prompt context for a new chat (first message, `chatFilePath === null`), append the recent chat context:

```typescript
// Inside sendMessage, before the streamClaudeCode call:
let recentContext = "";
if (!chatFilePath && messages.length === 0) {
  recentContext = await getRecentChatContext();
}
// Append recentContext to the context string passed to streamClaudeCode
```

The exact integration point depends on how context is currently assembled in `sendMessage`. The context injection appends to the existing `noteContext` or system prompt.

- [ ] **Step 4: Commit**

```bash
git add src/panel.tsx
git commit -m "feat(panel): inject recent chat context into new conversations"
```

---

### Task 11: Build and verify

- [ ] **Step 1: Run the build**

```bash
npm run build
```

Expected: Clean build with no TypeScript errors.

- [ ] **Step 2: Fix any type errors**

Address any compilation errors from the integration points between modules.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "fix: resolve build errors in chat history integration"
```
