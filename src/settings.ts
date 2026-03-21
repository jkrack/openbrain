import { App, PluginSettingTab, Setting, Notice, requestUrl } from "obsidian";
import OpenBrainPlugin from "./main";

const EMBEDDING_MODELS = [
  { id: "TaylorAI/bge-micro-v2", name: "BGE-micro-v2", size: "~20MB", dims: 384, tokens: 512, quality: 1 },
  { id: "Snowflake/snowflake-arctic-embed-xs", name: "Arctic Embed XS", size: "~25MB", dims: 384, tokens: 512, quality: 2 },
  { id: "TaylorAI/gte-tiny", name: "GTE-tiny", size: "~25MB", dims: 384, tokens: 512, quality: 2 },
  { id: "nomic-ai/nomic-embed-text-v1.5", name: "Nomic Embed v1.5", size: "~100MB", dims: 768, tokens: 2048, quality: 4 },
  { id: "jinaai/jina-embeddings-v2-small-en", name: "Jina v2 Small", size: "~80MB", dims: 512, tokens: 8192, quality: 5 },
];

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
  chatProvider: "anthropic" | "openrouter" | "ollama";
  openrouterApiKey: string;
  openrouterModel: string;
  anthropicModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  // Floating recorder
  floatingRecorderEnabled: boolean;
  floatingRecorderHotkey: string;
  floatingRecorderPosition: { x: number; y: number } | "auto";
  floatingRecorderSegmentDuration: number;
  floatingRecorderOutputFolder: string;
  floatingRecorderRetentionDays: number;
  floatingRecorderDefaultMode: string;
  // Embeddings
  embeddingsEnabled: boolean;
  embeddingsModel: string;
}

export const DEFAULT_SETTINGS: OpenBrainSettings = {
  apiKey: "",
  claudePath: "claude",
  model: "claude-sonnet-4-20250514",
  maxTokens: 4096,
  systemPrompt: `You are OpenBrain, an AI assistant embedded in Obsidian. You have direct access to the user's vault through tools. Be concise and direct. Use [[wikilinks]] when referencing notes. Use vault-relative paths only. Search the vault before answering questions about it. Read files before editing them.`,
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
  openrouterModel: "anthropic/claude-sonnet-4.6",
  anthropicModel: "",
  ollamaUrl: "",
  ollamaModel: "",
  floatingRecorderEnabled: false,
  floatingRecorderHotkey: "Alt+V",
  floatingRecorderPosition: "auto" as { x: number; y: number } | "auto",
  floatingRecorderSegmentDuration: 300,
  floatingRecorderOutputFolder: "OpenBrain/recordings",
  floatingRecorderRetentionDays: 7,
  floatingRecorderDefaultMode: "clipboard",
  embeddingsEnabled: false,
  embeddingsModel: "TaylorAI/bge-micro-v2",
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
        "Required when using the Anthropic provider. " +
        "Also used for voice transcription via API. " +
        "Get one at console.anthropic.com."
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
      .setDesc("Anthropic model ID for voice transcription. New models work automatically — just update the ID.")
      .addText((text) =>
        text
          .setPlaceholder("claude-sonnet-4-20250514")
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
      .setDesc("Which API to use for all conversations — Vault mode and Chat mode.")
      .addDropdown((drop) =>
        drop
          .addOption("anthropic", "Anthropic (Claude)")
          .addOption("openrouter", "OpenRouter (any model)")
          .addOption("ollama", "Ollama (local)")
          .setValue(this.plugin.settings.chatProvider)
          .onChange((value) => { void (async () => {
            this.plugin.settings.chatProvider = value as "anthropic" | "openrouter" | "ollama";
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
          "OpenRouter model ID. Examples: anthropic/claude-sonnet-4.6, " +
          "openai/gpt-4o, google/gemini-2.5-pro, meta-llama/llama-4-maverick"
        )
        .addText((text) =>
          text
            .setPlaceholder("anthropic/claude-sonnet-4.6")
            .setValue(this.plugin.settings.openrouterModel)
            .onChange((value) => { void (async () => {
              this.plugin.settings.openrouterModel = value;
              await this.plugin.saveSettings();
            })(); })
        );
    }

    if (this.plugin.settings.chatProvider === "anthropic") {
      new Setting(containerEl)
        .setName("Model")
        .setDesc("Anthropic model to use. Leave empty for default (Claude Sonnet 4).")
        .addText((text) =>
          text
            .setPlaceholder("claude-sonnet-4-20250514")
            .setValue(this.plugin.settings.anthropicModel)
            .onChange((value) => { void (async () => {
              this.plugin.settings.anthropicModel = value;
              await this.plugin.saveSettings();
            })(); })
        );
    }

    if (this.plugin.settings.chatProvider === "ollama") {
      new Setting(containerEl)
        .setName("Ollama URL")
        .setDesc("Base URL where Ollama is running. Default: http://localhost:11434")
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:11434")
            .setValue(this.plugin.settings.ollamaUrl)
            .onChange((value) => { void (async () => {
              this.plugin.settings.ollamaUrl = value;
              await this.plugin.saveSettings();
            })(); })
        );

      new Setting(containerEl)
        .setName("Model")
        .setDesc("Ollama model name. Examples: llama3, mistral, codellama, gemma2")
        .addText((text) =>
          text
            .setPlaceholder("llama3")
            .setValue(this.plugin.settings.ollamaModel)
            .onChange((value) => { void (async () => {
              this.plugin.settings.ollamaModel = value;
              await this.plugin.saveSettings();
            })(); })
        );

      new Setting(containerEl)
        .setName("Test connection")
        .setDesc("Verify that Ollama is running and the model is available.")
        .addButton((btn) =>
          btn.setButtonText("Test").onClick(() => { void (async () => {
            btn.setButtonText("Testing...");
            btn.setDisabled(true);
            try {
              const baseUrl = this.plugin.settings.ollamaUrl || "http://localhost:11434";
              const response = await requestUrl({ url: `${baseUrl}/api/tags`, method: "GET" });
              if (response.status !== 200) {
                new Notice(`Ollama connection failed: HTTP ${response.status}`);
                return;
              }
              const data = response.json as { models?: { name: string }[] };
              const models = data.models || [];
              const modelName = this.plugin.settings.ollamaModel || "llama3";
              const found = models.some((m: { name: string }) => m.name.startsWith(modelName));
              if (found) {
                new Notice(`Connected to Ollama. Model "${modelName}" is available.`);
              } else {
                const available = models.map((m: { name: string }) => m.name).join(", ");
                new Notice(`Connected to Ollama but model "${modelName}" not found. Available: ${available || "none"}`);
              }
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              new Notice(`Cannot connect to Ollama: ${message}. Is it running? Start with: ollama serve`);
            } finally {
              btn.setButtonText("Test");
              btn.setDisabled(false);
            }
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
      .setDesc("Edit OpenBrain/system-prompt.md to customize Claude's instructions. Applied to every conversation unless a skill overrides it.")
      .addButton((btn) =>
        btn.setButtonText("Open").onClick(() => {
          void this.app.workspace.openLinkText("OpenBrain/system-prompt.md", "");
        })
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

    // ── Floating Recorder ──
    new Setting(containerEl).setName("Floating recorder").setHeading();

    new Setting(containerEl)
      .setName("Enable floating recorder")
      .setDesc(
        "Show a floating recording overlay when Obsidian is not the active window. " +
        "Toggle recording via the command palette or an optional system-wide hotkey."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.floatingRecorderEnabled)
          .onChange((value) => { void (async () => {
            this.plugin.settings.floatingRecorderEnabled = value;
            await this.plugin.saveSettings();
            // Register or unregister hotkey based on toggle
            const fr = (this.plugin as any).floatingRecorder;
            if (value) {
              fr?.registerHotkey();
            } else {
              fr?.unregisterHotkey();
            }
            this.display();
          })(); })
      );

    if (this.plugin.settings.floatingRecorderEnabled) {
    const hotkeySetting = new Setting(containerEl)
      .setName("System-wide hotkey")
      .setDesc(
        "Press a key combination to set a global hotkey that works even when Obsidian is not focused. " +
        "Click Clear to remove."
      );

    const currentHotkey = this.plugin.settings.floatingRecorderHotkey;
    const hotkeyDisplay = hotkeySetting.controlEl.createEl("kbd", {
      text: currentHotkey || "Not set",
      cls: "setting-hotkey" + (currentHotkey ? "" : " setting-hotkey-empty"),
    });
    hotkeyDisplay.style.cssText = "padding:4px 10px;border-radius:4px;font-family:var(--font-monospace);font-size:12px;cursor:pointer;min-width:80px;text-align:center;border:1px solid var(--background-modifier-border);background:var(--background-secondary);";

    let listening = false;

    const setHotkey = (accelerator: string) => { void (async () => {
      // Unregister old hotkey, save new one, re-register
      (this.plugin as any).floatingRecorder?.unregisterHotkey();
      this.plugin.settings.floatingRecorderHotkey = accelerator;
      await this.plugin.saveSettings();
      (this.plugin as any).floatingRecorder?.registerHotkey();
      this.display();
    })(); };

    hotkeyDisplay.addEventListener("click", () => {
      if (listening) return;
      listening = true;
      hotkeyDisplay.setText("Press keys...");
      hotkeyDisplay.style.borderColor = "var(--interactive-accent)";

      const onKeyDown = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // Ignore lone modifier presses
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

        const parts: string[] = [];
        if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");

        // Use e.code for the physical key (immune to Option-key character mapping)
        // e.code gives "KeyV", "Digit1", "Space", etc.
        const code = e.code;

        if (code === "Escape") {
          // Cancel
          listening = false;
          hotkeyDisplay.setText(currentHotkey || "Not set");
          hotkeyDisplay.style.borderColor = "";
          document.removeEventListener("keydown", onKeyDown, true);
          return;
        }

        // Map e.code to Electron accelerator key names
        let key: string;
        if (code.startsWith("Key")) key = code.slice(3); // KeyV -> V
        else if (code.startsWith("Digit")) key = code.slice(5); // Digit1 -> 1
        else if (code === "Space") key = "Space";
        else if (code === "Backspace") key = "Backspace";
        else if (code === "Delete") key = "Delete";
        else if (code === "Enter") key = "Enter";
        else if (code === "Tab") key = "Tab";
        else if (code.startsWith("Arrow")) key = code.slice(5); // ArrowUp -> Up
        else if (code.startsWith("F") && /^F\d+$/.test(code)) key = code; // F1-F24
        else if (code === "Minus") key = "-";
        else if (code === "Equal") key = "=";
        else if (code === "BracketLeft") key = "[";
        else if (code === "BracketRight") key = "]";
        else if (code === "Backslash") key = "\\";
        else if (code === "Semicolon") key = ";";
        else if (code === "Quote") key = "'";
        else if (code === "Comma") key = ",";
        else if (code === "Period") key = ".";
        else if (code === "Slash") key = "/";
        else if (code === "Backquote") key = "`";
        else key = e.key.toUpperCase(); // fallback

        parts.push(key);
        const accelerator = parts.join("+");

        listening = false;
        document.removeEventListener("keydown", onKeyDown, true);
        setHotkey(accelerator);
      };

      document.addEventListener("keydown", onKeyDown, true);
    });

    if (currentHotkey) {
      hotkeySetting.addButton((btn) =>
        btn.setButtonText("Clear").onClick(() => setHotkey(""))
      );
    }

    new Setting(containerEl)
      .setName("Segment duration")
      .setDesc(
        "How often to save a recording segment to disk (in seconds). " +
        "Shorter segments mean less data loss on crash. Default: 300 (5 minutes)."
      )
      .addText((text) =>
        text
          .setPlaceholder("300")
          .setValue(String(this.plugin.settings.floatingRecorderSegmentDuration))
          .onChange((value) => { void (async () => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 30) {
              this.plugin.settings.floatingRecorderSegmentDuration = num;
              await this.plugin.saveSettings();
            }
          })(); })
      );

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Vault folder where transcription notes are created.")
      .addText((text) =>
        text
          .setPlaceholder("OpenBrain/recordings")
          .setValue(this.plugin.settings.floatingRecorderOutputFolder)
          .onChange((value) => { void (async () => {
            this.plugin.settings.floatingRecorderOutputFolder = value || "OpenBrain/recordings";
            await this.plugin.saveSettings();
          })(); })
      );

    new Setting(containerEl)
      .setName("WAV file retention")
      .setDesc(
        "Days to keep raw WAV files after transcription. Set to 0 to delete immediately."
      )
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.floatingRecorderRetentionDays))
          .onChange((value) => { void (async () => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.floatingRecorderRetentionDays = num;
              await this.plugin.saveSettings();
            }
          })(); })
      );
    } // end floatingRecorderEnabled

    // ── Semantic Search ──
    new Setting(containerEl).setName("Semantic search").setHeading();

    new Setting(containerEl)
      .setName("Enable semantic search")
      .setDesc(
        "Use local AI embeddings to find semantically related notes and passages. " +
        "Runs entirely on your device — no data leaves your machine."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.embeddingsEnabled)
          .onChange((value) => { void (async () => {
            this.plugin.settings.embeddingsEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          })(); })
      );

    if (this.plugin.settings.embeddingsEnabled) {
      // Model picker with Fast ↔ Accurate spectrum
      const modelSection = containerEl.createDiv({ cls: "ca-embed-models" });

      const scaleLabel = modelSection.createDiv({ cls: "ca-embed-scale" });
      scaleLabel.createSpan({ text: "Fast", cls: "ca-embed-scale-fast" });
      const scaleBar = scaleLabel.createSpan({ cls: "ca-embed-scale-bar" });
      scaleBar.setText("◄─────────────────────►");
      scaleLabel.createSpan({ text: "Accurate", cls: "ca-embed-scale-accurate" });

      for (const model of EMBEDDING_MODELS) {
        const isSelected = this.plugin.settings.embeddingsModel === model.id;
        const row = modelSection.createDiv({
          cls: `ca-embed-model-row${isSelected ? " selected" : ""}`,
        });

        const qualityBar = "\u25A0".repeat(model.quality) + "\u25A1".repeat(5 - model.quality);
        row.createSpan({ text: model.name, cls: "ca-embed-model-name" });
        row.createSpan({ text: model.size, cls: "ca-embed-model-size" });
        row.createSpan({ text: `${model.dims}d`, cls: "ca-embed-model-dims" });
        row.createSpan({ text: qualityBar, cls: "ca-embed-model-quality" });

        if (!isSelected) {
          row.style.cursor = "pointer";
          row.addEventListener("click", () => {
            const prev = this.plugin.settings.embeddingsModel;
            if (prev !== model.id) {
              const confirmed = confirm(
                `Switching to ${model.name} requires re-indexing your entire vault. This will take a few minutes. Continue?`
              );
              if (!confirmed) return;
            }
            void (async () => {
              this.plugin.settings.embeddingsModel = model.id;
              await this.plugin.saveSettings();
              this.display();
            })();
          });
        }
      }

      // Index status placeholder (populated by main.ts)
      const statusEl = containerEl.createDiv({ cls: "ca-embed-status" });
      statusEl.setText("Checking index...");
      (this.plugin as any)._embeddingStatusEl = statusEl;
    }

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
