import { addIcon, App, Platform, Plugin, TFile, WorkspaceLeaf, Modal, Notice, Setting } from "obsidian";
import { OpenBrainView, OPEN_BRAIN_VIEW_TYPE, RecordingStatus } from "./view";
import { DetachedOpenBrainView, DETACHED_OPEN_BRAIN_VIEW_TYPE } from "./detachedView";
import { OpenBrainSettings, DEFAULT_SETTINGS, OpenBrainSettingTab } from "./settings";
import { Skill, loadSkills, getDailyNotePath, runSkillInBackground } from "./skills";
import { appendToDailySection } from "./chatHistory";
import { VaultIndex } from "./vaultIndex";
import { initVault } from "./initVault";
import { encrypt, decrypt } from "./secureStorage";
import { OpenClawNode } from "./openclawNode";
import { logSummary as logPerfSummary } from "./perf";
import { TaskDashboardView, TASK_DASHBOARD_VIEW } from "./taskDashboard";
import { SkillScheduler } from "./scheduler";
import { checkNotifications } from "./notifications";
import { setEmbeddingSearch, setVaultIndex } from "./toolEngine";
import { loadWelcomeCache, refreshWelcomeIfStale } from "./welcomeMessages";
import { inferRelationships, applyRelationships } from "./knowledgeGraph";
import { ChatStateManager } from "./chatStateManager";
import { getDayMode } from "./dayMode";

// Desktop-only modules — imported dynamically to avoid crashing on mobile
// import { configure as configureObsidianCli } from "./obsidianCli";
// import { FloatingRecorder } from "./floatingRecorder";
// import { createEmbeddingEngine } from "./embeddingEngine";
// import { createEmbeddingIndex } from "./embeddingIndex";
// import { createEmbeddingIndexer } from "./embeddingIndexer";
// import { createEmbeddingSearch } from "./embeddingSearch";

export default class OpenBrainPlugin extends Plugin {
  settings: OpenBrainSettings;
  skills: Skill[] = [];
  vaultIndex: VaultIndex | null = null;
  private statusBarEl: HTMLElement | null = null;
  private openclawNode: OpenClawNode | null = null;
  private scheduler: SkillScheduler | null = null;
  private floatingRecorder: any | null = null;
  private embeddingEngine: any | null = null;
  private embeddingIndexer: any | null = null;
  private embeddingStatusBarEl: HTMLElement | null = null;
  private lastEmbeddingProgress: { indexed: number; total: number; status: string } | null = null;
  private graphInferTimers = new Map<string, ReturnType<typeof setTimeout>>();
  chatState: ChatStateManager = new ChatStateManager();

  async onload() {
    // OpenBrain icon — actual Lucide brain outline, scaled for 100x100 canvas
    const s = 4.17; // scale factor: 100/24
    const brainSvg = [
      `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="scale(${s})">`,
      // Left hemisphere
      '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>',
      // Right hemisphere
      '<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>',
      // Central sulcus
      '<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>',
      '</g>',
    ].join("");
    addIcon("openbrain", brainSvg);
    // Task dashboard — Lucide list-checks, visually distinct from brain
    addIcon("openbrain-tasks", [
      `<g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" transform="scale(${s})">`,
      '<path d="m3 17 2 2 4-4"/>',
      '<path d="m3 7 2 2 4-4"/>',
      '<path d="M13 6h8"/>',
      '<path d="M13 12h8"/>',
      '<path d="M13 18h8"/>',
      '</g>',
    ].join(""));

    await this.loadSettings();
    if (Platform.isDesktop) {
      const { configure } = await import("./obsidianCli");
      configure(this.settings.obsidianCliPath);
    }
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

    this.registerView(
      DETACHED_OPEN_BRAIN_VIEW_TYPE,
      (leaf) => {
        const view = new DetachedOpenBrainView(leaf, this.settings, this.skills, this.chatState);
        view.vaultIndex = this.vaultIndex;
        view.plugin = this;
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

      // Load cached welcome messages, then regenerate in background if stale
      await loadWelcomeCache(this.app);
      void refreshWelcomeIfStale(this.app, this.settings, this.skills);

      this.vaultIndex = new VaultIndex(this.app);
      setVaultIndex(this.vaultIndex);
      this.refreshViews();

      // Start skill scheduler
      this.scheduler = new SkillScheduler(this.app, this.settings);
      this.scheduler.start();

      // Run notification checks
      void checkNotifications(this.app, this.settings);

      // Initialize floating recorder (desktop only — requires Electron)
      if (Platform.isDesktopApp) {
        const { FloatingRecorder } = await import("./floatingRecorder");
        this.floatingRecorder = new FloatingRecorder(this.app, this.settings);
        this.floatingRecorder.getSkills = () =>
          this.skills
            .filter((s: Skill) => s.input === "audio" || s.input === "auto")
            .map((s: Skill) => ({ id: s.id, name: s.name, input: s.input }));
        this.floatingRecorder.onStatusChange = (status: string | null) => {
          const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
          if (leaves.length > 0 && leaves[0].view instanceof OpenBrainView) {
            leaves[0].view.setFloatingRecorderStatus(status);
          }
          if (status) {
            // If detached window is open, focus it instead of the sidebar
            const detachedLeaves = this.app.workspace.getLeavesOfType(DETACHED_OPEN_BRAIN_VIEW_TYPE);
            if (detachedLeaves.length > 0) {
              void this.app.workspace.revealLeaf(detachedLeaves[0]);
            } else {
              void this.activateView();
            }
          }
        };
        this.floatingRecorder.onRecordingComplete = (notePath: string, skillId: string) => {
          // If detached window is open, route recording there
          const detachedLeaves = this.app.workspace.getLeavesOfType(DETACHED_OPEN_BRAIN_VIEW_TYPE);
          if (detachedLeaves.length > 0) {
            void this.app.workspace.revealLeaf(detachedLeaves[0]);
            if (notePath) {
              this.chatState.setActiveContext([notePath]);
            }
            if (skillId && skillId !== "clipboard") {
              this.chatState.setActiveSkillId(skillId);
            }
            return;
          }

          // Otherwise use the sidebar
          void this.activateView().then(() => {
            const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
            if (leaves.length > 0 && leaves[0].view instanceof OpenBrainView) {
              leaves[0].view.setInitialAttachedFile(notePath);
              if (skillId && skillId !== "clipboard") {
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
      }

      // Initialize embedding system (desktop only — requires Node.js)
      if (Platform.isDesktop && this.settings.embeddingsEnabled) {
        void this.initEmbeddings();
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
        if (file instanceof TFile) this.embeddingIndexer?.queueFile(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.vaultIndex?.update(file.path);
        if (file instanceof TFile) this.embeddingIndexer?.queueFile(file.path);
        if (file instanceof TFile) this.scheduleGraphInference(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.vaultIndex?.remove(file.path);
        this.embeddingIndexer?.removeFile(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.vaultIndex?.rename(oldPath, file.path);
        this.embeddingIndexer?.removeFile(oldPath);
        this.embeddingIndexer?.queueFile(file.path);
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
      id: "run-graph-enrichment",
      name: "Run knowledge graph enrichment",
      callback: () => {
        if (!this.vaultIndex) {
          new Notice("Vault index not ready");
          return;
        }
        void (async () => {
          new Notice("Running graph enrichment...");
          const chatFolder = this.settings.chatFolder || "OpenBrain/chats";
          const templateFolder = this.settings.templatesFolder || "OpenBrain/templates";
          let count = 0;
          for (const file of this.app.vault.getMarkdownFiles()) {
            if (file.path.startsWith(chatFolder + "/") || file.path.startsWith(templateFolder + "/")) continue;
            const relationships = inferRelationships(this.app, file.path, this.vaultIndex!);
            if (relationships.length > 0) {
              const modified = await applyRelationships(this.app, file.path, relationships);
              if (modified) {
                this.vaultIndex!.update(file.path);
                count++;
              }
            }
          }
          new Notice(`Graph enrichment complete: ${count} notes updated`);
        })();
      },
    });

    if (Platform.isDesktopApp) {
      this.addCommand({
        id: "detach-to-window",
        name: "Detach to window",
        callback: () => void this.detachToWindow(),
      });

      this.addCommand({
        id: "attach-to-sidebar",
        name: "Attach to sidebar",
        callback: () => void this.attachToSidebar(true),
      });
    }

    if (Platform.isDesktopApp) {
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
    }

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

        // Find skills with this trigger, gated by dayMode
        const currentMode = getDayMode(this.settings.workDays);
        const triggered = this.skills.filter((s) => {
          if (s.trigger !== "daily-note-created") return false;
          if (s.dayMode && s.dayMode !== currentMode) return false;
          return true;
        });
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

  private async initEmbeddings(): Promise<void> {
    try {
      const { createEmbeddingEngine } = await import("./embeddingEngine");
      const { createEmbeddingIndex } = await import("./embeddingIndex");
      const { createEmbeddingIndexer } = await import("./embeddingIndexer");
      const { createEmbeddingSearch } = await import("./embeddingSearch");

      this.embeddingEngine = createEmbeddingEngine();

      // Show download progress during model init
      this.updateEmbeddingStatus({ indexed: 0, total: 0, status: "downloading" });
      this.embeddingEngine.onDownloadProgress = (p: any) => {
        if (p.status === "download" && p.total && p.loaded) {
          const mb = (p.loaded / 1024 / 1024).toFixed(1);
          const totalMb = (p.total / 1024 / 1024).toFixed(1);
          const pct = p.loaded / p.total;
          const statusApi = (this as any)._embeddingStatusEl as any;
          statusApi?.setStatus?.("indexing", `Downloading model... ${mb}/${totalMb} MB`, pct);
          if (this.embeddingStatusBarEl) {
            this.embeddingStatusBarEl.setText(`Downloading ${mb}/${totalMb} MB`);
          }
        } else if (p.status === "initiate") {
          const file = p.file?.split("/").pop() || "";
          const statusApi = (this as any)._embeddingStatusEl as any;
          statusApi?.setStatus?.("indexing", `Loading ${file}...`);
        }
      };

      // Timeout after 5 minutes — model download may fail silently
      const initTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Model initialization timed out after 5 minutes")), 300000)
      );

      await Promise.race([
        this.embeddingEngine.init(this.settings.embeddingsModel),
        initTimeout,
      ]);

      // Mark model as downloaded
      const downloaded = this.settings.embeddingsDownloadedModels || [];
      if (!downloaded.includes(this.settings.embeddingsModel)) {
        downloaded.push(this.settings.embeddingsModel);
        this.settings.embeddingsDownloadedModels = downloaded;
        void this.saveSettings();
      }

      const index = createEmbeddingIndex(this.embeddingEngine.getDimensions());
      const indexer = createEmbeddingIndexer(
        this.app, this.embeddingEngine, index, this.settings.embeddingsModel,
        { chatFolder: this.settings.chatFolder, templatesFolder: this.settings.templatesFolder }
      );

      // Pause indexing during recording
      indexer.shouldPause = () =>
        this.floatingRecorder?.isRecording ?? false;

      // Update status bar
      indexer.onProgress = (progress) => {
        this.updateEmbeddingStatus(progress);
      };

      this.embeddingIndexer = indexer;

      // Make search available to tools and smart context
      const search = createEmbeddingSearch(this.embeddingEngine, index);
      setEmbeddingSearch(search);

      // Start indexing
      await indexer.start();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[OpenBrain] Failed to initialize embeddings: ${message}`);
      this.updateEmbeddingStatus({ indexed: 0, total: 0, status: "error" });
      new Notice(`Embedding init failed: ${message}`);
    }
  }

  private updateEmbeddingStatus(progress: { indexed: number; total: number; status: string }): void {
    this.lastEmbeddingProgress = progress;
    // Status bar (bottom of Obsidian)
    if (!this.embeddingStatusBarEl) {
      this.embeddingStatusBarEl = this.addStatusBarItem();
      this.embeddingStatusBarEl.addClass("openbrain-embed-status");
    }

    const vaultTotal = this.app.vault.getMarkdownFiles().length;

    if (progress.status === "indexing") {
      const pct = Math.round((progress.indexed / progress.total) * 100);
      this.embeddingStatusBarEl.setText(`Indexing ${progress.indexed}/${progress.total} (${pct}%)`);
    } else if (progress.status === "ready") {
      this.embeddingStatusBarEl.setText(`${progress.indexed}/${vaultTotal} indexed`);
    } else if (progress.status === "paused") {
      this.embeddingStatusBarEl.setText("Index paused");
    }

    // Settings panel (if open)
    const statusApi = (this as any)._embeddingStatusEl as {
      setStatus?: (state: string, text: string, progress?: number) => void;
    } | undefined;
    if (statusApi?.setStatus) {
      const pct = progress.total > 0 ? progress.indexed / progress.total : 0;
      if (progress.status === "indexing") {
        const remaining = progress.total - progress.indexed;
        statusApi.setStatus("indexing", `Indexing... ${progress.indexed}/${progress.total} notes (${remaining} remaining)`, pct);
      } else if (progress.status === "ready") {
        const skipped = vaultTotal - progress.indexed;
        const skippedText = skipped > 0 ? ` · ${skipped} skipped` : "";
        statusApi.setStatus("ready", `Ready — ${progress.indexed}/${vaultTotal} notes indexed${skippedText}`);
      } else if (progress.status === "paused") {
        statusApi.setStatus("paused", "Paused — recording in progress");
      } else if (progress.status === "downloading") {
        statusApi.setStatus("indexing", "Downloading model...");
      } else if (progress.status === "error") {
        statusApi.setStatus("error", "Indexing failed — check console");
      }
    }
  }

  private scheduleGraphInference(path: string): void {
    if (!this.settings.knowledgeGraphEnabled || !this.settings.knowledgeGraphAutoInfer) return;
    if (!this.vaultIndex) return;

    // Skip chat and template files
    const chatFolder = this.settings.chatFolder || "OpenBrain/chats";
    const templateFolder = this.settings.templatesFolder || "OpenBrain/templates";
    if (path.startsWith(chatFolder + "/") || path.startsWith(templateFolder + "/")) return;

    // Debounce: 5 seconds per file
    const existing = this.graphInferTimers.get(path);
    if (existing) clearTimeout(existing);

    this.graphInferTimers.set(path, setTimeout(() => {
      this.graphInferTimers.delete(path);
      void (async () => {
        if (!this.vaultIndex) return;
        const relationships = inferRelationships(this.app, path, this.vaultIndex);
        if (relationships.length > 0) {
          const modified = await applyRelationships(this.app, path, relationships);
          if (modified) {
            this.vaultIndex.update(path);
          }
        }
      })();
    }, 5000));
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

    // Also refresh detached views
    const detachedLeaves = this.app.workspace.getLeavesOfType(DETACHED_OPEN_BRAIN_VIEW_TYPE);
    for (const leaf of detachedLeaves) {
      if (leaf.view instanceof DetachedOpenBrainView) {
        leaf.view.updateSkills(this.skills);
        leaf.view.vaultIndex = this.vaultIndex;
        leaf.view.rerender();
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
      const decrypted = decrypt(this.settings.apiKey);
      if (Platform.isMobile && !decrypted && data?.apiKey) {
        new Notice("OpenBrain: API key from desktop could not be decrypted. Please re-enter it in Settings.");
      }
      this.settings.apiKey = decrypted;
    }
    if (this.settings.openrouterApiKey) {
      const decrypted = decrypt(this.settings.openrouterApiKey);
      if (Platform.isMobile && !decrypted && data?.openrouterApiKey) {
        new Notice("OpenBrain: OpenRouter API key from desktop could not be decrypted. Please re-enter it in Settings.");
      }
      this.settings.openrouterApiKey = decrypted;
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
    const mode = getDayMode(this.settings.workDays);
    const dayPath = mode === "work"
      ? "OpenBrain/system-prompt-work.md"
      : "OpenBrain/system-prompt-weekend.md";
    const fallbackPath = "OpenBrain/system-prompt.md";

    // Try day-specific file first
    const dayFile = this.app.vault.getAbstractFileByPath(dayPath);
    if (dayFile instanceof TFile) {
      const content = await this.app.vault.read(dayFile);
      if (content.trim()) {
        this.settings.systemPrompt = content.trim();
        return;
      }
    }

    // Fall back to generic system-prompt.md
    const fallbackFile = this.app.vault.getAbstractFileByPath(fallbackPath);
    if (fallbackFile instanceof TFile) {
      const content = await this.app.vault.read(fallbackFile);
      if (content.trim()) {
        this.settings.systemPrompt = content.trim();
        return;
      }
    }

    // Seed the generic file from the current default
    try {
      await this.app.vault.create(fallbackPath, this.settings.systemPrompt);
    } catch { /* folder may not exist yet — initVault handles it */ }
  }

  async detachToWindow(): Promise<void> {
    if (this.chatState.getState().isStreaming) {
      new Notice("Wait for the response to complete before detaching.");
      return;
    }

    // Force-save any pending chat
    this.chatState.trigger("force-save");

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

  async attachToSidebar(closePopout = false): Promise<void> {
    if (this.chatState.getState().isStreaming) {
      new Notice("Wait for the response to complete before attaching.");
      return;
    }

    this.chatState.trigger("force-save");

    await this.activateView();

    if (closePopout) {
      const detachedLeaves = this.app.workspace.getLeavesOfType(DETACHED_OPEN_BRAIN_VIEW_TYPE);
      for (const l of detachedLeaves) {
        l.detach();
      }
    }
  }

  onunload() {
    this.scheduler?.stop();
    this.openclawNode?.disconnect();
    for (const timer of this.graphInferTimers.values()) clearTimeout(timer);
    this.graphInferTimers.clear();
    if (Platform.isDesktop) {
      this.floatingRecorder?.destroy();
      this.embeddingIndexer?.stop();
      this.embeddingEngine?.destroy();
      setEmbeddingSearch(null);
    }
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
