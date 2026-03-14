# Skill Files Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a skill file system so users can define agent modes as markdown files in their vault, with configurable system prompts, tool permissions, and post-actions that create/modify vault notes.

**Architecture:** Skills are `.md` files in a vault folder (default: `OpenBrain/skills/`). Each file has YAML frontmatter (config) + markdown body (system prompt). OpenBrain scans the folder on load, presents a skill selector in the panel header, and routes the active skill's config into the existing Claude Code CLI pipeline. Post-actions run after Claude responds, using Obsidian's vault API.

**Tech Stack:** TypeScript, React, Obsidian API (`parseYaml`, `vault.create/read/modify`, `moment`)

---

## Chunk 1: Skill Types, Parser, and Settings

### Task 1: Create skill types and parser (`src/skills.ts`)

**Files:**
- Create: `src/skills.ts`

- [ ] **Step 1: Create `src/skills.ts` with types and parser**

```typescript
import { App, TFile, TFolder, parseYaml, moment } from "obsidian";

export interface PostAction {
  type: "create_note" | "append_to_daily" | "replace_in_daily";
  path?: string;
  section?: string;
  content?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  input: "audio" | "text" | "auto";
  tools: { write?: boolean; cli?: boolean };
  autoPrompt?: string;
  postActions: PostAction[];
  systemPrompt: string;
  filePath: string;
}

/**
 * Parse a skill markdown file into a Skill object.
 * Format: YAML frontmatter between --- delimiters, then markdown body.
 */
export function parseSkillFile(content: string, filePath: string): Skill | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = parseYaml(match[1]);
  if (!frontmatter || !frontmatter.name) return null;

  const body = match[2].trim();

  const postActions: PostAction[] = [];
  if (Array.isArray(frontmatter.post_actions)) {
    for (const action of frontmatter.post_actions) {
      if (action.create_note) {
        postActions.push({ type: "create_note", path: action.create_note.path || action.create_note, content: action.create_note.content });
      } else if (action.append_to_daily) {
        postActions.push({ type: "append_to_daily", section: action.append_to_daily.section, content: action.append_to_daily.content });
      } else if (action.replace_in_daily) {
        postActions.push({ type: "replace_in_daily", section: action.replace_in_daily.section, content: action.replace_in_daily.content });
      }
    }
  }

  const id = filePath.replace(/\.md$/, "").replace(/[^a-zA-Z0-9]/g, "-");

  return {
    id,
    name: frontmatter.name,
    description: frontmatter.description || "",
    input: frontmatter.input || "auto",
    tools: frontmatter.tools || {},
    autoPrompt: frontmatter.auto_prompt,
    postActions,
    systemPrompt: body,
    filePath,
  };
}

/**
 * Scan a vault folder for skill markdown files and parse them.
 */
export async function loadSkills(app: App, folderPath: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder)) return skills;

  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") {
      const content = await app.vault.read(child);
      const skill = parseSkillFile(content, child.path);
      if (skill) skills.push(skill);
    }
  }

  return skills;
}
```

- [ ] **Step 2: Run build to verify**

Run: `npm run build`
Expected: Compiles without errors

- [ ] **Step 3: Commit**

```bash
git add src/skills.ts
git commit -m "feat: add skill types and parser"
```

---

### Task 2: Add post-action engine to `src/skills.ts`

**Files:**
- Modify: `src/skills.ts`

- [ ] **Step 1: Add variable substitution and post-action execution**

Append to `src/skills.ts`:

```typescript
/**
 * Substitute template variables in a string.
 * Supported: {{date}}, {{title}}, {{response}}, {{note_path}}
 */
function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || "");
}

/**
 * Extract a title from Claude's response.
 * Looks for first markdown heading, falls back to first non-empty line.
 */
function extractTitle(response: string): string {
  const headingMatch = response.match(/^#{1,6}\s+(.+)/m);
  if (headingMatch) return headingMatch[1].replace(/[/:*?"<>|]/g, "").trim();

  const firstLine = response.split("\n").find((l) => l.trim());
  if (firstLine) return firstLine.slice(0, 60).replace(/[/:*?"<>|]/g, "").trim();

  return "Untitled";
}

/**
 * Find today's daily note. Tries the Obsidian daily notes plugin config,
 * then falls back to common conventions.
 */
function getDailyNotePath(app: App): string {
  // Try to read daily notes plugin config
  const dailyNotes = (app as any).internalPlugins?.getPluginById?.("daily-notes");
  const options = dailyNotes?.instance?.options || {};
  const folder = options.folder || "";
  const format = options.format || "YYYY-MM-DD";

  const dateStr = moment().format(format);
  return folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;
}

/**
 * Insert content under a heading in a markdown document.
 * If the heading doesn't exist, appends it at the end.
 */
function insertUnderHeading(doc: string, heading: string, content: string, replace: boolean): string {
  const headingLevel = (heading.match(/^#+/) || ["##"])[0];
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedHeading}\\s*\\n)([\\s\\S]*?)(?=\\n${headingLevel.replace(/#/g, "\\#")}\\s|$)`, "m");

  const match = doc.match(regex);
  if (match) {
    if (replace) {
      return doc.replace(regex, `$1${content}\n`);
    }
    return doc.replace(regex, `$1$2${content}\n`);
  }

  // Heading not found — append at end
  return `${doc.trimEnd()}\n\n${heading}\n${content}\n`;
}

export interface PostActionResult {
  success: boolean;
  message: string;
}

/**
 * Execute post-actions after a skill completes.
 */
export async function executePostActions(
  app: App,
  actions: PostAction[],
  response: string
): Promise<PostActionResult[]> {
  const results: PostActionResult[] = [];
  const title = extractTitle(response);
  const date = moment().format("YYYY-MM-DD");

  let createdNotePath = "";

  const vars: Record<string, string> = {
    date,
    title,
    response,
    note_path: "",
  };

  for (const action of actions) {
    try {
      if (action.type === "create_note" && action.path) {
        const notePath = substituteVars(action.path, vars);
        const noteContent = action.content ? substituteVars(action.content, vars) : response;

        // Ensure parent folder exists
        const folderPath = notePath.split("/").slice(0, -1).join("/");
        if (folderPath) {
          const folder = app.vault.getAbstractFileByPath(folderPath);
          if (!folder) {
            await app.vault.createFolder(folderPath);
          }
        }

        const existing = app.vault.getAbstractFileByPath(notePath);
        if (existing instanceof TFile) {
          await app.vault.modify(existing, noteContent);
          results.push({ success: true, message: `Updated: ${notePath}` });
        } else {
          await app.vault.create(notePath, noteContent);
          results.push({ success: true, message: `Created: ${notePath}` });
        }

        createdNotePath = notePath;
        vars.note_path = notePath.replace(/\.md$/, "");
      }

      if ((action.type === "append_to_daily" || action.type === "replace_in_daily") && action.section) {
        const dailyPath = getDailyNotePath(app);
        let dailyFile = app.vault.getAbstractFileByPath(dailyPath);

        if (!dailyFile) {
          // Create the daily note if it doesn't exist
          const folderPath = dailyPath.split("/").slice(0, -1).join("/");
          if (folderPath) {
            const folder = app.vault.getAbstractFileByPath(folderPath);
            if (!folder) await app.vault.createFolder(folderPath);
          }
          await app.vault.create(dailyPath, `# ${moment().format("YYYY-MM-DD")}\n`);
          dailyFile = app.vault.getAbstractFileByPath(dailyPath);
        }

        if (dailyFile instanceof TFile) {
          const content = await app.vault.read(dailyFile);
          const insertContent = substituteVars(action.content || "{{response}}", vars);
          const updated = insertUnderHeading(
            content,
            action.section,
            insertContent,
            action.type === "replace_in_daily"
          );
          await app.vault.modify(dailyFile, updated);
          results.push({ success: true, message: `Updated daily note` });
        }
      }
    } catch (err: any) {
      results.push({ success: false, message: `Post-action failed: ${err.message}` });
    }
  }

  return results;
}
```

- [ ] **Step 2: Run build to verify**

Run: `npm run build`
Expected: Compiles without errors

- [ ] **Step 3: Commit**

```bash
git add src/skills.ts
git commit -m "feat: add post-action engine for vault operations"
```

---

### Task 3: Add `skillsFolder` to settings

**Files:**
- Modify: `src/settings.ts:4-26` (interface and defaults)
- Modify: `src/settings.ts:36-138` (settings tab)

- [ ] **Step 1: Add `skillsFolder` to interface and defaults**

In `src/settings.ts`, add `skillsFolder: string` to `OpenBrainSettings` interface after `transcribeOnStop`:

```typescript
export interface OpenBrainSettings {
  apiKey: string;
  claudePath: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  includeActiveNote: boolean;
  allowVaultWrite: boolean;
  allowCliExec: boolean;
  transcribeOnStop: boolean;
  skillsFolder: string;
}
```

Add default:

```typescript
export const DEFAULT_SETTINGS: OpenBrainSettings = {
  // ... existing ...
  transcribeOnStop: true,
  skillsFolder: "OpenBrain/skills",
};
```

- [ ] **Step 2: Add settings UI for `skillsFolder`**

Add after the "Auto-transcribe on stop" setting:

```typescript
    new Setting(containerEl)
      .setName("Skills folder")
      .setDesc("Vault folder containing skill definition files (.md).")
      .addText((text) =>
        text
          .setPlaceholder("OpenBrain/skills")
          .setValue(this.plugin.settings.skillsFolder)
          .onChange(async (value) => {
            this.plugin.settings.skillsFolder = value;
            await this.plugin.saveSettings();
          })
      );
```

- [ ] **Step 3: Run build to verify**

Run: `npm run build`
Expected: Compiles without errors

- [ ] **Step 4: Commit**

```bash
git add src/settings.ts
git commit -m "feat: add skillsFolder setting"
```

---

## Chunk 2: Plugin Wiring and UI

### Task 4: Load skills in plugin lifecycle

**Files:**
- Modify: `src/main.ts`
- Modify: `src/view.ts`

- [ ] **Step 1: Load skills in `main.ts` and pass to view**

Update `src/main.ts`:

```typescript
import { Plugin, WorkspaceLeaf } from "obsidian";
import { OpenBrainView, OPEN_BRAIN_VIEW_TYPE } from "./view";
import { OpenBrainSettings, DEFAULT_SETTINGS, OpenBrainSettingTab } from "./settings";
import { Skill, loadSkills } from "./skills";

export default class OpenBrainPlugin extends Plugin {
  settings: OpenBrainSettings;
  skills: Skill[] = [];

  async onload() {
    await this.loadSettings();
    this.skills = await loadSkills(this.app, this.settings.skillsFolder);

    this.registerView(
      OPEN_BRAIN_VIEW_TYPE,
      (leaf) => new OpenBrainView(leaf, this.settings, this.skills)
    );

    this.addRibbonIcon("brain", "OpenBrain", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-brain",
      name: "Open OpenBrain panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "open-brain-with-selection",
      name: "Send selection to OpenBrain",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        if (selection) {
          this.activateView(selection);
        }
      },
    });

    this.addSettingTab(new OpenBrainSettingTab(this.app, this));

    // Reload skills when files change in skills folder
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (file.path.startsWith(this.settings.skillsFolder)) {
          this.skills = await loadSkills(this.app, this.settings.skillsFolder);
          this.refreshViews();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        if (file.path.startsWith(this.settings.skillsFolder)) {
          this.skills = await loadSkills(this.app, this.settings.skillsFolder);
          this.refreshViews();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        if (file.path.startsWith(this.settings.skillsFolder)) {
          this.skills = await loadSkills(this.app, this.settings.skillsFolder);
          this.refreshViews();
        }
      })
    );
  }

  private refreshViews() {
    const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof OpenBrainView) {
        (leaf.view as OpenBrainView).updateSkills(this.skills);
      }
    }
  }

  async activateView(initialPrompt?: string) {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({
        type: OPEN_BRAIN_VIEW_TYPE,
        active: true,
      });
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
      if (initialPrompt && leaf.view instanceof OpenBrainView) {
        (leaf.view as OpenBrainView).setInitialPrompt(initialPrompt);
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
  }
}
```

- [ ] **Step 2: Update `src/view.ts` to accept and pass skills**

```typescript
import { ItemView, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import React from "react";
import { OpenBrainPanel } from "./panel";
import { OpenBrainSettings } from "./settings";
import { Skill } from "./skills";

export const OPEN_BRAIN_VIEW_TYPE = "open-brain-view";

export class OpenBrainView extends ItemView {
  private root: Root | null = null;
  private settings: OpenBrainSettings;
  private skills: Skill[];
  private initialPrompt: string | undefined;

  constructor(leaf: WorkspaceLeaf, settings: OpenBrainSettings, skills: Skill[]) {
    super(leaf);
    this.settings = settings;
    this.skills = skills;
  }

  getViewType(): string {
    return OPEN_BRAIN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "OpenBrain";
  }

  getIcon(): string {
    return "brain";
  }

  setInitialPrompt(prompt: string) {
    this.initialPrompt = prompt;
    this.rerender();
  }

  updateSkills(skills: Skill[]) {
    this.skills = skills;
    this.rerender();
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.root = createRoot(container);
    this.rerender();
  }

  rerender() {
    if (!this.root) return;

    this.root.render(
      React.createElement(OpenBrainPanel, {
        settings: this.settings,
        app: this.app,
        initialPrompt: this.initialPrompt,
        component: this,
        skills: this.skills,
      })
    );
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
```

- [ ] **Step 3: Run build to verify**

Run: `npm run build`
Expected: May fail — `panel.tsx` doesn't accept `skills` prop yet. That's expected and fixed in next task.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts src/view.ts
git commit -m "feat: load skills on startup and pass to view"
```

---

### Task 5: Skill selector UI and wiring in panel

**Files:**
- Modify: `src/panel.tsx`
- Modify: `styles.css`

- [ ] **Step 1: Add skill selector and wire active skill into panel**

Update `src/panel.tsx`. Key changes:
1. Accept `skills` prop
2. Add `activeSkillId` state
3. Derive effective system prompt, tool overrides, and auto-prompt from active skill
4. Add skill selector dropdown in header
5. Execute post-actions on response completion

```typescript
import React, { useState, useRef, useEffect, useCallback } from "react";
import { Message, streamClaudeCode, streamClaudeAPI, transcribeAudioSegments } from "./claude";
import { useAudioRecorder, formatDuration } from "./useAudioRecorder";
import { OpenBrainSettings } from "./settings";
import { Skill, executePostActions, PostActionResult } from "./skills";
import { App, Component, MarkdownRenderer } from "obsidian";
import { ChildProcess } from "child_process";

interface PanelProps {
  settings: OpenBrainSettings;
  app: App;
  initialPrompt?: string;
  component: Component;
  skills: Skill[];
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function MarkdownBlock({
  markdown,
  app,
  component,
}: {
  markdown: string;
  app: App;
  component: Component;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const timeout = setTimeout(() => {
      el.empty();
      MarkdownRenderer.render(app, markdown, el, "", component);
    }, 50);

    return () => clearTimeout(timeout);
  }, [markdown, app, component]);

  return <div ref={containerRef} className="ca-markdown" />;
}

export function OpenBrainPanel({ settings, app, initialPrompt, component, skills }: PanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(initialPrompt || "");
  const [isStreaming, setIsStreaming] = useState(false);
  const [noteContext, setNoteContext] = useState<string | undefined>();
  const [allowWrite, setAllowWrite] = useState(settings.allowVaultWrite);
  const [allowCli, setAllowCli] = useState(settings.allowCliExec);
  const [audioPrompt, setAudioPrompt] = useState("");
  const [showAudioPrompt, setShowAudioPrompt] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [showSkillMenu, setShowSkillMenu] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<boolean>(false);
  const procRef = useRef<ChildProcess | null>(null);
  const responseRef = useRef<string>("");

  const recorder = useAudioRecorder();

  const activeSkill = skills.find((s) => s.id === activeSkillId) || null;

  // Effective settings with skill overrides
  const effectiveWrite = activeSkill?.tools.write ?? allowWrite;
  const effectiveCli = activeSkill?.tools.cli ?? allowCli;
  const effectiveSystemPrompt = activeSkill?.systemPrompt || settings.systemPrompt;

  // Apply tool overrides when skill changes
  useEffect(() => {
    if (activeSkill) {
      if (activeSkill.tools.write !== undefined) setAllowWrite(activeSkill.tools.write);
      if (activeSkill.tools.cli !== undefined) setAllowCli(activeSkill.tools.cli);
    }
  }, [activeSkillId]);

  // Pre-fill auto_prompt when skill changes
  useEffect(() => {
    if (activeSkill?.autoPrompt) {
      setInput(activeSkill.autoPrompt);
    }
  }, [activeSkillId]);

  // Load active note context
  useEffect(() => {
    const loadNote = async () => {
      if (!settings.includeActiveNote) return;
      const file = app.workspace.getActiveFile();
      if (!file) return;
      const content = await app.vault.read(file);
      setNoteContext(content);
    };
    loadNote();

    const ref = app.workspace.on("active-leaf-change", loadNote);
    return () => app.workspace.offref(ref);
  }, [app, settings.includeActiveNote]);

  // Set initial prompt from outside
  useEffect(() => {
    if (initialPrompt) setInput(initialPrompt);
  }, [initialPrompt]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages]);

  const appendAssistantChunk = useCallback((id: string, chunk: string) => {
    responseRef.current += chunk;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m
      )
    );
  }, []);

  const runPostActions = useCallback(async () => {
    if (!activeSkill || activeSkill.postActions.length === 0) return;

    const response = responseRef.current;
    if (!response.trim()) return;

    const results = await executePostActions(app, activeSkill.postActions, response);

    // Add post-action feedback as a system message
    const feedback = results
      .map((r) => (r.success ? `✓ ${r.message}` : `✗ ${r.message}`))
      .join("\n");

    if (feedback) {
      const feedbackMsg: Message = {
        id: generateId(),
        role: "assistant",
        content: `---\n${feedback}`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, feedbackMsg]);
    }
  }, [activeSkill, app]);

  const sendMessage = useCallback(
    async (userText: string, audioSegments?: Blob[]) => {
      if (isStreaming) return;
      if (!userText.trim() && !audioSegments?.length) return;

      const hasAudioInput = audioSegments && audioSegments.length > 0;

      const userMsg: Message = {
        id: generateId(),
        role: "user",
        content: hasAudioInput ? `🎙 ${userText || "Voice message"}` : userText,
        isAudio: !!hasAudioInput,
        timestamp: new Date(),
      };

      const assistantId = generateId();
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput("");
      setIsStreaming(true);
      abortRef.current = false;
      responseRef.current = "";

      const callbacks = {
        onChunk: (chunk: string) => {
          if (!abortRef.current) appendAssistantChunk(assistantId, chunk);
        },
        onError: (err: string) => {
          setIsStreaming(false);
          procRef.current = null;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Error: ${err}` }
                : m
            )
          );
        },
      };

      const audioDone = async () => {
        setIsStreaming(false);
        recorder.clearAudio();
        setAudioPrompt("");
        setShowAudioPrompt(false);
        await runPostActions();
      };

      if (hasAudioInput && audioSegments.length > 1) {
        await transcribeAudioSegments(settings, {
          ...callbacks,
          segments: audioSegments,
          systemPrompt: effectiveSystemPrompt,
          noteContext,
          audioPrompt: audioPrompt || undefined,
          onProgress: (current, total) => {
            if (!abortRef.current) {
              appendAssistantChunk(assistantId, current === 1 ? `Transcribing segment ${current}/${total}...\n` : "");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: `Transcribing segment ${current}/${total}...` }
                    : m
                )
              );
            }
          },
          onDone: audioDone,
        });
      } else if (hasAudioInput) {
        await streamClaudeAPI(settings, {
          ...callbacks,
          messages: [...messages, userMsg],
          systemPrompt: effectiveSystemPrompt,
          noteContext,
          audioBlob: audioSegments[0],
          audioPrompt: audioPrompt || "Transcribe this audio. If there are action items or key points, note them after the transcription.",
          onDone: audioDone,
        });
      } else {
        const proc = streamClaudeCode(settings, {
          ...callbacks,
          prompt: userText,
          noteContext,
          systemPrompt: effectiveSystemPrompt,
          sessionId,
          allowWrite: effectiveWrite,
          allowCli: effectiveCli,
          onDone: async (newSessionId?: string) => {
            setIsStreaming(false);
            procRef.current = null;
            if (newSessionId) setSessionId(newSessionId);
            recorder.clearAudio();
            setAudioPrompt("");
            setShowAudioPrompt(false);
            await runPostActions();
          },
        });
        procRef.current = proc;
      }
    },
    [isStreaming, messages, settings, noteContext, audioPrompt, appendAssistantChunk, recorder, sessionId, effectiveWrite, effectiveCli, effectiveSystemPrompt, runPostActions]
  );

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleMicClick = async () => {
    if (recorder.state === "recording") {
      const segs = await recorder.stopRecording();
      if (segs.length > 0 && settings.transcribeOnStop) {
        sendMessage(audioPrompt || "Voice message", segs);
      }
    } else {
      await recorder.startRecording();
    }
  };

  const handleSendAudio = async () => {
    if (recorder.audioSegments.length > 0) {
      sendMessage(audioPrompt || "Voice message", recorder.audioSegments);
    }
  };

  const clearConversation = () => {
    setMessages([]);
    setSessionId(undefined);
    abortRef.current = true;
    if (procRef.current) {
      procRef.current.kill();
      procRef.current = null;
    }
    setIsStreaming(false);
  };

  const selectSkill = (skillId: string | null) => {
    setActiveSkillId(skillId);
    setShowSkillMenu(false);
    // Reset session when switching skills
    setSessionId(undefined);
    setMessages([]);
  };

  const isRecording = recorder.state === "recording";
  const hasAudio = recorder.audioSegments.length > 0 && recorder.state === "idle";

  return (
    <div className="claude-agent-panel">
      {/* Header */}
      <div className="ca-header">
        <div className="ca-header-left">
          <span className="ca-title">OpenBrain</span>
          {noteContext && (
            <span className="ca-note-badge" title="Active note loaded">
              note
            </span>
          )}
          {sessionId && (
            <span className="ca-note-badge" title="Session active">
              session
            </span>
          )}
        </div>
        <div className="ca-header-right">
          {skills.length > 0 && (
            <div className="ca-skill-selector">
              <button
                className={`ca-tool-btn ${activeSkill ? "active" : ""}`}
                onClick={() => setShowSkillMenu((v) => !v)}
                title={activeSkill?.description || "Select skill"}
              >
                {activeSkill?.name || "General"}
              </button>
              {showSkillMenu && (
                <div className="ca-skill-menu">
                  <button
                    className={`ca-skill-option ${!activeSkill ? "active" : ""}`}
                    onClick={() => selectSkill(null)}
                  >
                    General
                  </button>
                  {skills.map((skill) => (
                    <button
                      key={skill.id}
                      className={`ca-skill-option ${activeSkillId === skill.id ? "active" : ""}`}
                      onClick={() => selectSkill(skill.id)}
                      title={skill.description}
                    >
                      {skill.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            className={`ca-tool-btn ${effectiveWrite ? "active" : ""}`}
            onClick={() => setAllowWrite((v) => !v)}
            title="Allow file read/write"
          >
            write
          </button>
          <button
            className={`ca-tool-btn ${effectiveCli ? "active" : ""}`}
            onClick={() => setAllowCli((v) => !v)}
            title="Allow shell commands"
          >
            cli
          </button>
          <button className="ca-icon-btn" onClick={clearConversation} title="Clear conversation">
            ↺
          </button>
        </div>
      </div>

      {/* Message thread */}
      <div className="ca-thread" ref={threadRef}>
        {messages.length === 0 && (
          <div className="ca-empty">
            <div className="ca-empty-icon">◈</div>
            <div className="ca-empty-text">
              {activeSkill ? activeSkill.description || activeSkill.name : "Ask anything about your vault"}
            </div>
            <div className="ca-empty-sub">Powered by Claude Code</div>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`ca-msg ca-msg--${msg.role}`}>
            <div className="ca-msg-content">
              {msg.isAudio && <span className="ca-audio-tag">🎙 </span>}
              {msg.role === "assistant" ? (
                <>
                  <MarkdownBlock
                    markdown={msg.content}
                    app={app}
                    component={component}
                  />
                  {msg.content === "" && isStreaming && (
                    <span className="ca-cursor" />
                  )}
                </>
              ) : (
                <span className="ca-msg-text">{msg.content}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Waveform / recording state */}
      {isRecording && (
        <div className="ca-waveform">
          <span className="ca-rec-dot" />
          <div className="ca-bars">
            {recorder.waveformData.map((v, i) => (
              <div
                key={i}
                className="ca-bar"
                style={{ height: `${Math.max(3, v * 32)}px` }}
              />
            ))}
          </div>
          <span className="ca-rec-time">
            {formatDuration(recorder.duration)}
            {recorder.segmentCount > 0 && ` (${recorder.segmentCount + 1} segments)`}
          </span>
        </div>
      )}

      {/* Audio ready state */}
      {hasAudio && !isRecording && (
        <div className="ca-audio-ready">
          <span className="ca-audio-ready-label">
            Recording ready — {formatDuration(recorder.duration)}
            {recorder.audioSegments.length > 1 && ` (${recorder.audioSegments.length} segments)`}
          </span>
          <div className="ca-audio-actions">
            {showAudioPrompt && (
              <input
                className="ca-audio-prompt-input"
                placeholder="Instructions (optional)"
                value={audioPrompt}
                onChange={(e) => setAudioPrompt(e.target.value)}
                autoFocus
              />
            )}
            <button
              className="ca-icon-btn"
              onClick={() => setShowAudioPrompt((v) => !v)}
              title="Add instructions"
            >
              ✎
            </button>
            <button className="ca-icon-btn" onClick={recorder.clearAudio} title="Discard">
              ✕
            </button>
            <button className="ca-send-btn" onClick={handleSendAudio} disabled={isStreaming}>
              Send
            </button>
          </div>
        </div>
      )}

      {/* Input row */}
      <div className="ca-input-row">
        <textarea
          ref={inputRef}
          className="ca-input"
          placeholder={isRecording ? "Recording..." : activeSkill?.autoPrompt ? "Press enter to run..." : "Ask anything..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isRecording || isStreaming}
          rows={1}
        />
        <button
          className={`ca-mic-btn ${isRecording ? "recording" : ""} ${recorder.state === "processing" ? "processing" : ""}`}
          onClick={handleMicClick}
          disabled={isStreaming || recorder.state === "processing"}
          title={isRecording ? "Stop recording" : "Start recording"}
        >
          {recorder.state === "processing" ? "…" : isRecording ? "■" : "⏺"}
        </button>
        <button
          className="ca-send-btn"
          onClick={handleSend}
          disabled={isStreaming || isRecording || !input.trim()}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add skill selector CSS to `styles.css`**

Append to `styles.css`:

```css
/* Skill selector */
.ca-skill-selector {
  position: relative;
}

.ca-skill-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  padding: 4px;
  min-width: 140px;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.ca-skill-option {
  display: block;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  color: var(--text-normal);
  font-size: 12px;
  text-align: left;
  border-radius: 4px;
  cursor: pointer;
}

.ca-skill-option:hover {
  background: var(--background-modifier-hover);
}

.ca-skill-option.active {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
```

- [ ] **Step 3: Run build to verify**

Run: `npm run build`
Expected: Compiles without errors

- [ ] **Step 4: Copy build to Obsidian plugins**

Run: `cp main.js manifest.json styles.css ~/GitHub/Obsidian/.obsidian/plugins/open-brain/`

- [ ] **Step 5: Commit**

```bash
git add src/panel.tsx styles.css
git commit -m "feat: add skill selector UI with post-action integration"
```

---

## Chunk 3: Example Skills and Verification

### Task 6: Create example skill files in vault

**Files:**
- Create: In Obsidian vault at `OpenBrain/skills/meeting-agent.md`
- Create: In Obsidian vault at `OpenBrain/skills/morning-briefing.md`

- [ ] **Step 1: Create the skills folder and meeting agent skill**

Create `~/GitHub/Obsidian/OpenBrain/skills/meeting-agent.md`:

```markdown
---
name: Meeting Agent
description: Transcribe meetings into structured notes
input: audio
tools:
  write: true
  cli: false
post_actions:
  - create_note:
      path: "Meetings/{{date}}-{{title}}.md"
  - append_to_daily:
      section: "## Meetings"
      content: "- [[{{note_path}}]]"
---

You are a meeting transcription agent. Given audio recordings of a meeting:

1. Transcribe the conversation faithfully
2. Identify speakers when possible
3. Extract:
   - **Attendees** (if mentioned)
   - **Key Decisions**
   - **Action Items** with owners
4. Format output using this structure:

## Meeting: [Title]
**Date:** [Date]
**Attendees:** ...

### Key Decisions
- ...

### Action Items
- [ ] Owner: Task description

### Discussion Summary
...
```

- [ ] **Step 2: Create morning briefing skill**

Create `~/GitHub/Obsidian/OpenBrain/skills/morning-briefing.md`:

```markdown
---
name: Morning Briefing
description: Prep today's daily note with priorities
input: text
auto_prompt: "Generate my morning briefing for today based on my recent notes and open tasks."
tools:
  write: true
  cli: false
post_actions:
  - replace_in_daily:
      section: "## Focus"
      content: "{{response}}"
---

You are a daily briefing agent embedded in Obsidian. The user's active note is their daily note.

1. Review the note content for any existing tasks or context
2. Generate a concise morning briefing with:
   - Top 3 priorities for today
   - Any carry-over tasks from previous context
   - Quick suggestions based on the note structure
3. Keep it concise — bullet points, not paragraphs
4. Use markdown formatting that works well in Obsidian
```

- [ ] **Step 3: Verify skills load**

Reload Obsidian (Cmd+R). Open the OpenBrain panel. Check that the skill selector appears in the header showing "General" with a dropdown containing "Meeting Agent" and "Morning Briefing".

- [ ] **Step 4: Test skill activation**

1. Select "Morning Briefing" from the dropdown
2. Verify the input pre-fills with the auto_prompt
3. Verify the empty state shows the skill description
4. Send the message and verify the skill's system prompt is used

- [ ] **Step 5: Commit example skills**

```bash
git add docs/
git commit -m "docs: add example skill files and implementation plan"
```
