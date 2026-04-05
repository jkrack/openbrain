# OpenBrain

AI assistant for [Obsidian](https://obsidian.md) with voice recording, local transcription, structured workflows, and vault-wide tool access. Runs in the sidebar, a detached window, or as a floating recorder on your desktop.

Supports **Anthropic**, **OpenRouter** (200+ models), and **Ollama** (free, local). Connects to [OpenClaw](https://github.com/openclaw/openclaw) for vault access from any messaging app.

## Install

**Recommended: [BRAT](https://github.com/TfTHacker/obsidian42-brat)** (auto-updates from GitHub releases)

1. Install BRAT from Obsidian community plugins
2. In BRAT settings: **Add Beta Plugin** > `jkrack/OpenBrain`
3. Reload Obsidian

**Manual:**

Download `main.js`, `manifest.json`, `styles.css`, and `floatingRecorder.html` from the [latest release](https://github.com/jkrack/OpenBrain/releases). Place them in `{vault}/.obsidian/plugins/open-brain/`.

## Features

### Chat with your vault

Type a message and the AI responds with full vault context. It can search, read, create, and edit notes through 22 built-in tools. Reference files with `@`, trigger skills with `/`, or let smart context surface relevant notes automatically.

Switch between **Vault mode** (full tool access, agentic loop) and **Chat mode** (fast conversation with image support).

### Voice recording & transcription

Record voice memos from the sidebar or the floating desktop recorder. Two transcription engines:

- **Neural Engine** (local) — Runs on Apple Silicon via the [FluidAudio](https://github.com/FluidInference/FluidAudio)-based STT daemon. Private, fast (~155x realtime), free, works offline. Uses Parakeet TDT 0.6B (25 languages). Downloads a ~1 GB model on first use.
- **Anthropic API** (fallback) — Sends audio to Claude. Requires an Anthropic API key and internet.

The floating recorder transcribes to clipboard. The in-panel recorder transcribes and processes through whatever skill is active.

### Skills

Markdown files with YAML frontmatter that define structured workflows. Type `/` in the chat to activate:

| Skill | What it does |
|-------|-------------|
| **Morning Briefing** | Populates today's Focus section from recent daily notes |
| **End of Day** | Summarizes what shipped, flags carryovers |
| **Meeting Notes** | Structures voice recordings into summary + action items + transcript |
| **1:1** | Same as meeting notes, with person context loaded |
| **Weekly Review** | Synthesizes the week into a review note |
| **Monthly Review** | Higher-level review across weekly notes and 1:1s |
| **Meeting Prep** | Pulls attendee profiles, past notes, and open items |
| **Project Status** | Reviews progress, blockers, and next steps |
| **Note Organizer** | Classifies, tags, suggests links and filing |
| **Vault Health** | Audits orphans, broken links, missing frontmatter |
| **Graph Enrichment** | Adds typed relationship frontmatter to notes |
| **Graph Health** | Audits knowledge graph quality |
| **Person Setup** | Creates a person profile through conversation |
| **Project Setup** | Creates a project note through conversation |
| **Create Skill** | Builds new skills through conversation |

Skills are vault files in `OpenBrain/skills/` — edit them directly or create new ones.

### Providers

| Provider | Setup | Audio | Notes |
|----------|-------|-------|-------|
| **Anthropic** | API key from [console.anthropic.com](https://console.anthropic.com) | Yes (API fallback) | Native tool calling |
| **OpenRouter** | API key from [openrouter.ai](https://openrouter.ai/keys) | No | 200+ models, OpenAI-compatible |
| **Ollama** | [Install](https://ollama.ai), run `ollama serve` | No | Free, fully local, no API key |

All providers support the same vault tools and skills. Switch anytime in settings.

### 22 Vault Tools

| Category | Tools |
|----------|-------|
| **Search** | Full-text search, contextual search with snippets, semantic search (embeddings) |
| **Read** | Read notes, list files, get outlines |
| **Graph** | Backlinks, outgoing links, orphans, dead links, graph walk, entity search, graph stats |
| **Metadata** | Properties, tags, unresolved links |
| **Write** | Create, edit, append, rename, move, delete |
| **Daily** | Read daily note, append to sections |
| **Tasks** | Get open/completed tasks from any file or daily note |

Write tools are permission-gated (off by default). Permissions are three-tiered: global settings > per-conversation header toggles > per-skill YAML definitions.

### Daily Note Integration

Conversations and meeting notes are automatically linked in your daily note. The morning briefing skill populates the Focus section. End of day fills the EOD section. Skills create notes from templates with proper frontmatter.

Daily note template includes: Focus, Capture, Tasks due today, Overdue, Notes, Decisions, Context, End of Day.

### Knowledge Graph

Optional background system that builds typed relationships between notes:
- **On save** — Heuristic detection of wikilinks to people/projects (instant, free)
- **Hourly** — Graph Enrichment skill runs the LLM for deeper analysis
- **Weekly** — Graph Health skill audits for gaps and disconnected clusters

Enable in Settings > Advanced > Knowledge graph.

### Semantic Search

Optional local embedding system using ONNX models. Indexes your vault for semantic similarity search. Multiple models available (BGE-micro to Jina v2). Runs entirely on-device.

Enable in Settings > Advanced > Semantic search.

### Floating Recorder (Desktop)

A desktop overlay window that records audio when Obsidian isn't focused. Trigger via command palette or a global hotkey (configurable). Transcribes locally via the STT daemon and copies to clipboard.

Configure in Settings > Voice > Floating recorder.

### OpenClaw Integration

Connect to [OpenClaw](https://github.com/openclaw/openclaw) to access your vault from WhatsApp, Slack, Telegram, Discord, Signal, and more. OpenBrain registers as a node and exposes vault commands over WebSocket.

Enable in Settings > OpenClaw. Requires OpenClaw running locally.

## Getting Started

1. Open the OpenBrain panel from the ribbon icon or command palette
2. Walk through the setup wizard — choose a provider, add an API key (or select Ollama)
3. Start chatting: type a message, use `@` for files, `/` for skills
4. For voice: click the mic icon to record, stop to transcribe

A Getting Started guide is created at `OpenBrain/Getting Started.md` on first run.

## Vault Structure

```
OpenBrain/
  skills/           — skill definitions (editable .md files)
  templates/        — note templates (daily, meeting, 1:1, project)
  chats/            — saved conversations
  people/           — person profiles
  meetings/         — meeting notes
  reviews/          — weekly/monthly reviews
  projects/         — project notes
  recordings/       — floating recorder output
  system-prompt-work.md     — AI instructions (work days)
  system-prompt-weekend.md  — AI instructions (weekends)
  Getting Started.md
```

All folders are configurable in Settings > Folders.

## STT Daemon (Apple Silicon)

The local transcription daemon is a Swift binary using [FluidAudio](https://github.com/FluidInference/FluidAudio) for Apple Neural Engine acceleration.

**Install:** Settings > Voice > "Download Neural Engine STT" — downloads the binary from the matching GitHub Release.

**Or build from source:**
```bash
cd swift/openbrain-stt
swift build -c release
cp .build/release/openbrain-stt ~/.openbrain/bin/
```

The daemon communicates over a Unix socket at `~/.openbrain/stt.sock`, auto-downloads the model on first transcription, and exits after 30 minutes idle.

## Development

```bash
npm install
npm run dev          # Watch mode — hot-reloads into Obsidian
npm run build        # Type-check + production build
npm run test         # Run vitest suite (193 tests)
npm run test:watch   # Watch mode tests
```

### Architecture

```
src/
  main.ts              — Plugin lifecycle, commands, views
  panel.tsx            — Main chat UI (~1500 lines, React hooks)
  chatEngine.ts        — Agentic loop with typed event system
  tools.ts             — 22 tool definitions
  toolEngine.ts        — Tool execution dispatch
  skills.ts            — Skill parser, post-actions, cleanResponse
  vaultIndex.ts        — In-memory vault metadata index
  smartContext.ts       — Keyword extraction + relevance scoring
  stt.ts / sttClient.ts — STT daemon client
  audioConverter.ts    — WebM-to-WAV conversion for daemon
  providers/
    anthropic.ts       — Native Anthropic API
    openrouter.ts      — OpenAI-compatible (OpenRouter)
    ollama.ts          — Local Ollama
  components/          — 14 React components
  __tests__/           — 17 test files, 193 tests
```

**Key conventions:**
- Typed chat events (AG-UI inspired): `content`, `tool_start`, `tool_end`, `done`, `error`
- Content/status separation prevents tool narration from leaking into skill outputs
- `cleanResponse()` strips model self-narration as a safety net
- All providers implement `LLMProvider` interface with streaming + tool formatting
- esbuild externals: `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, Node builtins

### Releasing

```bash
./scripts/release.sh patch   # or: major, minor, x.y.z
```

Bumps version in `manifest.json`, `package.json`, `versions.json`. Commits, tags, pushes. GitHub Actions builds the plugin + STT daemon and creates a release. BRAT picks it up automatically.

### Evaluating Skills

```bash
OPENROUTER_API_KEY=sk-or-... npx tsx scripts/eval-skills.ts           # all skills
OPENROUTER_API_KEY=sk-or-... npx tsx scripts/eval-skills.ts morning   # one skill
npx tsx scripts/eval-skills.ts --dry-run                               # audit prompts
```

Scores each skill output for narration violations, format compliance, and tool budget adherence.

## Privacy & Security

- **Ollama**: Fully local — no data leaves your machine
- **API keys**: Encrypted via system keychain before storage
- **Local STT**: Runs entirely on-device (Apple Silicon)
- **Permissions**: Write access off by default, per-conversation toggles
- **No telemetry**: Nothing is sent anywhere

## Disclaimer

**Early development.** OpenBrain can create, modify, and delete files when write permissions are enabled. Permissions are off by default and require explicit activation, but AI-generated actions may produce unexpected results.

- **Back up your vault** before enabling file editing
- **Review changes** — skills like Note Organizer and Vault Health propose plans before acting
- **Use at your own risk** — provided as-is under the MIT License

## License

[MIT](LICENSE)
