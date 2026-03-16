import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { execSync } from "child_process";
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
  dailyNoteFolder: string;
  dailyNoteFormat: string;
  obsidianCliPath: string;
  onboardingComplete: boolean;
  openclawEnabled: boolean;
  openclawGatewayUrl: string;
  chatProvider: "anthropic" | "openrouter";
  openrouterApiKey: string;
  openrouterModel: string;
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
  dailyNoteFolder: "Daily/{{YYYY}}/{{MM}}",
  dailyNoteFormat: "YYYY-MM-DD",
  obsidianCliPath: "obsidian",
  onboardingComplete: false,
  openclawEnabled: false,
  openclawGatewayUrl: "ws://127.0.0.1:18789",
  chatProvider: "anthropic",
  openrouterApiKey: "",
  openrouterModel: "anthropic/claude-sonnet-4-20250514",
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
    new Setting(containerEl).setName("Setup").setHeading();

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
          .onChange((value) => { void (async () => {
            this.plugin.settings.claudePath = value;
            await this.plugin.saveSettings();
            // Validate the path
            try {
              const home = process.env.HOME || "";
              const env = {
                ...process.env,
                PATH: ["/usr/local/bin", "/opt/homebrew/bin", `${home}/.local/bin`, `${home}/.nvm/versions/node`, process.env.PATH].filter(Boolean).join(":"),
              };
              execSync(`${value || "claude"} --version`, { timeout: 5000, encoding: "utf-8", env });
            } catch { /* expected — CLI may not be installed */
              new Notice("Claude Code CLI not found at this path.");
            }
          })(); })
      );

    new Setting(containerEl)
      .setName("Obsidian CLI path")
      .setDesc(
        "Path to the Obsidian CLI. Enable it in Obsidian Settings → General → Command line interface. " +
        "Used for vault search, task queries, and daily note management."
      )
      .addText((text) =>
        text
          .setPlaceholder("obsidian")
          .setValue(this.plugin.settings.obsidianCliPath)
          .onChange((value) => { void (async () => {
            this.plugin.settings.obsidianCliPath = value || "obsidian";
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc(
        "Optional. Only needed for voice transcription via API. " +
        "Not required if using local transcription or text-only chat. " +
        "Encrypted using your system keychain when available."
      )
      .addText((text) => {
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange((value) => { void (async () => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })(); });
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        return text;
      }
      );

    new Setting(containerEl)
      .setName("Voice model")
      .setDesc("Which Claude model to use for voice transcription via API.")
      .addDropdown((drop) =>
        drop
          .addOption("claude-sonnet-4-20250514", "Claude Sonnet 4")
          .addOption("claude-opus-4-20250514", "Claude Opus 4")
          .setValue(this.plugin.settings.model)
          .onChange((value) => { void (async () => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })(); })
      );

    // ── Chat Mode Provider ──
    new Setting(containerEl).setName("Chat mode").setHeading();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which API to use for Chat mode conversations and image analysis.")
      .addDropdown((drop) =>
        drop
          .addOption("anthropic", "Anthropic (Claude)")
          .addOption("openrouter", "OpenRouter (any model)")
          .setValue(this.plugin.settings.chatProvider)
          .onChange((value) => { void (async () => {
            this.plugin.settings.chatProvider = value as "anthropic" | "openrouter";
            await this.plugin.saveSettings();
            this.display();
          })(); })
      );

    if (this.plugin.settings.chatProvider === "openrouter") {
      new Setting(containerEl)
        .setName("OpenRouter API key")
        .setDesc("Get one at openrouter.ai/keys")
        .addText((text) => {
          text
            .setPlaceholder("sk-or-...")
            .setValue(this.plugin.settings.openrouterApiKey)
            .onChange((value) => { void (async () => {
              this.plugin.settings.openrouterApiKey = value;
              await this.plugin.saveSettings();
            })(); });
          text.inputEl.type = "password";
          text.inputEl.autocomplete = "off";
          return text;
        });

      new Setting(containerEl)
        .setName("Model")
        .setDesc(
          "OpenRouter model ID. Examples: anthropic/claude-sonnet-4-20250514, " +
          "openai/gpt-4o, google/gemini-2.5-pro, meta-llama/llama-4-maverick"
        )
        .addText((text) =>
          text
            .setPlaceholder("anthropic/claude-sonnet-4-20250514")
            .setValue(this.plugin.settings.openrouterModel)
            .onChange((value) => { void (async () => {
              this.plugin.settings.openrouterModel = value;
              await this.plugin.saveSettings();
            })(); })
        );
    }

    // ── Behavior ──
    new Setting(containerEl).setName("Behavior").setHeading();

    new Setting(containerEl)
      .setName("Include active note as context")
      .setDesc("Automatically share the note you're viewing with Claude so it can reference your current work.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeActiveNote)
          .onChange((value) => { void (async () => {
            this.plugin.settings.includeActiveNote = value;
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("Auto-send on recording stop")
      .setDesc("Immediately send audio for transcription when you stop recording. Turn off to review before sending.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.transcribeOnStop)
          .onChange((value) => { void (async () => {
            this.plugin.settings.transcribeOnStop = value;
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Custom instructions for Claude. Applied to every conversation unless a skill overrides it.")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.systemPrompt)
          .onChange((value) => { void (async () => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          })(); })
      );

    // ── Permissions ──
    new Setting(containerEl).setName("Permissions").setHeading();
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
          .onChange((value) => { void (async () => {
            this.plugin.settings.allowVaultWrite = value;
            await this.plugin.saveSettings();
          })(); })
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
          .onChange((value) => { void (async () => {
            this.plugin.settings.allowCliExec = value;
            await this.plugin.saveSettings();
          })(); })
      );

    // ── Folders ──
    new Setting(containerEl).setName("Folders").setHeading();

    new Setting(containerEl)
      .setName("Skills folder")
      .setDesc("Where skill definitions live. Each .md file in this folder becomes an available skill.")
      .addText((text) =>
        text
          .setPlaceholder("OpenBrain/skills")
          .setValue(this.plugin.settings.skillsFolder)
          .onChange((value) => { void (async () => {
            this.plugin.settings.skillsFolder = value;
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("Daily note folder")
      .setDesc(
        "Where daily notes are created. Supports date variables: {{YYYY}}, {{MM}}, {{DD}}. " +
        "Example: Daily/{{YYYY}}/{{MM}} creates notes like 0. Daily/2026/03/2026-03-15.md"
      )
      .addText((text) =>
        text
          .setPlaceholder("Daily/{{YYYY}}/{{MM}}")
          .setValue(this.plugin.settings.dailyNoteFolder)
          .onChange((value) => { void (async () => {
            this.plugin.settings.dailyNoteFolder = value;
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("Daily note filename format")
      .setDesc(
        "Date format for the daily note filename (without .md). Uses moment.js format tokens: " +
        "YYYY (year), MM (month), DD (day), ddd (short day name)."
      )
      .addText((text) =>
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(this.plugin.settings.dailyNoteFormat)
          .onChange((value) => { void (async () => {
            this.plugin.settings.dailyNoteFormat = value;
            await this.plugin.saveSettings();
          })(); })
      );

    // --- Local Speech-to-Text Section ---
    new Setting(containerEl).setName("Local speech-to-text").setHeading();

    new Setting(containerEl)
      .setName("Use local transcription")
      .setDesc(
        "Transcribe audio locally with sherpa-onnx (free, private, offline). " +
          "Falls back to Anthropic API if not installed."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useLocalStt)
          .onChange((value) => { void (async () => {
            this.plugin.settings.useLocalStt = value;
            await this.plugin.saveSettings();
            this.display(); // Re-render to show/hide STT options
          })(); })
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
            .onChange((value) => { void (async () => {
              this.plugin.settings.sttHomePath = value;
              await this.plugin.saveSettings();
            })(); })
        );

      // Installation status + install button
      const statusEl = containerEl.createDiv({ cls: "ca-stt-status" });
      statusEl.setText("Checking installation...");
      void this.renderSttStatus(statusEl);
    }

    // --- Audio Input Section ---
    new Setting(containerEl).setName("Audio input").setHeading();

    const micSetting = new Setting(containerEl)
      .setName("Microphone")
      .setDesc("Select which microphone to use for recording.");

    // Populate mic dropdown asynchronously
    void this.populateMicDropdown(micSetting);

    // ── Interface ──
    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show tooltips")
      .setDesc("Display hover text on icons and buttons")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showTooltips)
          .onChange((value) => { void (async () => {
            this.plugin.settings.showTooltips = value;
            await this.plugin.saveSettings();
          })(); })
      );

    // ── Chat History ──
    new Setting(containerEl).setName("Chat history").setHeading();

    new Setting(containerEl)
      .setName("Chat folder")
      .setDesc("Vault folder where chat files are saved")
      .addText((text) =>
        text
          .setPlaceholder("OpenBrain/chats")
          .setValue(this.plugin.settings.chatFolder)
          .onChange((value) => { void (async () => {
            this.plugin.settings.chatFolder = value || "OpenBrain/chats";
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("Include recent chats as context")
      .setDesc("Inject recent chat summaries into new conversations")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeRecentChats)
          .onChange((value) => { void (async () => {
            this.plugin.settings.includeRecentChats = value;
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("Open chat history")
      .setDesc("View all past chats in an Obsidian Base")
      .addButton((btn) =>
        btn.setButtonText("Open").onClick(() => {
          const basePath = `${this.plugin.settings.chatFolder}/Chat History.base`;
          void this.app.workspace.openLinkText(basePath, "");
        })
      );

    // ── OpenClaw ──
    new Setting(containerEl).setName("OpenClaw").setHeading();

    new Setting(containerEl)
      .setName("Enable OpenClaw integration")
      .setDesc(
        "Connect to an OpenClaw gateway to access your vault from any messaging channel " +
        "(WhatsApp, Slack, Telegram, etc.). Requires OpenClaw running locally."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openclawEnabled)
          .onChange((value) => { void (async () => {
            this.plugin.settings.openclawEnabled = value;
            await this.plugin.saveSettings();
            this.display(); // Re-render to show/hide URL field
          })(); })
      );

    if (this.plugin.settings.openclawEnabled) {
      new Setting(containerEl)
        .setName("Gateway URL")
        .setDesc("WebSocket URL of your OpenClaw gateway. Default: ws://127.0.0.1:18789")
        .addText((text) =>
          text
            .setPlaceholder("ws://127.0.0.1:18789")
            .setValue(this.plugin.settings.openclawGatewayUrl)
            .onChange((value) => { void (async () => {
              this.plugin.settings.openclawGatewayUrl = value || "ws://127.0.0.1:18789";
              await this.plugin.saveSettings();
            })(); })
        );
    }
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

        installBtn.addEventListener("click", () => { void (async () => {
          installBtn.disabled = true;
          installBtn.setText("Installing...");

          const progressEl = el.createDiv({ cls: "ca-stt-progress" });

          try {
            await installStt(this.plugin.settings, (message) => {
              progressEl.setText(message);
            });

            // Re-render to show updated status
            this.display();
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            progressEl.setText(`Installation failed: ${message}`);
            progressEl.addClass("ca-stt-missing");
            installBtn.disabled = false;
            installBtn.setText("Retry installation");
          }
        })(); });
      }
    } catch (err: unknown) {
      el.empty();
      const message = err instanceof Error ? err.message : String(err);
      el.createSpan({
        text: `Error checking installation: ${message}`,
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
          .onChange((value) => { void (async () => {
            this.plugin.settings.audioDeviceId = value;
            await this.plugin.saveSettings();
          })(); });
      });
    } catch { /* expected — microphone permission may not be granted */
      setting.setDesc(
        "Could not enumerate audio devices. Grant microphone permission first."
      );
    }
  }
}
