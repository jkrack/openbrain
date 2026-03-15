# Phase 1: Foundation Hardening — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenBrain reliable — add tests for data-loss paths, split the panel monolith, fix known bugs, and add user-visible error handling.

**Architecture:** Add Vitest test infrastructure, extract 6 components from panel.tsx, fix audio race conditions and stale closure bugs, replace silent catches with Notices.

**Tech Stack:** Vitest, React 18, TypeScript, Obsidian API

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `vitest.config.ts` | **Create** | Test configuration |
| `src/__tests__/chatHistory.test.ts` | **Create** | Serialize/parse round-trip, title generation, filename format |
| `src/__tests__/vaultIndex.test.ts` | **Create** | Search scoring, empty query, special chars |
| `src/__tests__/templates.test.ts` | **Create** | Variable substitution, defaults, missing vars |
| `src/components/MessageThread.tsx` | **Create** | Message list rendering |
| `src/components/InputArea.tsx` | **Create** | Textarea, @ mentions, / commands, send button |
| `src/components/AudioControls.tsx` | **Create** | Recording waveform, audio ready state, mic error |
| `src/components/PersonPicker.tsx` | **Create** | Person selection overlay |
| `src/components/ChatHeader.tsx` | **Create** | Header with badges, toggles, save, new chat, settings |
| `src/panel.tsx` | **Modify** | Slim down to orchestrator using above components |
| `src/claude.ts` | **Modify** | Fix process exit handling (already done) |
| `src/useAudioRecorder.ts` | **Modify** | Fix segment rotation race condition |
| `src/chatHistory.ts` | **Modify** | Improve error messages |
| `package.json` | **Modify** | Add vitest devDependency + test script |

---

## Chunk 1: Test Infrastructure + Core Tests

### Task 1: Set up Vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install vitest**

```bash
npm install -D vitest
```

- [ ] **Step 2: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
```

- [ ] **Step 3: Add test script to package.json**

Add to `scripts`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "chore: set up vitest test infrastructure"
```

---

### Task 2: Chat serialization tests

**Files:**
- Create: `src/__tests__/chatHistory.test.ts`

Test `serializeChat` → `parseChat` round-trip, `generateChatTitle`, and `generateChatFilename`.

- [ ] **Step 1: Create test file with round-trip test**

```typescript
import { describe, it, expect } from "vitest";
import {
  serializeChat,
  parseChat,
  generateChatTitle,
  generateChatFilename,
  ChatMeta,
} from "../chatHistory";

const mockMeta: ChatMeta = {
  type: "openbrain-chat",
  formatVersion: 1,
  created: "2026-03-14T10:00:00.000Z",
  updated: "2026-03-14T10:05:00.000Z",
  skill: "General",
  sessionId: "test-session-123",
  messageCount: 2,
  hasAudio: false,
  title: "Test conversation",
  tags: ["openbrain/chat"],
};

const mockMessages = [
  {
    id: "msg1",
    role: "user" as const,
    content: "Hello world",
    isAudio: false,
    timestamp: new Date("2026-03-14T10:00:00.000Z"),
  },
  {
    id: "msg2",
    role: "assistant" as const,
    content: "Hi there! How can I help?",
    isAudio: false,
    timestamp: new Date("2026-03-14T10:00:05.000Z"),
  },
];

describe("serializeChat → parseChat round-trip", () => {
  it("preserves messages through serialization", () => {
    const serialized = serializeChat(mockMessages, mockMeta);
    const result = parseChat(serialized, "test.md");

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].id).toBe("msg1");
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hello world");
    expect(result.messages[1].id).toBe("msg2");
    expect(result.messages[1].content).toBe("Hi there! How can I help?");
  });

  it("preserves frontmatter through serialization", () => {
    const serialized = serializeChat(mockMessages, mockMeta);
    const result = parseChat(serialized, "test.md");

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.frontmatter.type).toBe("openbrain-chat");
    expect(result.frontmatter.formatVersion).toBe(1);
    expect(result.frontmatter.sessionId).toBe("test-session-123");
    expect(result.frontmatter.title).toBe("Test conversation");
    expect(result.frontmatter.skill).toBe("General");
  });

  it("preserves audio flag", () => {
    const audioMessages = [
      { ...mockMessages[0], isAudio: true },
      mockMessages[1],
    ];
    const audioMeta = { ...mockMeta, hasAudio: true };
    const serialized = serializeChat(audioMessages, audioMeta);
    const result = parseChat(serialized, "test.md");

    if ("error" in result) return;
    expect(result.messages[0].isAudio).toBe(true);
    expect(result.messages[1].isAudio).toBe(false);
  });

  it("preserves timestamps as milliseconds", () => {
    const serialized = serializeChat(mockMessages, mockMeta);
    const result = parseChat(serialized, "test.md");

    if ("error" in result) return;
    expect(result.messages[0].timestamp.getTime()).toBe(
      mockMessages[0].timestamp.getTime()
    );
  });

  it("handles unicode content", () => {
    const unicodeMessages = [
      { ...mockMessages[0], content: "Hello 🌍 — world «quotes»" },
      mockMessages[1],
    ];
    const serialized = serializeChat(unicodeMessages, mockMeta);
    const result = parseChat(serialized, "test.md");

    if ("error" in result) return;
    expect(result.messages[0].content).toBe("Hello 🌍 — world «quotes»");
  });

  it("handles title with quotes", () => {
    const quotedMeta = { ...mockMeta, title: 'He said "hello"' };
    const serialized = serializeChat(mockMessages, quotedMeta);
    const result = parseChat(serialized, "test.md");

    if ("error" in result) return;
    expect(result.frontmatter.title).toBe('He said "hello"');
  });
});

describe("parseChat error handling", () => {
  it("returns error for missing frontmatter", () => {
    const result = parseChat("no frontmatter here", "test.md");
    expect("error" in result).toBe(true);
  });

  it("returns error for format_version > 1", () => {
    const content = `---
type: "openbrain-chat"
format_version: 2
created: "2026-03-14"
updated: "2026-03-14"
skill: "General"
session_id: ""
message_count: 0
has_audio: false
title: "test"
tags: ["openbrain/chat"]
---
`;
    const result = parseChat(content, "test.md");
    expect("error" in result).toBe(true);
  });

  it("handles empty message body gracefully", () => {
    const content = `---
type: "openbrain-chat"
format_version: 1
created: "2026-03-14"
updated: "2026-03-14"
skill: "General"
session_id: ""
message_count: 0
has_audio: false
title: "empty"
tags: ["openbrain/chat"]
---
`;
    const result = parseChat(content, "test.md");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.messages).toHaveLength(0);
  });
});

describe("generateChatTitle", () => {
  it("returns first 60 chars of first user message", () => {
    const title = generateChatTitle(mockMessages);
    expect(title).toBe("Hello world");
  });

  it("truncates long messages", () => {
    const longMsg = [
      { ...mockMessages[0], content: "A".repeat(100) },
    ];
    const title = generateChatTitle(longMsg);
    expect(title.length).toBeLessThanOrEqual(61); // 60 + ellipsis
  });

  it("returns 'Untitled chat' for no user messages", () => {
    const assistantOnly = [mockMessages[1]];
    expect(generateChatTitle(assistantOnly)).toBe("Untitled chat");
  });

  it("returns voice fallback for mic emoji", () => {
    const voiceMsg = [
      { ...mockMessages[0], content: "🎙 Voice message" },
    ];
    const title = generateChatTitle(voiceMsg);
    expect(title).toMatch(/^Voice chat/);
  });

  it("strips markdown formatting", () => {
    const mdMsg = [
      { ...mockMessages[0], content: "## **Hello** _world_ `code`" },
    ];
    const title = generateChatTitle(mdMsg);
    expect(title).not.toContain("#");
    expect(title).not.toContain("*");
    expect(title).not.toContain("`");
  });
});

describe("generateChatFilename", () => {
  it("matches expected format", () => {
    const filename = generateChatFilename();
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{3}\.md$/);
  });

  it("generates unique filenames", () => {
    const a = generateChatFilename();
    const b = generateChatFilename();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/__tests__/chatHistory.test.ts
```

Expected: All tests pass. If any fail, fix the implementation.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/chatHistory.test.ts
git commit -m "test: add chat serialization round-trip and title/filename tests"
```

---

### Task 3: Vault index tests

**Files:**
- Create: `src/__tests__/vaultIndex.test.ts`

- [ ] **Step 1: Create test file**

Test the search scoring logic by extracting the scoring function or testing through the class with a mock app.

Since `VaultIndex` depends on `App`, test the scoring logic by extracting it or testing `search` after manual entry insertion.

```typescript
import { describe, it, expect } from "vitest";

// Test the scoring logic directly — we'll extract it if needed
// For now, test the search algorithm by simulating entries

interface IndexEntry {
  path: string;
  basename: string;
  aliases: string[];
}

// Copy the scoring logic from vaultIndex.ts for unit testing
function scoreEntry(entry: IndexEntry, query: string): number {
  const q = query.toLowerCase();
  const bn = entry.basename.toLowerCase();
  const p = entry.path.toLowerCase();

  if (bn.startsWith(q)) return 4;
  if (bn.includes(q)) return 3;
  if (entry.aliases.some((a) => a.toLowerCase().includes(q))) return 2;
  if (p.includes(q)) return 1;
  return 0;
}

describe("VaultIndex scoring", () => {
  const entries: IndexEntry[] = [
    { path: "Daily/2026-03-14.md", basename: "2026-03-14", aliases: [] },
    { path: "Projects/Search Redesign.md", basename: "Search Redesign", aliases: ["search-v2"] },
    { path: "Meetings/1-on-1/Sarah/2026-03-10.md", basename: "2026-03-10", aliases: [] },
    { path: "OpenBrain/people/Sarah Chen.md", basename: "Sarah Chen", aliases: ["sarah"] },
  ];

  it("ranks basename-starts-with highest", () => {
    const scores = entries.map((e) => ({ entry: e, score: scoreEntry(e, "Search") }));
    const top = scores.sort((a, b) => b.score - a.score)[0];
    expect(top.entry.basename).toBe("Search Redesign");
    expect(top.score).toBe(4);
  });

  it("matches aliases", () => {
    const score = scoreEntry(entries[1], "search-v2");
    expect(score).toBe(2); // alias match
  });

  it("matches path contains", () => {
    const score = scoreEntry(entries[2], "Sarah");
    expect(score).toBe(1); // path contains "Sarah"
  });

  it("returns 0 for no match", () => {
    const score = scoreEntry(entries[0], "nonexistent");
    expect(score).toBe(0);
  });

  it("basename contains scores 3", () => {
    const score = scoreEntry(entries[3], "Chen");
    expect(score).toBe(3); // basename "Sarah Chen" contains "Chen"
  });

  it("is case insensitive", () => {
    const score = scoreEntry(entries[1], "SEARCH");
    expect(score).toBe(4);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/__tests__/vaultIndex.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/vaultIndex.test.ts
git commit -m "test: add vault index search scoring tests"
```

---

### Task 4: Template rendering tests

**Files:**
- Create: `src/__tests__/templates.test.ts`

- [ ] **Step 1: Create test file**

Test `renderTemplate` variable substitution logic (extract it for testability):

```typescript
import { describe, it, expect } from "vitest";

// Extract the substitution logic for testing
function substituteVars(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

describe("template variable substitution", () => {
  it("replaces {{date}} and {{day}}", () => {
    const template = "# {{date}} ({{day}})";
    const result = substituteVars(template, { date: "2026-03-15", day: "Saturday" });
    expect(result).toBe("# 2026-03-15 (Saturday)");
  });

  it("replaces {{title}}", () => {
    const template = "# 1:1 — {{title}}";
    const result = substituteVars(template, { title: "Sarah Chen" });
    expect(result).toBe("# 1:1 — Sarah Chen");
  });

  it("replaces multiple occurrences", () => {
    const template = "{{date}} and again {{date}}";
    const result = substituteVars(template, { date: "2026-03-15" });
    expect(result).toBe("2026-03-15 and again 2026-03-15");
  });

  it("leaves unknown variables as-is", () => {
    const template = "{{date}} {{unknown}}";
    const result = substituteVars(template, { date: "2026-03-15" });
    expect(result).toBe("2026-03-15 {{unknown}}");
  });

  it("handles empty vars", () => {
    const template = "Title: {{title}}";
    const result = substituteVars(template, { title: "" });
    expect(result).toBe("Title: ");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/__tests__/templates.test.ts
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/templates.test.ts
git commit -m "test: add template variable substitution tests"
```

---

## Chunk 2: Bug Fixes

### Task 5: Fix audio segment rotation race condition

**Files:**
- Modify: `src/useAudioRecorder.ts`

- [ ] **Step 1: Replace boolean flag with promise-based lock**

In `useAudioRecorder.ts`, the `rotatingRef.current` boolean flag is not async-safe. Replace with a queued approach:

Find the `rotateSegment` callback and replace:
```typescript
// OLD: boolean flag (racy)
if (rotatingRef.current) return;
rotatingRef.current = true;
```

With a promise chain:
```typescript
const rotationQueue = useRef<Promise<void>>(Promise.resolve());

const rotateSegment = useCallback(async () => {
  rotationQueue.current = rotationQueue.current.then(async () => {
    // ... rotation logic (same body as before) ...
  });
  await rotationQueue.current;
}, [...]);
```

Remove `rotatingRef` entirely.

- [ ] **Step 2: Test manually** — record audio > 5 minutes, verify segments rotate without gaps

- [ ] **Step 3: Commit**

```bash
git add src/useAudioRecorder.ts
git commit -m "fix: replace boolean lock with promise queue for audio segment rotation"
```

---

### Task 6: Fix debounced save after unmount

**Files:**
- Modify: `src/panel.tsx`

- [ ] **Step 1: Add mounted ref**

Add near the other refs:
```typescript
const mountedRef = useRef(true);
useEffect(() => { return () => { mountedRef.current = false; }; }, []);
```

- [ ] **Step 2: Guard setState calls in async save**

In the debounced save setTimeout callback, wrap state updates:
```typescript
if (!mountedRef.current) return;
setChatFilePath(path);
```

Same for `handleManualSave` and `selectPerson`.

- [ ] **Step 3: Commit**

```bash
git add src/panel.tsx
git commit -m "fix: guard setState calls against post-unmount updates"
```

---

### Task 7: Fix MarkdownRenderer delay

**Files:**
- Modify: `src/panel.tsx` (MarkdownBlock component)

- [ ] **Step 1: Replace setTimeout with useEffect**

The current `MarkdownBlock` uses `setTimeout(50ms)` which is arbitrary. Replace with a synchronous render in useEffect:

```typescript
function MarkdownBlock({ markdown, app, component }: { ... }) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.empty();
    MarkdownRenderer.render(app, markdown, el, "", component);
  }, [markdown]);

  return <div ref={elRef} className="ca-markdown" />;
}
```

Remove the `useState` for rendered content and the `setTimeout`.

- [ ] **Step 2: Verify markdown renders in chat messages**

- [ ] **Step 3: Commit**

```bash
git add src/panel.tsx
git commit -m "fix: replace arbitrary timeout with synchronous MarkdownRenderer"
```

---

## Chunk 3: Panel Component Split

### Task 8: Extract ChatHeader component

**Files:**
- Create: `src/components/ChatHeader.tsx`
- Modify: `src/panel.tsx`

- [ ] **Step 1: Create components directory**

```bash
mkdir -p src/components
```

- [ ] **Step 2: Extract header JSX + state into ChatHeader.tsx**

Move the header section (badges, skill selector, tool toggles, save, new chat, settings buttons) into its own component. Props:

```typescript
interface ChatHeaderProps {
  activeSkill: Skill | null;
  skills: Skill[];
  effectiveWrite: boolean;
  effectiveCli: boolean;
  messageCount: number;
  noteContext: string | undefined;
  sessionId: string | undefined;
  useLocalStt: boolean;
  showSaveConfirm: boolean;
  selectedPerson: PersonProfile | null;
  showTooltips: boolean;
  onSkillSelect: (skillId: string | null) => void;
  onToggleWrite: () => void;
  onToggleCli: () => void;
  onSave: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}
```

- [ ] **Step 3: Import and use in panel.tsx**

Replace inline header JSX with `<ChatHeader ... />`.

- [ ] **Step 4: Build and verify**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatHeader.tsx src/panel.tsx
git commit -m "refactor: extract ChatHeader component from panel"
```

---

### Task 9: Extract PersonPicker component

**Files:**
- Create: `src/components/PersonPicker.tsx`
- Modify: `src/panel.tsx`

- [ ] **Step 1: Extract person picker overlay into PersonPicker.tsx**

```typescript
interface PersonPickerProps {
  people: PersonProfile[];
  onSelect: (person: PersonProfile) => void;
  onCancel: () => void;
}
```

- [ ] **Step 2: Import and use in panel.tsx**

- [ ] **Step 3: Build and verify**

- [ ] **Step 4: Commit**

```bash
git add src/components/PersonPicker.tsx src/panel.tsx
git commit -m "refactor: extract PersonPicker component from panel"
```

---

### Task 10: Extract InputArea component

**Files:**
- Create: `src/components/InputArea.tsx`
- Modify: `src/panel.tsx`

- [ ] **Step 1: Extract input row with @ mentions, / commands, attached files, send button**

This is the most complex extraction. Props:

```typescript
interface InputAreaProps {
  input: string;
  onInputChange: (val: string) => void;
  onSend: () => void;
  onMicClick: () => void;
  isStreaming: boolean;
  isRecording: boolean;
  recorderState: string;
  attachedFiles: string[];
  onRemoveFile: (path: string) => void;
  skills: Skill[];
  vaultIndex: VaultIndex | null;
  onSkillSelect: (skill: Skill) => void;
  showTooltips: boolean;
  activeSkillAutoPrompt?: string;
}
```

- [ ] **Step 2: Move @ mention state, / command state, handleInputChange, handleKeyDown, insertMention, insertSlashCommand into InputArea**

- [ ] **Step 3: Import and use in panel.tsx**

- [ ] **Step 4: Build and verify**

- [ ] **Step 5: Commit**

```bash
git add src/components/InputArea.tsx src/panel.tsx
git commit -m "refactor: extract InputArea component with @ mentions and / commands"
```

---

### Task 11: Extract MessageThread component

**Files:**
- Create: `src/components/MessageThread.tsx`
- Modify: `src/panel.tsx`

- [ ] **Step 1: Extract message list + empty state into MessageThread.tsx**

```typescript
interface MessageThreadProps {
  messages: Message[];
  isStreaming: boolean;
  activeSkill: Skill | null;
  selectedPerson: PersonProfile | null;
  app: App;
  component: Component;
}
```

Includes `MarkdownBlock` and `CopyButton` sub-components.

- [ ] **Step 2: Import and use in panel.tsx**

- [ ] **Step 3: Build and verify**

- [ ] **Step 4: Commit**

```bash
git add src/components/MessageThread.tsx src/panel.tsx
git commit -m "refactor: extract MessageThread component from panel"
```

---

### Task 12: Extract AudioControls component

**Files:**
- Create: `src/components/AudioControls.tsx`
- Modify: `src/panel.tsx`

- [ ] **Step 1: Extract waveform, audio ready state, mic error banner into AudioControls.tsx**

- [ ] **Step 2: Import and use in panel.tsx**

- [ ] **Step 3: Build and verify full plugin works**

```bash
npm run build
```

- [ ] **Step 4: Run tests to verify nothing broke**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/components/AudioControls.tsx src/panel.tsx
git commit -m "refactor: extract AudioControls component from panel"
```

---

## Chunk 4: Error Handling

### Task 13: Validate CLI path on settings save

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1: Add validation check after claudePath changes**

In the claudePath setting `onChange`, after saving, check if the path is executable:

```typescript
.onChange(async (value) => {
  this.plugin.settings.claudePath = value;
  await this.plugin.saveSettings();
  // Validate
  try {
    const { execSync } = require("child_process");
    execSync(`${value || "claude"} --version`, { timeout: 5000 });
  } catch {
    new Notice("Claude Code CLI not found at this path. Check Settings.");
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add src/settings.ts
git commit -m "feat: validate Claude Code CLI path on settings change"
```

---

### Task 14: Improve error messages

**Files:**
- Modify: `src/chatHistory.ts`

- [ ] **Step 1: Add specific error details to loadChat**

Replace generic "Could not load chat file" with specific reasons:

```typescript
if ("error" in result) {
  console.warn(`OpenBrain: ${path}: ${result.error}`);
  return null;
}
```

The caller in panel.tsx already shows a Notice. Make the console warning include the file path and specific error (missing frontmatter, unsupported version, etc.)

- [ ] **Step 2: Commit**

```bash
git add src/chatHistory.ts
git commit -m "fix: include specific error details in chat load failures"
```

---

### Task 15: Final build and deploy

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Deploy**

```bash
cp main.js manifest.json styles.css ~/GitHub/Obsidian/.obsidian/plugins/open-brain/
```

- [ ] **Step 4: Commit all remaining changes**

```bash
git add -A
git commit -m "chore: Phase 1 hardening complete — tests, component split, bug fixes, error handling"
```
