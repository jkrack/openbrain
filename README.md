# OpenBrain

AI-powered vault assistant for [Obsidian](https://obsidian.md). Chat with any LLM about your notes, record voice memos, run structured workflows, and manage your daily work — all from a side panel. Supports Anthropic, OpenRouter (200+ models), and Ollama (free, local). Connects to [OpenClaw](https://github.com/openclaw/openclaw) to access your vault from any messaging channel.

## Features

### Chat with your vault
Type a message and your AI responds with full context of your vault. It can search, read, create, and edit notes through 22 built-in vault tools. Reference any file with `@` — or let smart context surface relevant notes automatically. Switch between **Vault mode** (full tool access) and **Chat mode** (fast conversation with image support).

### Multiple providers
Choose your LLM provider:
- **Anthropic** — Claude models with native tool calling and vision
- **OpenRouter** — 200+ models (GPT-4o, Gemini, Llama, Mistral, Claude, and more)
- **Ollama** — Run models locally for free. No API key, no data leaves your machine

Switch providers anytime in settings. All providers support the same vault tools and skills.

### Voice recording & transcription
Record voice memos with one click. Transcribe locally (private, offline via sherpa-onnx) or via your configured provider. Audio is automatically processed through active skills.

### Skills (/commands)
Type `/` to activate specialized workflows:

- **1:1** — Prepare for and run one-on-one meetings with auto-loaded context
- **Meeting Notes** — Transcribe and structure meeting notes
- **Morning Briefing** — Review your day, tasks, and priorities
- **End of Day** — Summarize what happened, capture loose ends
- **Weekly Review** — Reflect on the week, plan ahead
- **Monthly Review** — Higher-level reflection and goal tracking
- **Vault Health** — Audit orphans, broken links, stale notes
- **Note Organizer** — Classify, tag, and suggest links for notes
- **Project Status** — Review project progress and next steps
- **Create Skill** — Build new skills through conversation

Skills are markdown files — create your own with `/Create Skill` or in `OpenBrain/skills/`.

### 22 vault tools
OpenBrain gives your LLM structured access to your vault:

| Category | Tools |
|----------|-------|
| **Search** | Full-text search, contextual search |
| **Read** | Read notes, list files, get outlines |
| **Graph** | Backlinks, outgoing links, orphans, dead links |
| **Metadata** | Properties, tags, unresolved links |
| **Write** | Create, edit, append, rename, move, delete |
| **Daily notes** | Read and append to sections |
| **Tasks** | Get open/completed tasks from any file |

Write tools are gated by permissions — off by default.

### Daily note integration
Every conversation and meeting note is automatically linked in your daily note with a TLDR summary. Action items are extracted and added as tasks. Configure your daily note folder and date format in settings (supports nested `{{YYYY}}/{{MM}}` paths).

### System prompt as a vault file
Your AI's instructions live at `OpenBrain/system-prompt.md` — editable right in Obsidian. Customize how it behaves, what sections to target in daily notes, and how to handle different types of requests.

### Person profiles & 1:1 meetings
Create profiles for your team in `OpenBrain/people/`. The `/1:1` skill loads their context, pulls recent meeting history, and creates a structured session note.

### Smart context
OpenBrain automatically finds relevant vault notes for every message — no need to manually reference files. It searches by keywords, backlinks, and tags to surface what matters.

### Templates
Built-in templates for daily notes, meetings, 1:1s, and projects. Customize them in `OpenBrain/templates/`. Skill templates also available for creating new workflows.

### Quick capture
Capture a thought from the command palette without opening the panel. Goes straight to today's daily note.

### OpenClaw integration
Connect OpenBrain to [OpenClaw](https://github.com/openclaw/openclaw) to access your vault from any messaging channel — WhatsApp, Slack, Telegram, Discord, Signal, and more.

When enabled, OpenBrain registers as an OpenClaw node and exposes vault commands so you can search, capture, and query from any device.

**Setup:** Enable in Settings → OpenClaw. Requires [OpenClaw](https://github.com/openclaw/openclaw) running locally.

## Requirements

One of:
- **Anthropic API key** — [Get one](https://console.anthropic.com/)
- **OpenRouter API key** — [Get one](https://openrouter.ai/keys) (access to 200+ models)
- **Ollama** — [Install](https://ollama.ai/) (free, runs locally, no API key needed)

Optional:
- **Obsidian CLI** — Enables enhanced vault search and task queries. Enable in Obsidian Settings → General → Command line interface.

## Installation

### From community plugins
1. Open Settings → Community plugins → Browse
2. Search for "OpenBrain"
3. Install and enable

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create `{vault}/.obsidian/plugins/open-brain/` and place the files there
3. Enable the plugin in Settings → Community plugins

## Getting started

1. Open the OpenBrain panel from the ribbon icon (brain) or command palette
2. Walk through the 3-step setup wizard
3. Choose your provider and add an API key (or select Ollama for free local use)
4. Start chatting — type a message, use `@` for files, `/` for skills

A **Getting Started** note is created in your vault at `OpenBrain/Getting Started.md` with detailed documentation.

## Folder structure

OpenBrain creates these folders in your vault:

```
OpenBrain/
  chats/              — saved conversations (.md files)
  skills/             — skill definitions
  templates/          — note templates (daily, meeting, 1:1, project)
  people/             — person profiles for 1:1s
  system-prompt.md    — editable AI instructions
  Getting Started.md  — documentation
```

## Privacy & security

- **Provider choice**: Use Ollama for fully local, private AI — no data leaves your machine
- **API key encryption**: All API keys are encrypted using your system's keychain (macOS Keychain, Windows DPAPI) before storage
- **Offline voice**: Local transcription via sherpa-onnx runs entirely on your device
- **Permissions**: File editing is off by default. Enable per-conversation as needed
- **No telemetry**: Performance data stays local. Nothing is sent anywhere

## Settings

Open Settings → OpenBrain to configure:

- Provider selection (Anthropic, OpenRouter, Ollama)
- API keys (encrypted, masked)
- Model selection (text field — future-proof for new models)
- Permissions (file editing)
- Daily note folder and format
- System prompt (opens the vault file)
- Obsidian CLI path
- OpenClaw integration

## Disclaimer

**This plugin is in early development.** OpenBrain can create, modify, and delete files in your vault when write permissions are enabled. While permissions are off by default and require explicit activation, AI-generated actions may produce unexpected results.

- **Back up your vault** before enabling file editing
- **Review changes** before approving — the Note Organizer and Vault Health skills propose plans before acting
- **The authors are not responsible** for any data loss, file deletions, or vault corruption
- **Use at your own risk** — this software is provided as-is under the MIT License

We recommend starting with permissions off and enabling them only as needed for specific skills.

## License

[MIT](LICENSE)
