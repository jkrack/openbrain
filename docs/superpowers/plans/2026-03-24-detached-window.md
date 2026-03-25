# Detached OpenBrain Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pop OpenBrain out of the sidebar into its own native Obsidian window with a three-panel layout (navigation, chat, context).

**Architecture:** A new `ItemView` subclass renders a three-panel React layout in an Obsidian popout window (`workspace.openPopoutLeaf()`). A `ChatStateManager` class on the plugin instance externalizes chat state so both sidebar and popout views can share it. All business logic (chat engine, tools, skills, vault APIs) is reused without changes.

**Tech Stack:** TypeScript, React 18, Obsidian Plugin API (`ItemView`, `workspace.openPopoutLeaf()`), EventEmitter pattern for state sync.

**Spec:** `docs/superpowers/specs/2026-03-24-detached-window-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/chatStateManager.ts` | Shared chat state with EventEmitter. Holds messages, streaming flag, active skill, chat path, tool activity log. Both views subscribe via change events. |
| `src/detachedView.ts` | `ItemView` subclass for popout window. Mounts `DetachedPanel` React component. Implements `getState()`/`setState()` for workspace restoration. |
| `src/components/DetachedPanel.tsx` | Three-panel layout container. Left nav, center pane router, right context panel. |
| `src/components/ChatListSidebar.tsx` | Left panel: chat history grouped by date, bottom nav (Skills, Graph, Tasks, Settings). |
| `src/components/ContextPanel.tsx` | Right panel: three collapsible sections (Active Context, Knowledge Graph, Tool Activity). |
| `src/components/CenterPane.tsx` | Router: renders chat view, skills browser, graph dashboard, or task view based on nav selection. |
| `src/components/SkillsBrowser.tsx` | Skills list with descriptions and "Run" buttons. |
| `src/components/GraphDashboard.tsx` | Graph stats display + entity search. |
| `src/__tests__/chatStateManager.test.ts` | Tests for ChatStateManager state transitions and event emission. |

### Modified Files
| File | Change |
|------|--------|
| `src/main.ts` | Register `DetachedOpenBrainView`, add detach/attach commands, instantiate `ChatStateManager`. |
| `src/view.ts` | Add detach button (↗) to sidebar header. |
| `src/panel.tsx` | Replace local useState chat state with ChatStateManager subscription. Render output stays identical. |
| `src/settings.ts` | Add `detachedWindowSize`, `detachedWindowPosition`, `contextPanelCollapsed` settings. |
| `styles.css` | Add `.ob-detached-*` three-panel layout styles. |

---

## Phase 1: ChatStateManager + Detached Shell

### Task 1: ChatStateManager — Core State

**Files:**
- Create: `src/chatStateManager.ts`
- Create: `src/__tests__/chatStateManager.test.ts`

- [ ] **Step 1: Write failing tests for ChatStateManager**

```typescript
// src/__tests__/chatStateManager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  TFile: class {},
  Events: class {
    _handlers: Record<string, Function[]> = {};
    on(event: string, fn: Function) { (this._handlers[event] ??= []).push(fn); }
    off(event: string, fn: Function) { const h = this._handlers[event]; if (h) { const i = h.indexOf(fn); if (i >= 0) h.splice(i, 1); } }
    trigger(event: string, ...args: any[]) { for (const fn of this._handlers[event] ?? []) fn(...args); }
  },
}));

import { ChatStateManager } from "../chatStateManager";

describe("ChatStateManager", () => {
  let manager: ChatStateManager;

  beforeEach(() => {
    manager = new ChatStateManager();
  });

  it("starts with empty state", () => {
    expect(manager.messages).toEqual([]);
    expect(manager.isStreaming).toBe(false);
    expect(manager.chatFilePath).toBeNull();
    expect(manager.activeSkillId).toBeNull();
  });

  it("emits change on addMessage", () => {
    const listener = vi.fn();
    manager.on("change", listener);
    manager.addMessage({ id: "1", role: "user", content: "hello", timestamp: new Date() });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.messages).toHaveLength(1);
  });

  it("emits change on setStreaming", () => {
    const listener = vi.fn();
    manager.on("change", listener);
    manager.setStreaming(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.isStreaming).toBe(true);
  });

  it("appendToLastAssistant updates existing message", () => {
    manager.addMessage({ id: "a1", role: "assistant", content: "Hello", timestamp: new Date() });
    const listener = vi.fn();
    manager.on("change", listener);
    manager.appendToLastAssistant(" world");
    expect(manager.messages[0].content).toBe("Hello world");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("addToolActivity tracks tool calls", () => {
    manager.addToolActivity("vault_search", "running");
    expect(manager.toolActivity).toHaveLength(1);
    expect(manager.toolActivity[0].name).toBe("vault_search");
    expect(manager.toolActivity[0].status).toBe("running");
  });

  it("updateToolActivity changes status", () => {
    manager.addToolActivity("vault_search", "running");
    manager.updateToolActivity("vault_search", "complete", 12);
    expect(manager.toolActivity[0].status).toBe("complete");
    expect(manager.toolActivity[0].durationMs).toBe(12);
  });

  it("reset clears all state", () => {
    manager.addMessage({ id: "1", role: "user", content: "hi", timestamp: new Date() });
    manager.setStreaming(true);
    manager.setChatFilePath("/test.md");
    manager.reset();
    expect(manager.messages).toEqual([]);
    expect(manager.isStreaming).toBe(false);
    expect(manager.chatFilePath).toBeNull();
  });

  it("unsubscribe works", () => {
    const listener = vi.fn();
    manager.on("change", listener);
    manager.off("change", listener);
    manager.addMessage({ id: "1", role: "user", content: "hi", timestamp: new Date() });
    expect(listener).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/chatStateManager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ChatStateManager**

```typescript
// src/chatStateManager.ts
import { Events } from "obsidian";

import { Message } from "./providers/types";

export interface ToolCallEntry {
  name: string;
  status: "running" | "complete" | "error";
  startedAt: number;
  durationMs?: number;
}

export interface ChatMeta {
  skill: string;
  sessionId: string;
  hasAudio: boolean;
  title: string;
  tags: string[];
}

/**
 * Shared chat state that lives on the plugin instance.
 * Both sidebar and detached views subscribe to change events.
 * Extends Obsidian's Events class for on/off/trigger.
 */
export class ChatStateManager extends Events {
  messages: Message[] = [];
  isStreaming = false;
  chatFilePath: string | null = null;
  activeSkillId: string | null = null;
  chatMode: "agent" | "chat" = "agent";
  allowWrite = false;
  allowCli = false;
  toolActivity: ToolCallEntry[] = [];
  meta: ChatMeta = { skill: "", sessionId: "", hasAudio: false, title: "", tags: [] };

  // Context injected by smart context (for right panel display)
  activeContext: string[] = [];
  graphContext: { path: string; hop: number; relationship: string }[] = [];

  addMessage(msg: Message): void {
    this.messages = [...this.messages, msg];
    this.trigger("change");
  }

  setMessages(msgs: Message[]): void {
    this.messages = msgs;
    this.trigger("change");
  }

  appendToLastAssistant(chunk: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") {
      this.messages = [
        ...this.messages.slice(0, -1),
        { ...last, content: last.content + chunk },
      ];
      this.trigger("change");
    }
  }

  setStreaming(value: boolean): void {
    this.isStreaming = value;
    this.trigger("change");
  }

  setChatFilePath(path: string | null): void {
    this.chatFilePath = path;
    this.trigger("change");
  }

  setActiveSkillId(id: string | null): void {
    this.activeSkillId = id;
    this.trigger("change");
  }

  setChatMode(mode: "agent" | "chat"): void {
    this.chatMode = mode;
    this.trigger("change");
  }

  setPermissions(write: boolean, cli: boolean): void {
    this.allowWrite = write;
    this.allowCli = cli;
    this.trigger("change");
  }

  setActiveContext(paths: string[]): void {
    this.activeContext = paths;
    this.trigger("change");
  }

  setGraphContext(results: { path: string; hop: number; relationship: string }[]): void {
    this.graphContext = results;
    this.trigger("change");
  }

  addToolActivity(name: string, status: "running" | "complete" | "error"): void {
    this.toolActivity = [...this.toolActivity, { name, status, startedAt: Date.now() }];
    this.trigger("change");
  }

  updateToolActivity(name: string, status: "running" | "complete" | "error", durationMs?: number): void {
    this.toolActivity = this.toolActivity.map((t) =>
      t.name === name && t.status === "running" ? { ...t, status, durationMs } : t
    );
    this.trigger("change");
  }

  reset(): void {
    this.messages = [];
    this.isStreaming = false;
    this.chatFilePath = null;
    this.activeSkillId = null;
    this.chatMode = "agent";
    this.toolActivity = [];
    this.activeContext = [];
    this.graphContext = [];
    this.meta = { skill: "", sessionId: "", hasAudio: false, title: "", tags: [] };
    this.trigger("change");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/chatStateManager.test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/chatStateManager.ts src/__tests__/chatStateManager.test.ts
git commit -m "feat: add ChatStateManager for shared cross-view state"
```

---

### Task 2: Wire ChatStateManager into Plugin

**Files:**
- Modify: `src/main.ts`
- Modify: `src/settings.ts`

- [ ] **Step 1: Add settings fields**

In `src/settings.ts`, add to `OpenBrainSettings` interface (after `knowledgeGraphAutoInfer`):

```typescript
  // Detached window
  detachedWindowSize: { width: number; height: number };
  detachedWindowPosition: { x: number; y: number } | null;
  contextPanelCollapsed: { context: boolean; graph: boolean; tools: boolean };
```

Add to `DEFAULT_SETTINGS` (after `knowledgeGraphAutoInfer: true`):

```typescript
  detachedWindowSize: { width: 1200, height: 800 },
  detachedWindowPosition: null,
  contextPanelCollapsed: { context: false, graph: false, tools: true },
```

- [ ] **Step 2: Instantiate ChatStateManager in main.ts**

In `src/main.ts`, add import:

```typescript
import { ChatStateManager } from "./chatStateManager";
```

Add property to `OpenBrainPlugin` class (after `private graphInferTimers`):

```typescript
  chatState: ChatStateManager = new ChatStateManager();
```

- [ ] **Step 3: Build and verify**

Run: `npm run build && npx vitest run`
Expected: Build clean, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/main.ts src/settings.ts
git commit -m "feat: wire ChatStateManager into plugin, add detached window settings"
```

---

### Task 3: Detached View + Three-Panel Shell

**Files:**
- Create: `src/detachedView.ts`
- Create: `src/components/DetachedPanel.tsx`
- Create: `src/components/ChatListSidebar.tsx`
- Create: `src/components/ContextPanel.tsx`
- Create: `src/components/CenterPane.tsx`

- [ ] **Step 1: Create DetachedOpenBrainView**

```typescript
// src/detachedView.ts
import { ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import { OpenBrainSettings } from "./settings";
import { Skill } from "./skills";
import { ChatStateManager } from "./chatStateManager";
import { VaultIndex } from "./vaultIndex";
import { DetachedPanel } from "./components/DetachedPanel";

export const DETACHED_OPEN_BRAIN_VIEW_TYPE = "detached-open-brain-view";

export class DetachedOpenBrainView extends ItemView {
  private root: Root | null = null;
  settings: OpenBrainSettings;
  skills: Skill[];
  chatState: ChatStateManager;
  vaultIndex: VaultIndex | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    settings: OpenBrainSettings,
    skills: Skill[],
    chatState: ChatStateManager
  ) {
    super(leaf);
    this.settings = settings;
    this.skills = skills;
    this.chatState = chatState;
  }

  getViewType(): string {
    return DETACHED_OPEN_BRAIN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "OpenBrain";
  }

  getIcon(): string {
    return "openbrain";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("ob-detached-root");
    this.root = createRoot(container);
    this.rerender();
  }

  rerender(): void {
    if (!this.root) return;
    this.root.render(
      createElement(DetachedPanel, {
        app: this.app,
        settings: this.settings,
        skills: this.skills,
        chatState: this.chatState,
        vaultIndex: this.vaultIndex,
        component: this,
        onAttach: () => this.handleAttach(),
      })
    );
  }

  private handleAttach(): void {
    // Show dialog: close this window, or keep both open?
    const plugin = (this.app as any).plugins?.plugins?.["open-brain"];
    if (!plugin) return;
    const modal = new AttachModal(this.app, (closeBoth: boolean) => {
      void plugin.attachToSidebar(closeBoth);
    });
    modal.open();
  }

  updateSkills(skills: Skill[]): void {
    this.skills = skills;
    this.rerender();
  }

  getState(): Record<string, unknown> {
    return {
      chatPath: this.chatState.chatFilePath,
      activeSkillId: this.chatState.activeSkillId,
    };
  }

  setState(state: Record<string, unknown>): Promise<void> {
    if (state.chatPath && typeof state.chatPath === "string") {
      this.chatState.setChatFilePath(state.chatPath);
    }
    return super.setState(state);
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
  }
}
```

- [ ] **Step 2: Create DetachedPanel (three-panel container)**

```typescript
// src/components/DetachedPanel.tsx
import { App } from "obsidian";
import { useState, useEffect, useCallback } from "react";
import { OpenBrainSettings } from "../settings";
import { Skill } from "../skills";
import { ChatStateManager } from "../chatStateManager";
import { VaultIndex } from "../vaultIndex";
import { ChatListSidebar } from "./ChatListSidebar";
import { ContextPanel } from "./ContextPanel";
import { CenterPane } from "./CenterPane";

interface DetachedPanelProps {
  app: App;
  settings: OpenBrainSettings;
  skills: Skill[];
  chatState: ChatStateManager;
  vaultIndex: VaultIndex | null;
  component: any;
  onAttach: () => void;
}

type CenterView = "chat" | "skills" | "graph" | "tasks";

export function DetachedPanel({
  app, settings, skills, chatState, vaultIndex, component, onAttach,
}: DetachedPanelProps) {
  const [centerView, setCenterView] = useState<CenterView>("chat");
  const [, forceUpdate] = useState(0);

  // Subscribe to ChatStateManager changes
  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    chatState.on("change", handler);
    return () => { chatState.off("change", handler); };
  }, [chatState]);

  const handleNavClick = useCallback((view: CenterView) => {
    setCenterView(view);
  }, []);

  const handleChatSelect = useCallback((path: string) => {
    setCenterView("chat");
    // Chat loading will be wired when panel.tsx is refactored
  }, []);

  return (
    <div className="ob-detached-layout">
      <ChatListSidebar
        app={app}
        settings={settings}
        activeChatPath={chatState.chatFilePath}
        activeView={centerView}
        onChatSelect={handleChatSelect}
        onNavClick={handleNavClick}
      />
      <CenterPane
        app={app}
        settings={settings}
        skills={skills}
        chatState={chatState}
        vaultIndex={vaultIndex}
        component={component}
        centerView={centerView}
        onAttach={onAttach}
      />
      <ContextPanel
        settings={settings}
        chatState={chatState}
        vaultIndex={vaultIndex}
      />
    </div>
  );
}
```

- [ ] **Step 3: Create ChatListSidebar**

```typescript
// src/components/ChatListSidebar.tsx
import { App } from "obsidian";
import { useState, useEffect } from "react";
import { OpenBrainSettings } from "../settings";
import { listRecentChats } from "../chatHistory";

interface ChatListSidebarProps {
  app: App;
  settings: OpenBrainSettings;
  activeChatPath: string | null;
  activeView: string;
  onChatSelect: (path: string) => void;
  onNavClick: (view: "chat" | "skills" | "graph" | "tasks") => void;
}

interface ChatEntry {
  path: string;
  title: string;
  updated: string;
}

export function ChatListSidebar({
  app, settings, activeChatPath, activeView, onChatSelect, onNavClick,
}: ChatListSidebarProps) {
  const [chats, setChats] = useState<ChatEntry[]>([]);

  useEffect(() => {
    // listRecentChats returns ChatMeta[] without paths.
    // Scan chat folder directly to get path + title + updated.
    const folder = settings.chatFolder || "OpenBrain/chats";
    const files = app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(folder + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 30);
    const entries: ChatEntry[] = [];
    for (const file of files) {
      const cache = app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (fm?.type !== "openbrain-chat") continue;
      entries.push({
        path: file.path,
        title: fm.title || file.basename,
        updated: fm.updated || new Date(file.stat.mtime).toISOString(),
      });
    }
    setChats(entries);
  }, [app, settings.chatFolder]);

  // Group by date
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const groups: { label: string; items: ChatEntry[] }[] = [];
  const todayItems = chats.filter((c) => c.updated.startsWith(today));
  const yesterdayItems = chats.filter((c) => c.updated.startsWith(yesterday));
  const olderItems = chats.filter(
    (c) => !c.updated.startsWith(today) && !c.updated.startsWith(yesterday)
  );

  if (todayItems.length) groups.push({ label: "Today", items: todayItems });
  if (yesterdayItems.length) groups.push({ label: "Yesterday", items: yesterdayItems });
  if (olderItems.length) groups.push({ label: "Earlier", items: olderItems });

  return (
    <div className="ob-detached-sidebar">
      <div className="ob-detached-sidebar-header">
        <span className="ob-detached-logo">🧠 OpenBrain</span>
      </div>
      <button
        className="ob-detached-new-chat"
        onClick={() => onNavClick("chat")}
      >
        + New Chat
      </button>
      <div className="ob-detached-chat-list">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="ob-detached-group-label">{group.label}</div>
            {group.items.map((chat) => (
              <div
                key={chat.path}
                className={`ob-detached-chat-item ${chat.path === activeChatPath ? "active" : ""}`}
                onClick={() => onChatSelect(chat.path)}
              >
                {chat.title}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="ob-detached-bottom-nav">
        <div
          className={`ob-detached-nav-item ${activeView === "skills" ? "active" : ""}`}
          onClick={() => onNavClick("skills")}
        >📋 Skills</div>
        <div
          className={`ob-detached-nav-item ${activeView === "graph" ? "active" : ""}`}
          onClick={() => onNavClick("graph")}
        >📊 Graph</div>
        <div
          className={`ob-detached-nav-item ${activeView === "tasks" ? "active" : ""}`}
          onClick={() => onNavClick("tasks")}
        >✅ Tasks</div>
        <div
          className="ob-detached-nav-item"
          onClick={() => (app as any).setting?.open()}
        >⚙️ Settings</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create ContextPanel (right panel, stubs for now)**

```typescript
// src/components/ContextPanel.tsx
import { useState } from "react";
import { OpenBrainSettings } from "../settings";
import { ChatStateManager } from "../chatStateManager";
import { VaultIndex } from "../vaultIndex";

interface ContextPanelProps {
  settings: OpenBrainSettings;
  chatState: ChatStateManager;
  vaultIndex: VaultIndex | null;
}

export function ContextPanel({ settings, chatState, vaultIndex }: ContextPanelProps) {
  const [collapsed, setCollapsed] = useState(settings.contextPanelCollapsed);

  const toggle = (section: "context" | "graph" | "tools") => {
    setCollapsed((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  return (
    <div className="ob-detached-context">
      <div className="ob-detached-context-section">
        <div className="ob-detached-context-header" onClick={() => toggle("context")}>
          {collapsed.context ? "▸" : "▾"} Active Context
        </div>
        {!collapsed.context && (
          <div className="ob-detached-context-body">
            {chatState.activeContext.length === 0 ? (
              <div className="ob-detached-context-empty">No active context</div>
            ) : (
              chatState.activeContext.map((path) => (
                <div key={path} className="ob-detached-context-item">{path.split("/").pop()?.replace(/\.md$/, "")}</div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="ob-detached-context-section">
        <div className="ob-detached-context-header" onClick={() => toggle("graph")}>
          {collapsed.graph ? "▸" : "▾"} Knowledge Graph
        </div>
        {!collapsed.graph && (
          <div className="ob-detached-context-body">
            {chatState.graphContext.length === 0 ? (
              <div className="ob-detached-context-empty">No graph context</div>
            ) : (
              chatState.graphContext.map((r) => (
                <div key={r.path} className="ob-detached-context-item">
                  ↗ {r.path.split("/").pop()?.replace(/\.md$/, "")}
                  <span className="ob-detached-context-meta">hop {r.hop}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="ob-detached-context-section">
        <div className="ob-detached-context-header" onClick={() => toggle("tools")}>
          {collapsed.tools ? "▸" : "▾"} Tool Activity
        </div>
        {!collapsed.tools && (
          <div className="ob-detached-context-body">
            {chatState.toolActivity.length === 0 ? (
              <div className="ob-detached-context-empty">No tool activity</div>
            ) : (
              chatState.toolActivity.map((t, i) => (
                <div key={i} className={`ob-detached-tool-item ${t.status}`}>
                  {t.status === "complete" ? "✓" : t.status === "error" ? "✗" : "⏳"} {t.name}
                  {t.durationMs != null && <span className="ob-detached-context-meta">{t.durationMs}ms</span>}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create CenterPane (chat-only for Phase 1)**

```typescript
// src/components/CenterPane.tsx
import { App } from "obsidian";
import { OpenBrainSettings } from "../settings";
import { Skill } from "../skills";
import { ChatStateManager } from "../chatStateManager";
import { VaultIndex } from "../vaultIndex";

interface CenterPaneProps {
  app: App;
  settings: OpenBrainSettings;
  skills: Skill[];
  chatState: ChatStateManager;
  vaultIndex: VaultIndex | null;
  component: any;
  centerView: "chat" | "skills" | "graph" | "tasks";
  onAttach: () => void;
}

export function CenterPane({
  app, settings, skills, chatState, vaultIndex, component, centerView, onAttach,
}: CenterPaneProps) {
  return (
    <div className="ob-detached-center">
      <div className="ob-detached-center-header">
        <span className="ob-detached-center-title">
          {centerView === "chat" && (chatState.meta.title || "New Chat")}
          {centerView === "skills" && "Skills"}
          {centerView === "graph" && "Knowledge Graph"}
          {centerView === "tasks" && "Tasks"}
        </span>
        <button className="ob-detached-attach-btn" onClick={onAttach}>
          ⏪ Attach
        </button>
      </div>
      <div className="ob-detached-center-body">
        {centerView === "chat" && (
          <div className="ob-detached-chat-placeholder">
            Chat view — will be wired when panel.tsx is refactored to use ChatStateManager
          </div>
        )}
        {centerView === "skills" && (
          <div className="ob-detached-placeholder">Skills browser — Phase 3</div>
        )}
        {centerView === "graph" && (
          <div className="ob-detached-placeholder">Graph dashboard — Phase 3</div>
        )}
        {centerView === "tasks" && (
          <div className="ob-detached-placeholder">Task dashboard — Phase 3</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Expected: Build clean (no runtime test yet — React components need Obsidian at runtime)

- [ ] **Step 7: Commit**

```bash
git add src/detachedView.ts src/components/DetachedPanel.tsx src/components/ChatListSidebar.tsx src/components/ContextPanel.tsx src/components/CenterPane.tsx
git commit -m "feat: detached view shell — three-panel layout with stubs"
```

---

### Task 4: Three-Panel CSS

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Add detached layout styles**

Append to end of `styles.css`:

```css
/* ══════════════════════════════════════════════════════════════
   DETACHED WINDOW — Three-panel layout
   ══════════════════════════════════════════════════════════════ */

.ob-detached-root {
  height: 100%;
  overflow: hidden;
}

.ob-detached-layout {
  display: flex;
  height: 100%;
  background: var(--background-primary);
  color: var(--text-normal);
  font-family: var(--ca-font-body, var(--font-text));
}

/* ── Left Sidebar ── */

.ob-detached-sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--background-secondary);
  border-right: 1px solid var(--background-modifier-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ob-detached-sidebar-header {
  padding: 16px 16px 12px;
}

.ob-detached-logo {
  font-weight: 700;
  font-size: 15px;
}

.ob-detached-new-chat {
  margin: 0 12px 8px;
  padding: 7px 10px;
  background: var(--background-modifier-hover);
  border: none;
  border-radius: 6px;
  color: var(--text-normal);
  font-size: var(--ca-size-body, 13px);
  text-align: left;
  cursor: pointer;
}
.ob-detached-new-chat:hover { background: var(--background-modifier-border); }

.ob-detached-chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}

.ob-detached-group-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  padding: 12px 8px 4px;
}

.ob-detached-chat-item {
  padding: 7px 10px;
  border-radius: 5px;
  font-size: var(--ca-size-body, 13px);
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ob-detached-chat-item:hover { background: var(--background-modifier-hover); }
.ob-detached-chat-item.active {
  background: var(--background-modifier-border);
  color: var(--text-normal);
}

.ob-detached-bottom-nav {
  border-top: 1px solid var(--background-modifier-border);
  padding: 8px 8px 12px;
  flex-shrink: 0;
}

.ob-detached-nav-item {
  padding: 6px 10px;
  font-size: var(--ca-size-body, 13px);
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
}
.ob-detached-nav-item:hover { background: var(--background-modifier-hover); }
.ob-detached-nav-item.active {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}

/* ── Center Pane ── */

.ob-detached-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ob-detached-center-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--background-modifier-border);
  flex-shrink: 0;
}

.ob-detached-center-title {
  font-weight: 600;
  font-size: 14px;
}

.ob-detached-attach-btn {
  background: var(--background-modifier-hover);
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--interactive-accent);
  cursor: pointer;
}
.ob-detached-attach-btn:hover { background: var(--background-modifier-border); }

.ob-detached-center-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 32px;
}

.ob-detached-placeholder,
.ob-detached-chat-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: var(--text-muted);
  font-size: var(--ca-size-body, 13px);
}

/* ── Right Context Panel ── */

.ob-detached-context {
  width: 250px;
  flex-shrink: 0;
  background: var(--background-secondary);
  border-left: 1px solid var(--background-modifier-border);
  overflow-y: auto;
  padding: 14px;
}

.ob-detached-context-section {
  margin-bottom: 12px;
}

.ob-detached-context-header {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px 0;
  user-select: none;
}

.ob-detached-context-body {
  margin-top: 6px;
}

.ob-detached-context-item {
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.ob-detached-context-empty {
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text-faint);
  font-style: italic;
}

.ob-detached-context-meta {
  font-size: 10px;
  color: var(--text-faint);
}

.ob-detached-tool-item {
  padding: 4px 8px;
  font-size: 11px;
  display: flex;
  justify-content: space-between;
}
.ob-detached-tool-item.complete { color: var(--text-success); }
.ob-detached-tool-item.error { color: var(--text-error); }
.ob-detached-tool-item.running { color: var(--text-accent); }
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Build clean

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat: three-panel CSS for detached window"
```

---

### Task 5: Register View + Detach/Attach Commands

**Files:**
- Modify: `src/main.ts`
- Modify: `src/view.ts`

- [ ] **Step 1: Register detached view in main.ts**

Add import at top of `src/main.ts`:

```typescript
import { DetachedOpenBrainView, DETACHED_OPEN_BRAIN_VIEW_TYPE } from "./detachedView";
```

In `onload()`, after the existing `registerView` for `OPEN_BRAIN_VIEW_TYPE` (line ~70), add:

```typescript
    this.registerView(
      DETACHED_OPEN_BRAIN_VIEW_TYPE,
      (leaf) => {
        const view = new DetachedOpenBrainView(leaf, this.settings, this.skills, this.chatState);
        view.vaultIndex = this.vaultIndex;
        return view;
      }
    );
```

- [ ] **Step 2: Add detach command**

After the `run-graph-enrichment` command in `src/main.ts`, add:

```typescript
    this.addCommand({
      id: "detach-to-window",
      name: "Detach to window",
      callback: () => {
        if (Platform.isDesktop) {
          void this.detachToWindow();
        } else {
          new Notice("Detached window is only available on desktop");
        }
      },
    });

    this.addCommand({
      id: "attach-to-sidebar",
      name: "Attach to sidebar",
      callback: () => {
        void this.attachToSidebar();
      },
    });
```

- [ ] **Step 3: Add detach/attach methods**

Add these methods to `OpenBrainPlugin` class (before `onunload()`):

```typescript
  async detachToWindow(): Promise<void> {
    // Block while streaming
    if (this.chatState.isStreaming) {
      new Notice("Wait for the response to complete before detaching.");
      return;
    }

    // Force-save any pending chat (flush debounce timer)
    this.chatState.trigger("force-save");

    // Open popout window with stored size/position
    const initData: any = {
      size: this.settings.detachedWindowSize,
    };
    if (this.settings.detachedWindowPosition) {
      initData.x = this.settings.detachedWindowPosition.x;
      initData.y = this.settings.detachedWindowPosition.y;
    }
    const leaf = this.app.workspace.openPopoutLeaf(initData);
    await leaf.setViewState({
      type: DETACHED_OPEN_BRAIN_VIEW_TYPE,
      active: true,
    });

    // Close sidebar
    const sidebarLeaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
    for (const l of sidebarLeaves) {
      l.detach();
    }
  }

  async attachToSidebar(closeBoth = false): Promise<void> {
    if (this.chatState.isStreaming) {
      new Notice("Wait for the response to complete before attaching.");
      return;
    }

    // Force-save any pending chat
    this.chatState.trigger("force-save");

    // Open sidebar
    await this.activateView();

    if (closeBoth) {
      // Close detached windows
      const detachedLeaves = this.app.workspace.getLeavesOfType(DETACHED_OPEN_BRAIN_VIEW_TYPE);
      for (const l of detachedLeaves) {
        l.detach();
      }
    }
    // If !closeBoth, both views stay open and share ChatStateManager
  }
```

- [ ] **Step 4: Add detach button to sidebar view.ts**

In `src/view.ts`, in the `onOpen()` method, after `container.empty()`, add a detach button to the header:

```typescript
    // Add detach button to header
    const headerEl = this.containerEl.children[0] as HTMLElement;
    if (headerEl) {
      const detachBtn = headerEl.createEl("button", {
        cls: "ob-detach-btn",
        attr: { "aria-label": "Detach to window" },
      });
      detachBtn.setText("↗");
      detachBtn.addEventListener("click", () => {
        if (this.plugin) {
          void (this.plugin as any).detachToWindow();
        }
      });
    }
```

- [ ] **Step 5: Build and verify**

Run: `npm run build && npx vitest run`
Expected: Build clean, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/view.ts
git commit -m "feat: register detached view, add detach/attach commands"
```

---

### Task 6: Build, Test Full Suite, and Verify Phase 1

- [ ] **Step 1: Run full build and test suite**

Run: `npm run build && npx vitest run`
Expected: Build clean, all tests pass

- [ ] **Step 2: Verify no regressions**

Run: `npx vitest run src/__tests__/vaultIndex.test.ts`
Expected: 22 tests pass (the graph tests from earlier)

- [ ] **Step 3: Commit phase marker**

```bash
git commit --allow-empty -m "milestone: Phase 1 complete — detached shell with ChatStateManager"
```

---

## Phase 2: Right Context Panel (wired)

### Task 7: Wire ContextPanel to Live Data

**Files:**
- Modify: `src/components/ContextPanel.tsx`

This task wires the ContextPanel's three sections to real data from ChatStateManager. The component already reads from `chatState.activeContext`, `chatState.graphContext`, and `chatState.toolActivity` — those fields just need to be populated during chat flow, which happens when panel.tsx is refactored in Phase 3.

- [ ] **Step 1: Add persist collapse state**

Update `ContextPanel` to save collapse state to settings when toggled. Add `onCollapseChange` prop and call it in the `toggle` function.

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Build clean

- [ ] **Step 3: Commit**

```bash
git add src/components/ContextPanel.tsx
git commit -m "feat: wire context panel collapse persistence"
```

---

## Phase 3: Center Pane Routing + panel.tsx Refactor

### Task 8: Skills Browser

**Files:**
- Create: `src/components/SkillsBrowser.tsx`

- [ ] **Step 1: Create SkillsBrowser component**

Simple list of skills with name, description, input type, and a "Run" button that triggers skill activation via ChatStateManager.

- [ ] **Step 2: Wire into CenterPane**

Replace the skills placeholder in `CenterPane.tsx` with `<SkillsBrowser>`.

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/components/SkillsBrowser.tsx src/components/CenterPane.tsx
git commit -m "feat: skills browser in detached center pane"
```

---

### Task 9: Graph Dashboard

**Files:**
- Create: `src/components/GraphDashboard.tsx`

- [ ] **Step 1: Create GraphDashboard component**

Renders graph stats from `VaultIndex` methods (`getAllEntries()`, `getByType()`, `getBacklinks()`, `getMentionedBy()`). Includes entity search via `vault_entity_search` logic. Shows most-connected nodes, orphan count, type distribution.

- [ ] **Step 2: Wire into CenterPane**

Replace graph placeholder in `CenterPane.tsx`.

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/components/GraphDashboard.tsx src/components/CenterPane.tsx
git commit -m "feat: graph dashboard in detached center pane"
```

---

### Task 10: Task Dashboard Adaptation

**Files:**
- Modify: `src/components/CenterPane.tsx`
- Modify: `src/components/TaskTray.tsx` (minor — make layout flexible)

- [ ] **Step 1: Make TaskTray work as full-pane**

Add an optional `fullPane` prop to `TaskTray` that removes the slide-out overlay behavior and renders content directly.

- [ ] **Step 2: Wire into CenterPane**

Replace tasks placeholder with `<TaskTray app={app} settings={settings} isOpen={true} fullPane={true} onClose={() => {}} onFocusTask={() => {}} />`.

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/components/TaskTray.tsx src/components/CenterPane.tsx
git commit -m "feat: task dashboard in detached center pane"
```

---

### Task 11: Refactor panel.tsx to Use ChatStateManager

**Files:**
- Modify: `src/panel.tsx`
- Modify: `src/view.ts` (pass `chatState` prop)

This is the largest task. Replace local `useState` calls for shared chat state with `ChatStateManager` subscriptions. The sidebar panel must render identically before and after. **Local UI state stays as local useState** — only shared chat state moves.

**State that moves to ChatStateManager:**
- `messages` (line 94) → `chatState.messages`
- `isStreaming` (line 97) → `chatState.isStreaming`
- `chatFilePath` (line 107) → `chatState.chatFilePath`
- `activeSkillId` (line 105) → `chatState.activeSkillId`
- `allowWrite` (line 100) → `chatState.allowWrite`
- `allowCli` (line 101) → `chatState.allowCli`
- `chatMode` (line 116) → `chatState.chatMode`

**State that stays as local useState (UI-only):**
- `input`, `setupStatus`, `noteContext`, `noteFilePath`, `audioPrompt`, `showAudioPrompt`
- `showSkillMenu`, `attachedFiles`, `pendingAttachments`, `showTaskTray`
- `onboardingStep`, `onboardingDone`, `showPersonPicker`, `people`, `selectedPerson`
- `sessionId` (used by debounce, keep local but sync to chatState.meta.sessionId)

- [ ] **Step 1: Add chatState prop to OpenBrainPanel**

In `src/view.ts`, pass `chatState` from the plugin to the panel:

```typescript
// In rerender(), add to props:
chatState: this.plugin?.chatState,
```

In `src/panel.tsx`, add `chatState: ChatStateManager` to the props interface.

- [ ] **Step 2: Create useChatState subscription hook**

At the top of `panel.tsx`, add a hook that subscribes to ChatStateManager and returns current values:

```typescript
function useChatState(chatState: ChatStateManager) {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    chatState.on("change", handler);
    return () => { chatState.off("change", handler); };
  }, [chatState]);
  return chatState;
}
```

- [ ] **Step 3: Replace shared useState calls**

Remove the 7 local useState calls listed above. Replace with destructured reads from `useChatState(props.chatState)`. Update all setter calls:
- `setMessages(msgs)` → `chatState.setMessages(msgs)`
- `setIsStreaming(v)` → `chatState.setStreaming(v)`
- `setChatFilePath(p)` → `chatState.setChatFilePath(p)`
- `setActiveSkillId(id)` → `chatState.setActiveSkillId(id)`
- `setAllowWrite(v)` → `chatState.setPermissions(v, chatState.allowCli)`
- `setAllowCli(v)` → `chatState.setPermissions(chatState.allowWrite, v)`
- `setChatMode(m)` → `chatState.setChatMode(m)`

- [ ] **Step 4: Update refs that shadow moved state**

Remove `chatFilePathRef` and update all `.current` reads to use `chatState.chatFilePath` directly. Same for `activeSkillIdRef` → `chatState.activeSkillId`. Keep `sessionIdRef` but sync it: `sessionIdRef.current = chatState.meta.sessionId`.

- [ ] **Step 5: Update sendMessage to use ChatStateManager**

The `sendMessage` callback (lines 486-768) captures `messages`, `isStreaming`, `chatFilePath` in its closure. Update to read from `chatState` directly:
- `chatState.addMessage(userMsg)` + `chatState.addMessage(assistantMsg)` instead of `setMessages([...messages, userMsg, assistantMsg])`
- `chatState.setStreaming(true/false)` instead of `setIsStreaming()`
- Tool callbacks: `onToolStart` → `chatState.addToolActivity(name, "running")`, `onToolEnd` → `chatState.updateToolActivity(name, "complete", duration)`
- `appendAssistantChunk` → `chatState.appendToLastAssistant(chunk)`

- [ ] **Step 6: Update debounced auto-save**

The save effect (lines 332-363) watches `messages` and `isStreaming`. Update to:
- Read from `chatState.messages` and `chatState.isStreaming`
- Listen for `chatState.on("force-save", ...)` to immediately flush (used by detach)

- [ ] **Step 7: Fix document event listeners for popout compatibility**

Replace `document.addEventListener("paste", handlePaste)` (line 256) with:
```typescript
const doc = containerEl?.ownerDocument ?? document;
doc.addEventListener("paste", handlePaste);
// ... cleanup:
doc.removeEventListener("paste", handlePaste);
```

Pass `containerEl` as a prop from view.ts: `containerEl: this.containerEl`.

- [ ] **Step 8: Build and run full test suite**

Run: `npm run build && npx vitest run`
Expected: Build clean, all tests pass. Sidebar renders identically to before.

- [ ] **Step 9: Commit**

```bash
git add src/panel.tsx src/view.ts
git commit -m "refactor: panel.tsx uses ChatStateManager for shared state"
```

---

### Task 12: Wire Chat into Detached CenterPane

**Files:**
- Modify: `src/components/CenterPane.tsx`

- [ ] **Step 1: Import and render the chat components**

Now that panel.tsx uses ChatStateManager, the detached CenterPane can render the same chat UI components (MessageThread, InputArea, AudioControls) reading from the same ChatStateManager instance.

- [ ] **Step 2: Build and test end-to-end**

Run: `npm run build && npx vitest run`

- [ ] **Step 3: Commit**

```bash
git add src/components/CenterPane.tsx
git commit -m "feat: wire live chat into detached center pane"
```

---

### Task 13: Settings Modal

**Files:**
- Modify: `src/components/DetachedPanel.tsx`

- [ ] **Step 1: Add settings modal trigger**

When "Settings" is clicked in the left nav, open `this.app.setting.open()` (Obsidian's built-in settings modal) and navigate to the OpenBrain tab. This reuses the existing settings UI entirely.

- [ ] **Step 2: Build and verify**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/components/DetachedPanel.tsx src/components/ChatListSidebar.tsx
git commit -m "feat: settings opens Obsidian settings modal from detached window"
```

---

### Task 14: Final Integration + Copy to Plugin

- [ ] **Step 1: Run full build and test suite**

Run: `npm run build && npx vitest run`
Expected: Build clean, all tests pass

- [ ] **Step 2: Copy to Obsidian plugin folder**

```bash
cp main.js /Users/jlane/GitHub/Obsidian/.obsidian/plugins/open-brain/main.js
```

- [ ] **Step 3: Test in Obsidian**

1. Reload Obsidian (Cmd+R)
2. Open OpenBrain sidebar
3. Click ↗ detach button → popout window should open with three-panel layout
4. Left panel shows chat history
5. Click "Attach" → choose "Close this window" → sidebar reappears
6. Command palette: "OpenBrain: Detach to window" works

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "feat: detached OpenBrain window — three-panel popout complete"
```
