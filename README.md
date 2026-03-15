# OpenBrain

AI-powered vault assistant for [Obsidian](https://obsidian.md). Chat with Claude about your notes, record voice memos, run structured workflows, and manage your daily work — all from a side panel. Connects to [OpenClaw](https://github.com/openclaw/openclaw) to access your vault from any messaging channel.

## Features

### Chat with your vault
Type a message and Claude responds with full context of your vault. Reference any file with `@` — Claude reads it directly. Switch between **Vault mode** (full vault access, skills, commands) and **Chat mode** (fast conversation with image support).

### Voice recording & transcription
Record voice memos with one click. Transcribe locally (private, offline via sherpa-onnx) or via the Anthropic API. Audio is automatically processed through active skills.

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

Skills are markdown files — create your own in `OpenBrain/skills/`.

### Daily note integration
Every conversation and meeting note is automatically linked in your daily note. Action items are extracted and added as tasks. Configure your daily note folder and date format in settings.

### Person profiles & 1:1 meetings
Create profiles for your team in `OpenBrain/people/`. The `/1:1` skill loads their context, pulls recent meeting history, and creates a structured session note.

### Smart context
OpenBrain automatically finds relevant vault notes for every message — no need to manually reference files. It searches by keywords, backlinks, and tags to surface what matters.

### Templates
Built-in templates for daily notes, meetings, 1:1s, and projects. Customize them in `OpenBrain/templates/`.

### Quick capture
Capture a thought from the command palette without opening the panel. Goes straight to today's daily note.

### OpenClaw integration
Connect OpenBrain to [OpenClaw](https://github.com/openclaw/openclaw) to access your vault from any messaging channel — WhatsApp, Slack, Telegram, Discord, Signal, and more.

When enabled, OpenBrain registers as an OpenClaw node and exposes 10 vault commands:

| Command | What it does |
|---------|-------------|
| `vault.search` | Full-text search across your vault |
| `vault.read` | Read any note's content |
| `vault.create` | Create a note from template |
| `vault.daily.read` | Read today's daily note |
| `vault.daily.append` | Append to a daily note section |
| `vault.capture` | Quick capture to daily note |
| `vault.tasks` | Get open tasks from any file |
| `vault.skills.list` | List available skills |
| `vault.people.list` | List person profiles |
| `vault.chat.search` | Search conversation history |

This means you can message "capture: call Sarah about the migration" from WhatsApp and it lands in your daily note. Or ask "what are my open tasks?" from Slack and get a response from your vault.

**Setup:** Enable in Settings → OpenClaw. Requires [OpenClaw](https://github.com/openclaw/openclaw) running locally. Localhost-only by default, all write operations gated by existing permissions.

## Requirements

- **Claude Code CLI** (required) — [Install](https://docs.anthropic.com/en/docs/claude-code)
- **Anthropic API key** (optional) — Only for voice transcription via API and Chat mode
- **Obsidian CLI** (optional) — Enables vault search, task queries, and richer skill capabilities. Enable in Obsidian Settings → General → Command line interface.

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
3. Start chatting — type a message, use `@` for files, `/` for skills

A **Getting Started** note is created in your vault at `OpenBrain/Getting Started.md` with detailed documentation.

## Folder structure

OpenBrain creates these folders in your vault:

```
OpenBrain/
  chats/          — saved conversations (.md files)
  skills/         — skill definitions
  templates/      — note templates (daily, meeting, 1:1, project)
  people/         — person profiles for 1:1s
```

## Privacy & security

- **Local-first**: Text chat runs through Claude Code CLI on your machine. No data is sent to external servers unless you explicitly use the API (voice transcription or Chat mode).
- **API key encryption**: Your Anthropic API key is encrypted using your system's keychain (macOS Keychain, Windows DPAPI) before storage.
- **Offline voice**: Local transcription via sherpa-onnx runs entirely on your device.
- **Permissions**: File editing and shell commands are off by default. Enable per-conversation as needed.

## Settings

Open Settings → OpenBrain to configure:

- Claude Code CLI and Obsidian CLI paths
- API key (encrypted, masked)
- Permissions (file editing, shell commands)
- Daily note folder and format
- System prompt
- Tooltip visibility
- OpenClaw integration (gateway URL, enable/disable)

## Disclaimer

**This plugin is in early development.** OpenBrain can create, modify, and delete files in your vault when write permissions are enabled. While permissions are off by default and require explicit activation, AI-generated actions may produce unexpected results.

- **Back up your vault** before enabling file editing or shell commands
- **Review changes** before approving — the Note Organizer and Vault Health skills propose plans before acting
- **The authors are not responsible** for any data loss, file deletions, or vault corruption
- **Use at your own risk** — this software is provided as-is under the MIT License

We recommend starting with permissions off and enabling them only as needed for specific skills.

## License

[MIT](LICENSE)
