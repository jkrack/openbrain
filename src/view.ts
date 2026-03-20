import { ItemView, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import React from "react";
import { OpenBrainPanel } from "./panel";
import { OpenBrainSettings } from "./settings";
import { Skill } from "./skills";
import { VaultIndex } from "./vaultIndex";

export const OPEN_BRAIN_VIEW_TYPE = "open-brain-view";

export interface RecordingStatus {
  recording: boolean;
  transcribing: boolean;
  duration: number;
}

export interface LoadChatRequest {
  path: string;
  nonce: number;
}

export class OpenBrainView extends ItemView {
  private root: Root | null = null;
  private settings: OpenBrainSettings;
  private skills: Skill[];
  private initialPrompt: string | undefined;
  private initialAttachedFile: string | undefined;
  private floatingRecorderStatus: string | null = null;
  private toggleRecordingFn: (() => void) | null = null;
  onStatusChange: ((status: RecordingStatus) => void) | null = null;

  currentChatPath: string | null = null;
  private loadNonce = 0;
  private loadChatRequest: LoadChatRequest | undefined;
  plugin: { settings: { lastChatPath: string }; saveSettings: () => Promise<void> } | null = null;
  vaultIndex: VaultIndex | null = null;

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
    return "openbrain";
  }

  setInitialPrompt(prompt: string) {
    this.initialPrompt = prompt;
    this.rerender();
  }

  setInitialAttachedFile(path: string) {
    this.initialAttachedFile = path;
    this.rerender();
  }

  setFloatingRecorderStatus(status: string | null) {
    this.floatingRecorderStatus = status;
    this.rerender();
  }

  /** Activate a skill and auto-send with the attached file */
  activateSkillAndSend(skillId: string) {
    this.pendingSkillSend = skillId;
    this.rerender();
  }

  private pendingSkillSend: string | null = null;

  updateSkills(skills: Skill[]) {
    this.skills = skills;
    this.rerender();
  }

  toggleRecording() {
    if (this.toggleRecordingFn) {
      this.toggleRecordingFn();
    }
  }

  loadChatFromPath(path: string): void {
    this.loadNonce++;
    this.loadChatRequest = { path, nonce: this.loadNonce };
    this.rerender();
  }

  private handleChatPathChange = (path: string | null): void => {
    this.currentChatPath = path;
    if (this.plugin) {
      this.plugin.settings.lastChatPath = path ?? "";
      void this.plugin.saveSettings();
    }
  };

  // eslint-disable-next-line @typescript-eslint/require-await -- base class requires Promise<void> return type
  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.root = createRoot(container);

    // Start fresh on open — conversations are saved in chat history
    // and can be resumed via "Resume chat in OpenBrain" command

    this.rerender();
  }

  rerender() {
    if (!this.root) return;

    this.root.render(
      React.createElement(OpenBrainPanel, {
        settings: this.settings,
        app: this.app,
        initialPrompt: this.initialPrompt,
        initialAttachedFile: this.initialAttachedFile,
        floatingRecorderStatus: this.floatingRecorderStatus,
        pendingSkillSend: this.pendingSkillSend,
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
        vaultIndex: this.vaultIndex,
      })
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- base class requires Promise<void> return type
  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
