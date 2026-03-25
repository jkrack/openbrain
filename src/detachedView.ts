import { App, ItemView, Modal, Setting, ViewStateResult, WorkspaceLeaf } from "obsidian";
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
  plugin: any = null; // set by main.ts after construction

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

  getViewType(): string { return DETACHED_OPEN_BRAIN_VIEW_TYPE; }
  getDisplayText(): string { return "OpenBrain"; }
  getIcon(): string { return "openbrain"; }

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
    if (!this.plugin) return;
    // Show modal: close this window, or keep both open?
    new AttachModal(this.app, (closePopout: boolean) => {
      if (closePopout) {
        void this.plugin.attachToSidebar(true);
      } else {
        void this.plugin.attachToSidebar(false);
      }
    }).open();
  }

  updateSkills(skills: Skill[]): void {
    this.skills = skills;
    this.rerender();
  }

  getState(): Record<string, unknown> {
    const s = this.chatState.getState();
    return {
      chatPath: s.chatFilePath,
      activeSkillId: s.activeSkillId,
    };
  }

  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    if (state.chatPath && typeof state.chatPath === "string") {
      this.chatState.setChatFilePath(state.chatPath);
    }
    await super.setState(state, result);
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
  }
}

/** Modal for choosing how to re-attach */
class AttachModal extends Modal {
  private callback: (closePopout: boolean) => void;

  constructor(app: App, callback: (closePopout: boolean) => void) {
    super(app);
    this.callback = callback;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName("Attach to sidebar").setHeading();
    contentEl.createEl("p", { text: "How would you like to continue?" });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Close this window").setCta().onClick(() => {
          this.callback(true);
          this.close();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Keep both open").onClick(() => {
          this.callback(false);
          this.close();
        })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
