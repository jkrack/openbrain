import { ItemView, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import React from "react";
import { OpenBrainPanel } from "./panel";
import { OpenBrainSettings } from "./settings";
import { Skill } from "./skills";

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
  private toggleRecordingFn: (() => void) | null = null;
  onStatusChange: ((status: RecordingStatus) => void) | null = null;

  currentChatPath: string | null = null;
  private loadNonce = 0;
  private loadChatRequest: LoadChatRequest | undefined;
  plugin: any; // Set by main.ts when creating the view

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
    if (this.plugin?.settings) {
      this.plugin.settings.lastChatPath = path ?? "";
      this.plugin.saveSettings();
    }
  };

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    this.root = createRoot(container);

    // Restore last chat if it exists
    const lastPath = this.plugin?.settings?.lastChatPath;
    if (lastPath && this.app.vault.getAbstractFileByPath(lastPath)) {
      this.loadChatRequest = { path: lastPath, nonce: ++this.loadNonce };
    }

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

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
