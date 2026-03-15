import { App, PluginSettingTab, Setting } from "obsidian";
import OpenBrainPlugin from "./main";

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
  useLocalStt: boolean;
  sttHomePath: string;
  audioDeviceId: string;
  chatFolder: string;
  lastChatPath: string;
  includeRecentChats: boolean;
  showTooltips: boolean;
}

export const DEFAULT_SETTINGS: OpenBrainSettings = {
  apiKey: "",
  claudePath: "claude",
  model: "claude-sonnet-4-20250514",
  maxTokens: 4096,
  systemPrompt: `You are an intelligent assistant embedded in Obsidian. You have access to the user's active note and vault context. Help them think, write, research, and act on their notes. When you receive audio transcriptions, process them naturally as spoken input.`,
  includeActiveNote: true,
  allowVaultWrite: false,
  allowCliExec: false,
  transcribeOnStop: true,
  skillsFolder: "OpenBrain/skills",
  useLocalStt: false,
  sttHomePath: "",
  audioDeviceId: "",
  chatFolder: "OpenBrain/chats",
  lastChatPath: "",
  includeRecentChats: false,
  showTooltips: true, // Default ON for new users
};

export class OpenBrainSettingTab extends PluginSettingTab {
  plugin: OpenBrainPlugin;

  constructor(app: App, plugin: OpenBrainPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Setup ──
    containerEl.createEl("h3", { text: "Setup" });

    new Setting(containerEl)
      .setName("Claude Code CLI")
      .setDesc(
        "Path to the Claude Code CLI. Required for text chat. " +
        "Install from https://docs.anthropic.com/en/docs/claude-code"
      )
      .addText((text) =>
        text
          .setPlaceholder("claude")
          .setValue(this.plugin.settings.claudePath)
          .onChange(async (value) => {
            this.plugin.settings.claudePath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc(
        "Optional. Only needed for voice transcription via API. " +
        "Not required if using local transcription or text-only chat."
      )
      .addText((text) =>
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Voice model")
      .setDesc("Which Claude model to use for voice transcription via API.")
      .addDropdown((drop) =>
        drop
          .addOption("claude-sonnet-4-20250514", "Claude Sonnet 4")
          .addOption("claude-opus-4-20250514", "Claude Opus 4")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Behavior ──
    containerEl.createEl("h3", { text: "Behavior" });

    new Setting(containerEl)
      .setName("Include active note as context")
      .setDesc("Automatically share the note you're viewing with Claude so it can reference your current work.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeActiveNote)
          .onChange(async (value) => {
            this.plugin.settings.includeActiveNote = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-send on recording stop")
      .setDesc("Immediately send audio for transcription when you stop recording. Turn off to review before sending.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.transcribeOnStop)
          .onChange(async (value) => {
            this.plugin.settings.transcribeOnStop = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Custom instructions for Claude. Applied to every conversation unless a skill overrides it.")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Permissions ──
    containerEl.createEl("h3", { text: "Permissions" });
    containerEl.createEl("p", {
      text: "These control what Claude can do. Start with both off and enable as needed.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Allow file editing")
      .setDesc(
        "Let Claude create and edit files in your vault. " +
        "Required for skills that write meeting notes or update daily notes. " +
        "Can also be toggled per-chat from the header."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowVaultWrite)
          .onChange(async (value) => {
            this.plugin.settings.allowVaultWrite = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Allow shell commands")
      .setDesc(
        "Let Claude run terminal commands and use the Obsidian CLI. " +
        "Required for vault search, task queries, and some skills. " +
        "Can also be toggled per-chat from the header."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowCliExec)
          .onChange(async (value) => {
            this.plugin.settings.allowCliExec = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Folders ──
    containerEl.createEl("h3", { text: "Folders" });

    new Setting(containerEl)
      .setName("Skills folder")
      .setDesc("Where skill definitions live. Each .md file in this folder becomes an available skill.")
      .addText((text) =>
        text
          .setPlaceholder("OpenBrain/skills")
          .setValue(this.plugin.settings.skillsFolder)
          .onChange(async (value) => {
            this.plugin.settings.skillsFolder = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Local Speech-to-Text Section ---
    containerEl.createEl("h3", { text: "Local Speech-to-Text" });

    new Setting(containerEl)
      .setName("Use local transcription")
      .setDesc(
        "Transcribe audio locally with sherpa-onnx (free, private, offline). " +
          "Falls back to Anthropic API if not installed."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useLocalStt)
          .onChange(async (value) => {
            this.plugin.settings.useLocalStt = value;
            await this.plugin.saveSettings();
            this.display(); // Re-render to show/hide STT options
          })
      );

    if (this.plugin.settings.useLocalStt) {
      new Setting(containerEl)
        .setName("sherpa-onnx home directory")
        .setDesc(
          "Where binary and model files are stored. Leave empty for default (~/.openbrain)."
        )
        .addText((text) =>
          text
            .setPlaceholder("~/.openbrain")
            .setValue(this.plugin.settings.sttHomePath)
            .onChange(async (value) => {
              this.plugin.settings.sttHomePath = value;
              await this.plugin.saveSettings();
            })
        );

      // Installation status + install button
      const statusEl = containerEl.createDiv({ cls: "ca-stt-status" });
      statusEl.setText("Checking installation...");
      this.renderSttStatus(statusEl);
    }

    // --- Audio Input Section ---
    containerEl.createEl("h3", { text: "Audio Input" });

    const micSetting = new Setting(containerEl)
      .setName("Microphone")
      .setDesc("Select which microphone to use for recording.");

    // Populate mic dropdown asynchronously
    this.populateMicDropdown(micSetting);

    // ── Interface ──
    containerEl.createEl("h3", { text: "Interface" });

    new Setting(containerEl)
      .setName("Show tooltips")
      .setDesc("Display hover text on icons and buttons")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showTooltips)
          .onChange(async (value) => {
            this.plugin.settings.showTooltips = value;
            await this.plugin.saveSettings();
          })
      );

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
  }

  private async renderSttStatus(el: HTMLElement) {
    try {
      const { checkSttInstallation, installStt } = await import("./stt");
      const status = await checkSttInstallation(this.plugin.settings);

      el.empty();

      if (status.ready) {
        el.createSpan({
          text: `Ready — ${status.modelName}`,
          cls: "ca-stt-ready",
        });
      } else {
        const parts: string[] = [];
        if (!status.binaryInstalled) parts.push("Binary not found");
        if (!status.modelInstalled) parts.push("Model not found");
        el.createSpan({ text: parts.join(", "), cls: "ca-stt-missing" });
        el.createEl("br");

        const installBtn = el.createEl("button", {
          text: "Install sherpa-onnx + Parakeet model",
          cls: "mod-cta",
        });

        installBtn.addEventListener("click", async () => {
          installBtn.disabled = true;
          installBtn.setText("Installing...");

          const progressEl = el.createDiv({ cls: "ca-stt-progress" });

          try {
            await installStt(this.plugin.settings, (message) => {
              progressEl.setText(message);
            });

            // Re-render to show updated status
            this.display();
          } catch (err: any) {
            progressEl.setText(`Installation failed: ${err.message}`);
            progressEl.addClass("ca-stt-missing");
            installBtn.disabled = false;
            installBtn.setText("Retry installation");
          }
        });
      }
    } catch (err: any) {
      el.empty();
      el.createSpan({
        text: `Error checking installation: ${err.message}`,
        cls: "ca-stt-missing",
      });
    }
  }

  private async populateMicDropdown(setting: Setting) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");

      setting.addDropdown((drop) => {
        drop.addOption("", "System Default");

        for (const device of audioInputs) {
          const label =
            device.label || `Microphone (${device.deviceId.slice(0, 8)}...)`;
          drop.addOption(device.deviceId, label);
        }

        drop
          .setValue(this.plugin.settings.audioDeviceId)
          .onChange(async (value) => {
            this.plugin.settings.audioDeviceId = value;
            await this.plugin.saveSettings();
          });
      });
    } catch {
      setting.setDesc(
        "Could not enumerate audio devices. Grant microphone permission first."
      );
    }
  }
}
