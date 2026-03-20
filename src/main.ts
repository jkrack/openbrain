import { addIcon, App, Plugin, TFile, WorkspaceLeaf, Modal, Notice, Setting } from "obsidian";
import { OpenBrainView, OPEN_BRAIN_VIEW_TYPE, RecordingStatus } from "./view";
import { OpenBrainSettings, DEFAULT_SETTINGS, OpenBrainSettingTab } from "./settings";
import { Skill, loadSkills, getDailyNotePath, runSkillInBackground } from "./skills";
import { appendToDailySection } from "./chatHistory";
import { VaultIndex } from "./vaultIndex";
import { initVault } from "./initVault";
import { configure as configureObsidianCli } from "./obsidianCli";
import { encrypt, decrypt } from "./secureStorage";
import { OpenClawNode } from "./openclawNode";
import { logSummary as logPerfSummary } from "./perf";
import { TaskDashboardView, TASK_DASHBOARD_VIEW } from "./taskDashboard";
import { SkillScheduler } from "./scheduler";
import { checkNotifications } from "./notifications";
import { FloatingRecorder } from "./floatingRecorder";

export default class OpenBrainPlugin extends Plugin {
  settings: OpenBrainSettings;
  skills: Skill[] = [];
  vaultIndex: VaultIndex | null = null;
  private statusBarEl: HTMLElement | null = null;
  private openclawNode: OpenClawNode | null = null;
  private scheduler: SkillScheduler | null = null;
  private floatingRecorder: FloatingRecorder | null = null;

  async onload() {
    // Register custom icon: brain with checkmark
    // OpenBrain icon family — consistent brain silhouette across all surfaces
    // Brain with folds + stem, designed for 100x100 Obsidian canvas
    const brainPath = `
      <path d="M50 12 C50 12 42 12 36 18 C30 24 28 32 28 38 C28 44 30 48 28 52 C26 56 22 58 22 64 C22 72 28 78 36 78 L36 82 C36 86 40 88 44 88 L56 88 C60 88 64 86 64 82 L64 78 C72 78 78 72 78 64 C78 58 74 56 72 52 C70 48 72 44 72 38 C72 32 70 24 64 18 C58 12 50 12 50 12Z"/>
      <path d="M50 12 L50 38"/>
      <path d="M50 38 C50 38 38 34 34 42"/>
      <path d="M50 38 C50 38 62 34 66 42"/>
      <path d="M50 52 C50 52 40 50 36 56"/>
      <path d="M50 52 C50 52 60 50 64 56"/>
    `;
    addIcon("openbrain", `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${brainPath}</g>`);
    addIcon("openbrain-tasks", `<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${brainPath}<polyline points="38 62 46 70 64 52" stroke-width="6"/></g>`);

    await this.loadSettings();
    configureObsidianCli(this.settings.obsidianCliPath);
    this.skills = await loadSkills(this.app, this.settings.skillsFolder);

    this.registerView(
      OPEN_BRAIN_VIEW_TYPE,
      (leaf) => {
        const view = new OpenBrainView(leaf, this.settings, this.skills);
        view.plugin = this;
        view.vaultIndex = this.vaultIndex;
        view.onStatusChange = (status) => this.updateStatusBar(status);
        return view;
      }
    );

    // Register task dashboard view
    this.registerView(TASK_DASHBOARD_VIEW, (leaf) => new TaskDashboardView(leaf));

    // Initialize everything once vault is ready
    this.app.workspace.onLayoutReady(async () => {
      await initVault(this.app, this.settings);

      // Load system prompt from file (falls back to settings default)
      await this.loadSystemPrompt();

      // Reload skills now that vault is ready (initial load in onload may have been too early)
      this.skills = await loadSkills(this.app, this.settings.skillsFolder);

      this.vaultIndex = new VaultIndex(this.app);
      this.refreshViews();

      // Start skill scheduler
      this.scheduler = new SkillScheduler(this.app, this.settings);
      this.scheduler.start();

      // Run notification checks
      void checkNotifications(this.app, this.settings);

      // Initialize floating recorder
      this.floatingRecorder = new FloatingRecorder(this.app, this.settings);
      this.floatingRecorder.getSkills = () =>
        this.skills
          .filter((s) => s.input === "audio" || s.input === "auto")
          .map((s) => ({ id: s.id, name: s.name, input: s.input }));
      this.floatingRecorder.onStatusChange = (status) => {
        const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
        if (leaves.length > 0 && leaves[0].view instanceof OpenBrainView) {
          leaves[0].view.setFloatingRecorderStatus(status);
        }
        if (status) {
          void this.activateView();
        }
      };
      this.floatingRecorder.onRecordingComplete = (notePath, skillId) => {
        void this.activateView().then(() => {
          const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
          if (leaves.length > 0 && leaves[0].view instanceof OpenBrainView) {
            leaves[0].view.setInitialAttachedFile(notePath);
            if (skillId && skillId !== "clipboard") {
              // Small delay to let the file attach first
              setTimeout(() => {
                (leaves[0].view as OpenBrainView).activateSkillAndSend(skillId);
              }, 300);
            }
          }
        });
      };
      if (this.floatingRecorder.isAvailable && this.settings.floatingRecorderEnabled) {
        this.floatingRecorder.registerHotkey();
        void this.floatingRecorder.recoverIncompleteSessions();
      }

      // Connect to OpenClaw gateway if enabled
      if (this.settings.openclawEnabled) {
        this.openclawNode = new OpenClawNode(this.app, this.settings);
        this.openclawNode.connect();
      }
    });

    // Keep vault index updated
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.vaultIndex?.update(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.vaultIndex?.update(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.vaultIndex?.remove(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.vaultIndex?.rename(oldPath, file.path);
      })
    );

    this.addRibbonIcon("openbrain", "OpenBrain", () => {
      void this.activateView();
    });

    this.addRibbonIcon("openbrain-tasks", "OpenBrain Tasks", () => {
      const leaves = this.app.workspace.getLeavesOfType(TASK_DASHBOARD_VIEW);
      if (leaves.length > 0) {
        void this.app.workspace.revealLeaf(leaves[0]);
      } else {
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
          void leaf.setViewState({ type: TASK_DASHBOARD_VIEW, active: true });
          void this.app.workspace.revealLeaf(leaf);
        }
      }
    });

    // Status bar item
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("openbrain-status");
    this.updateStatusBar({ recording: false, transcribing: false, duration: 0 });

    this.addCommand({
      id: "open-panel",
      name: "Open panel",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "send-selection",
      name: "Send selection to panel",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        if (selection) {
          void this.activateView(selection);
        }
      },
    });

    this.addCommand({
      id: "toggle-recording",
      name: "Start/stop voice recording",
      icon: "mic",
      callback: () => {
        const view = this.getActiveOpenBrainView();
        if (view) {
          view.toggleRecording();
        } else {
          // Open the panel first, then toggle
          void this.activateView();
        }
      },
    });

    this.addCommand({
      id: "open-chat-history",
      name: "Open chat history",
      callback: () => {
        const basePath = `${this.settings.chatFolder}/Chat History.base`;
        void this.app.workspace.openLinkText(basePath, "");
      },
    });

    this.addCommand({
      id: "resume-chat",
      name: "Resume chat in panel",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        const meta = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (meta?.type !== "openbrain-chat") return false;
        if (checking) return true;

        const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view;
          if (view instanceof OpenBrainView) {
            view.loadChatFromPath(file.path);
            void this.app.workspace.revealLeaf(leaves[0]);
          }
        } else {
          void this.activateView().then(() => {
            const newLeaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
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

    // Quick capture — global hotkey to capture a thought to daily note
    this.addCommand({
      id: "quick-capture",
      name: "Quick capture to daily note",
      callback: () => {
        new QuickCaptureModal(this.app, this.settings).open();
      },
    });

    this.addCommand({
      id: "perf-summary",
      name: "Show performance summary",
      callback: () => {
        logPerfSummary();
        new Notice("Performance summary logged to console (Cmd+Opt+I)");
      },
    });

    // Command to open task dashboard
    this.addCommand({
      id: "open-tasks",
      name: "Open task dashboard",
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(TASK_DASHBOARD_VIEW);
        if (leaves.length > 0) {
          void this.app.workspace.revealLeaf(leaves[0]);
        } else {
          const leaf = this.app.workspace.getRightLeaf(false);
          if (leaf) {
            void leaf.setViewState({ type: TASK_DASHBOARD_VIEW, active: true });
            void this.app.workspace.revealLeaf(leaf);
          }
        }
      },
    });

    // Search chat history
    this.addCommand({
      id: "search-chats",
      name: "Search chat history",
      callback: () => {
        new ChatSearchModal(this.app, this.settings).open();
      },
    });

    this.addCommand({
      id: "toggle-floating-recorder",
      name: "Toggle floating recorder",
      icon: "mic",
      callback: () => {
        if (this.floatingRecorder?.isAvailable) {
          void this.floatingRecorder.toggle();
        } else {
          new Notice("Floating recorder is not available (requires Electron).");
        }
      },
    });

    this.addSettingTab(new OpenBrainSettingTab(this.app, this));

    // Reload skills when files change in skills folder
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path.startsWith(this.settings.skillsFolder)) {
          void (async () => {
            this.skills = await loadSkills(this.app, this.settings.skillsFolder);
            this.refreshViews();
          })();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file.path.startsWith(this.settings.skillsFolder)) {
          void (async () => {
            this.skills = await loadSkills(this.app, this.settings.skillsFolder);
            this.refreshViews();
          })();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file.path.startsWith(this.settings.skillsFolder)) {
          void (async () => {
            this.skills = await loadSkills(this.app, this.settings.skillsFolder);
            this.refreshViews();
          })();
        }
      })
    );

    // Hook: daily-note-created
    // Fires skills with trigger: "daily-note-created" when a new daily note is created.
    // Waits 3 seconds for Templater to process the template first.
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) return;

        const expectedPath = getDailyNotePath(this.app, this.settings);
        if (file.path !== expectedPath) return;

        // Find skills with this trigger
        const triggered = this.skills.filter((s) => s.trigger === "daily-note-created");
        if (triggered.length === 0) return;

        // Wait for Templater to process the template
        setTimeout(() => {
          void (async () => {
            const noteContent = await this.app.vault.read(file);
            for (const skill of triggered) {
              await runSkillInBackground(this.app, this.settings, skill, noteContent);
            }
          })();
        }, 3000);
      })
    );
  }

  private refreshViews() {
    const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof OpenBrainView) {
        const view = leaf.view;
        view.updateSkills(this.skills);
        view.vaultIndex = this.vaultIndex;
        view.rerender();
      }
    }
  }

  private getActiveOpenBrainView(): OpenBrainView | null {
    const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
    if (leaves.length > 0 && leaves[0].view instanceof OpenBrainView) {
      return leaves[0].view;
    }
    return null;
  }

  private updateStatusBar(status: RecordingStatus) {
    if (!this.statusBarEl) return;

    if (status.recording) {
      const mins = Math.floor(status.duration / 60);
      const secs = status.duration % 60;
      const timeStr = `${mins}:${secs.toString().padStart(2, "0")}`;
      this.statusBarEl.setText(`🧠 ⏺ ${timeStr}`);
      this.statusBarEl.addClass("openbrain-recording");
      this.statusBarEl.removeClass("openbrain-transcribing");
    } else if (status.transcribing) {
      this.statusBarEl.setText("🧠 Transcribing...");
      this.statusBarEl.removeClass("openbrain-recording");
      this.statusBarEl.addClass("openbrain-transcribing");
    } else if (this.settings.useLocalStt) {
      this.statusBarEl.setText("🧠 STT");
      this.statusBarEl.removeClass("openbrain-recording");
      this.statusBarEl.removeClass("openbrain-transcribing");
    } else {
      this.statusBarEl.setText("🧠");
      this.statusBarEl.removeClass("openbrain-recording");
      this.statusBarEl.removeClass("openbrain-transcribing");
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
      void workspace.revealLeaf(leaf);
      if (initialPrompt && leaf.view instanceof OpenBrainView) {
        leaf.view.setInitialPrompt(initialPrompt);
      }
    }
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Decrypt API keys on load
    if (this.settings.apiKey) {
      this.settings.apiKey = decrypt(this.settings.apiKey);
    }
    if (this.settings.openrouterApiKey) {
      this.settings.openrouterApiKey = decrypt(this.settings.openrouterApiKey);
    }
  }

  async saveSettings() {
    // Encrypt API keys before saving
    const dataToSave = { ...this.settings };
    if (dataToSave.apiKey) {
      dataToSave.apiKey = encrypt(dataToSave.apiKey);
    }
    if (dataToSave.openrouterApiKey) {
      dataToSave.openrouterApiKey = encrypt(dataToSave.openrouterApiKey);
    }
    await this.saveData(dataToSave);
  }

  private async loadSystemPrompt(): Promise<void> {
    const path = "OpenBrain/system-prompt.md";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const content = await this.app.vault.read(file);
      if (content.trim()) {
        this.settings.systemPrompt = content.trim();
      }
    } else {
      // Seed the file from the current default
      try {
        await this.app.vault.create(path, this.settings.systemPrompt);
      } catch { /* folder may not exist yet — initVault handles it */ }
    }
  }

  onunload() {
    this.scheduler?.stop();
    this.openclawNode?.disconnect();
    this.floatingRecorder?.destroy();
  }
}

// ── Quick Capture Modal ────────────────────────────────────────────────

class QuickCaptureModal extends Modal {
  private settings: OpenBrainSettings;

  constructor(app: App, settings: OpenBrainSettings) {
    super(app);
    this.settings = settings;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ca-quick-capture-modal");
    new Setting(contentEl).setName("Quick capture").setHeading();

    const input = contentEl.createEl("textarea", {
      cls: "ca-quick-capture-input",
      attr: { placeholder: "Capture a thought, task, or note...", rows: "3" },
    });
    input.focus();

    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;

      // Format: if starts with "- [ ]" keep as-is, otherwise bullet it
      const formatted = text.startsWith("- ") ? text : `- ${text}`;

      await appendToDailySection(this.app, formatted, "Capture", this.settings);
      new Notice("Captured to daily note");
      this.close();
    };

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    });

    const btnRow = contentEl.createDiv({ cls: "ca-quick-capture-actions" });
    const btn = btnRow.createEl("button", { text: "Capture", cls: "mod-cta" });
    btn.addEventListener("click", () => void submit());

    btnRow.createEl("span", {
      text: "Cmd+Enter to save",
      cls: "ca-quick-capture-hint",
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Chat Search Modal ──────────────────────────────────────────────────

class ChatSearchModal extends Modal {
  private settings: OpenBrainSettings;

  constructor(app: App, settings: OpenBrainSettings) {
    super(app);
    this.settings = settings;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ca-chat-search-modal");
    new Setting(contentEl).setName("Search chat history").setHeading();

    const input = contentEl.createEl("input", {
      cls: "ca-chat-search-input",
      attr: { type: "text", placeholder: "Search conversations..." },
    });

    const results = contentEl.createDiv({ cls: "ca-chat-search-results" });
    let debounce: ReturnType<typeof setTimeout> | null = null;

    input.addEventListener("input", () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => this.search(input.value, results), 200);
    });

    input.focus();
  }

  private search(query: string, container: HTMLElement) {
    container.empty();
    if (!query.trim()) return;

    const q = query.toLowerCase();
    const folder = this.settings.chatFolder || "OpenBrain/chats";
    const files = this.app.vault.getMarkdownFiles()
      .filter((f: TFile) => f.path.startsWith(folder + "/"));

    // Search frontmatter (title, skill) via metadataCache first
    const matches: { file: TFile; title: string; skill: string; score: number }[] = [];

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (fm?.type !== "openbrain-chat") continue;

      const title = (fm.title || "").toLowerCase();
      const skill = (fm.skill || "").toLowerCase();
      let score = 0;

      if (title.includes(q)) score += 3;
      if (skill.includes(q)) score += 1;
      if (file.basename.includes(q)) score += 1;

      if (score > 0) {
        matches.push({ file, title: fm.title || file.basename, skill: fm.skill || "", score });
      }
    }

    matches.sort((a, b) => b.score - a.score || b.file.stat.mtime - a.file.stat.mtime);

    if (matches.length === 0) {
      // Fall back to full-text search
      void this.fullTextSearch(q, files, container);
      return;
    }

    for (const match of matches.slice(0, 10)) {
      const row = container.createDiv({ cls: "ca-chat-search-row" });
      row.createSpan({ text: match.title, cls: "ca-chat-search-title" });
      row.createSpan({ text: match.skill, cls: "ca-chat-search-skill" });
      row.addEventListener("click", () => {
        void this.app.workspace.openLinkText(match.file.path, "");
        this.close();
      });
    }
  }

  private async fullTextSearch(query: string, files: TFile[], container: HTMLElement) {
    const matches: { file: TFile; title: string; snippet: string }[] = [];

    for (const file of files.slice(0, 50)) {
      const content = await this.app.vault.cachedRead(file);
      const idx = content.toLowerCase().indexOf(query);
      if (idx === -1) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const title = cache?.frontmatter?.title || file.basename;
      const snippet = content.slice(Math.max(0, idx - 30), idx + 60).replace(/\n/g, " ");
      matches.push({ file, title, snippet });
    }

    if (matches.length === 0) {
      container.createDiv({ text: "No matches found", cls: "ca-chat-search-empty" });
      return;
    }

    for (const match of matches.slice(0, 10)) {
      const row = container.createDiv({ cls: "ca-chat-search-row" });
      row.createSpan({ text: match.title, cls: "ca-chat-search-title" });
      row.createSpan({ text: `...${match.snippet}...`, cls: "ca-chat-search-snippet" });
      row.addEventListener("click", () => {
        void this.app.workspace.openLinkText(match.file.path, "");
        this.close();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
