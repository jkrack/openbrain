import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { OpenBrainView, OPEN_BRAIN_VIEW_TYPE, RecordingStatus } from "./view";
import { OpenBrainSettings, DEFAULT_SETTINGS, OpenBrainSettingTab } from "./settings";
import { Skill, loadSkills, getDailyNotePath, runSkillInBackground } from "./skills";
import { initChatFolder } from "./chatHistory";
import { VaultIndex } from "./vaultIndex";
import { initTemplates } from "./templates";
import { initPeopleFolder } from "./people";
import { configure as configureObsidianCli } from "./obsidianCli";

export default class OpenBrainPlugin extends Plugin {
  settings: OpenBrainSettings;
  skills: Skill[] = [];
  vaultIndex: VaultIndex | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload() {
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

    // Initialize everything once vault is ready
    this.app.workspace.onLayoutReady(async () => {
      // Create folders, templates, and people profiles
      await initChatFolder(this.app, this.settings.chatFolder).catch((e) =>
        console.error("OpenBrain: failed to init chat folder", e)
      );
      await initTemplates(this.app).catch((e) =>
        console.error("OpenBrain: failed to init templates", e)
      );
      await initPeopleFolder(this.app).catch((e) =>
        console.error("OpenBrain: failed to init people folder", e)
      );

      // Build vault metadata index
      this.vaultIndex = new VaultIndex(this.app);
      this.refreshViews();
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

    this.addRibbonIcon("brain", "OpenBrain", () => {
      this.activateView();
    });

    // Status bar item
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("openbrain-status");
    this.updateStatusBar({ recording: false, transcribing: false, duration: 0 });

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
          this.activateView();
        }
      },
    });

    this.addCommand({
      id: "open-chat-history",
      name: "Open chat history",
      callback: () => {
        const basePath = `${this.settings.chatFolder}/Chat History.base`;
        this.app.workspace.openLinkText(basePath, "");
      },
    });

    this.addCommand({
      id: "resume-chat-in-openbrain",
      name: "Resume chat in OpenBrain",
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
            this.app.workspace.revealLeaf(leaves[0]);
          }
        } else {
          this.activateView().then(() => {
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

    // Hook: daily-note-created
    // Fires skills with trigger: "daily-note-created" when a new daily note is created.
    // Waits 3 seconds for Templater to process the template first.
    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        if (!(file instanceof TFile)) return;

        const expectedPath = getDailyNotePath(this.app);
        if (file.path !== expectedPath) return;

        // Find skills with this trigger
        const triggered = this.skills.filter((s) => s.trigger === "daily-note-created");
        if (triggered.length === 0) return;

        // Wait for Templater to process the template
        setTimeout(async () => {
          const noteContent = await this.app.vault.read(file);
          for (const skill of triggered) {
            await runSkillInBackground(this.app, this.settings, skill, noteContent);
          }
        }, 3000);
      })
    );
  }

  private refreshViews() {
    const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof OpenBrainView) {
        const view = leaf.view as OpenBrainView;
        view.updateSkills(this.skills);
        view.vaultIndex = this.vaultIndex;
        view.rerender();
      }
    }
  }

  private getActiveOpenBrainView(): OpenBrainView | null {
    const leaves = this.app.workspace.getLeavesOfType(OPEN_BRAIN_VIEW_TYPE);
    if (leaves.length > 0 && leaves[0].view instanceof OpenBrainView) {
      return leaves[0].view as OpenBrainView;
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
