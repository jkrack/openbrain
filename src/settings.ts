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

    new Setting(containerEl)
      .setName("Claude Code CLI path")
      .setDesc("Path to the claude CLI. Used for all text messages.")
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
      .setDesc("Optional. Only required for voice recording and transcription.")
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
      .setName("Model")
      .setDesc("Claude model for voice transcription (API). Text uses your Claude Code default.")
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

    new Setting(containerEl)
      .setName("Include active note")
      .setDesc("Automatically include active note content as context.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeActiveNote)
          .onChange(async (value) => {
            this.plugin.settings.includeActiveNote = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Allow vault writes")
      .setDesc("Let Claude read and write files in your vault.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowVaultWrite)
          .onChange(async (value) => {
            this.plugin.settings.allowVaultWrite = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Allow CLI execution")
      .setDesc("Let Claude run shell commands.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowCliExec)
          .onChange(async (value) => {
            this.plugin.settings.allowCliExec = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-transcribe on stop")
      .setDesc("Send audio to Claude immediately when recording stops.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.transcribeOnStop)
          .onChange(async (value) => {
            this.plugin.settings.transcribeOnStop = value;
            await this.plugin.saveSettings();
          })
      );

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

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Additional instructions appended to Claude Code's default prompt.")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
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
