# OpenBrain

AI-powered vault assistant for [Obsidian](https://obsidian.md). Chat with Claude about your notes, record voice memos, run structured workflows, and manage your daily work — all from a side panel.

## Features

### Chat with your vault
Type a message and Claude responds with full context of your vault. Reference any file with `@` — Claude reads it directly. Switch between **Vault mode** (full vault access, skills, commands) and **Chat mode** (fast conversation with image support).

### Voice recording & transcription
Record voice memos with one click. Transcribe locally (private, offline via sherpa-onnx) or via the Anthropic API. Audio is automatically processed through active skills.

### Skills (/commands)
Type `/` to activate specialized workflows:

- **1:1** — Prepare for and run one-on-one meetings with auto-loaded context
- **Meeting Agent** — Transcribe and structure meeting notes
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

## License

[MIT](LICENSE)
