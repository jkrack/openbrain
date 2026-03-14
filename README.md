# Claude Agent — Obsidian Plugin

Claude AI in the Obsidian right rail. Voice recording, transcription, and vault-aware reasoning via the Anthropic API.

## Features

- Streaming Claude responses in a right-rail chat panel
- Active note loaded as context automatically
- Voice recording via MediaRecorder (unlimited length)
- Audio sent directly to Claude for transcription + reasoning in one call
- Optional vault write and Obsidian CLI execution (toggled per session)
- Works with any Claude model via Anthropic API

## Setup

### 1. Install dependencies and build

```bash
npm install
npm run build
```

### 2. Install in Obsidian

Copy the following files into your vault's plugin folder:
```
.obsidian/plugins/claude-agent/
  main.js
  manifest.json
  styles.css
```

Then enable the plugin in Obsidian Settings > Community Plugins.

### 3. Add your API key

Settings > Claude Agent > Anthropic API key

Once Obsidian adds native keychain support for plugins (v1.11+), the key will be stored securely. For now it lives in plugin data.

### 4. Open the panel

Click the bot icon in the left ribbon, or use the command palette: "Open Claude Agent panel".

## Usage

**Text:** Type in the input field, press Enter or ↑ to send. Shift+Enter for newlines.

**Voice:** Press ⏺ to start recording. No time limit. Press ■ to stop. Claude receives the audio directly and transcribes + reasons over it in one call. Press ✎ before sending to add instructions like "transcribe only" or "extract action items."

**Selection:** Select text in any note and run "Send selection to Claude Agent" from the command palette.

**Tools:** Toggle write/cli in the header to grant Claude additional capabilities per session.

## Architecture

```
src/
  main.ts          — Plugin entry, registers view and commands
  view.ts          — Obsidian ItemView, mounts React root
  panel.tsx        — Main React UI component
  claude.ts        — Anthropic API client with streaming + audio
  useAudioRecorder.ts — MediaRecorder hook with waveform viz
  settings.ts      — Settings schema and settings tab
styles.css         — Panel styles using Obsidian CSS vars
```

## Audio format

Recorded as `audio/webm;codecs=opus` where supported, falling back to `audio/webm`. Claude accepts both. Chunks are buffered every 250ms so long recordings are handled without memory issues.

## Adding Obsidian CLI integration

The CLI exec tool toggle is wired in the UI but the execution layer is a stub. To implement:

```ts
// In claude.ts, add a tool definition:
{
  name: "obsidian_cli",
  description: "Run an Obsidian CLI command",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string" }
    }
  }
}

// In panel.tsx, handle tool_use blocks from the stream:
// shell out via electron's child_process when allowCli is true
```

The confirmation step before execution should live in panel.tsx as a modal before the shell call.
