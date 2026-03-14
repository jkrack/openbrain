# OpenBrain Skill Files Design

## Problem

OpenBrain currently has one mode: general-purpose chat with active note context. Users need structured workflows — meeting transcription, morning briefings, task tracking, research assistance — each with different system prompts, tool permissions, input modes, and post-processing behavior.

## Solution

Skills are markdown files stored in the vault. Each file defines an agent's behavior through YAML frontmatter (config) and markdown body (system prompt). OpenBrain loads these at startup and lets the user switch between them in the panel.

## Skill File Format

Skills live in a configurable vault folder (default: `OpenBrain/skills/`).

### Frontmatter Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | filename | Display name in UI |
| `description` | string | "" | Tooltip/subtitle |
| `input` | `audio` \| `text` \| `auto` | `auto` | Default input mode |
| `tools.write` | boolean | (from settings) | Override vault write toggle |
| `tools.cli` | boolean | (from settings) | Override CLI exec toggle |
| `auto_prompt` | string | none | Pre-filled or auto-sent prompt |
| `post_actions` | array | [] | Vault operations after response |

### Post-Action Types

- `create_note`: Create a new vault file
  - `path`: Vault path with variables (e.g., `Meetings/{{date}}-{{title}}.md`)
  - `template`: Optional template name
- `append_to_daily`: Append content under a heading in today's daily note
  - `section`: Heading to find (e.g., `## Meetings`)
  - `content`: Content with variables
- `replace_in_daily`: Replace content under a heading in today's daily note
  - `section`: Heading to find
  - `content`: Content with variables

### Template Variables

- `{{date}}`: Today's date (YYYY-MM-DD)
- `{{title}}`: Extracted from Claude's response (first heading or first line)
- `{{response}}`: Full response text
- `{{note_path}}`: Path of created note (for linking)

### Example: Meeting Agent

```markdown
---
name: Meeting Agent
description: Transcribe meetings into structured notes
input: audio
tools:
  write: true
  cli: false
post_actions:
  - create_note:
      path: "Meetings/{{date}}-{{title}}.md"
  - append_to_daily:
      section: "## Meetings"
      content: "- [[{{note_path}}]]"
---

You are a meeting transcription agent. Given audio recordings:

1. Transcribe the conversation faithfully
2. Identify speakers when possible
3. Extract:
   - **Attendees** (if mentioned)
   - **Key Decisions**
   - **Action Items** with owners
4. Format output using this structure:

## Meeting: {{title}}
**Date:** {{date}}
**Attendees:** ...

### Key Decisions
- ...

### Action Items
- [ ] Owner: Task description

### Discussion Summary
...
```

### Example: Morning Briefing

```markdown
---
name: Morning Briefing
description: Prep today's daily note
input: text
auto_prompt: "Generate my morning briefing for today"
tools:
  write: true
  cli: false
post_actions:
  - replace_in_daily:
      section: "## Focus"
      content: "{{response}}"
---

You are a daily briefing agent. Read the user's recent notes and tasks.

1. Summarize yesterday's unfinished tasks
2. List today's priorities based on open action items
3. Note any recurring themes or blocked items
4. Keep it concise - bullet points, not paragraphs
```

## Execution Engine

### Skill Loading

On plugin load (and on vault change in skills folder):
1. Scan configured skills folder for `.md` files
2. Parse YAML frontmatter and markdown body
3. Store as `Skill[]` array, pass to panel via props/context

### Skill Activation

When user selects a skill:
1. Skill's markdown body becomes the system prompt (replaces default)
2. Tool toggles update to match skill's `tools` config
3. Input mode adjusts: `audio` defaults to recording, `text` to text input
4. If `auto_prompt` exists, pre-fill input or show "Run" button

### Post-Action Execution

After Claude's response completes (in `onDone` callback):
1. Extract variables from response (title from first heading/line)
2. For each post-action:
   - `create_note`: `vault.create(resolvedPath, response)`
   - `append_to_daily`: Find daily note, read content, find section heading, insert after it, `vault.modify()`
   - `replace_in_daily`: Find daily note, read content, find section heading, replace content until next heading, `vault.modify()`
3. Show success/failure indicator in panel

### Daily Note Integration

Finding today's daily note:
- Use Obsidian's Daily Notes plugin API if available (`getDailyNote()`)
- Fallback: check configured daily notes folder with today's date format

## UI Changes

### Panel Header

Add a skill selector between the title and toggle buttons:

```
[OpenBrain] [note] [Meeting Agent v] [write] [cli] [↺]
```

- Dropdown/pill showing active skill name
- "General" is the default (current behavior, no skill file)
- Clicking opens a list of loaded skills

### Input Area

- When skill has `auto_prompt`: show a "Run" button that sends the auto_prompt
- When skill has `input: audio`: default to showing recording controls prominently
- Otherwise: standard text input (current behavior)

### Post-Action Feedback

After post-actions execute, show a small notification in the message thread:
- "Created note: Meetings/2026-03-13-standup.md"
- "Updated daily note"

## File Changes

| File | Change |
|------|--------|
| `src/skills.ts` | **New.** Skill type, loader, parser, post-action engine (~150 lines) |
| `src/panel.tsx` | Add skill selector dropdown, wire skill config into sendMessage |
| `src/settings.ts` | Add `skillsFolder` setting (default: `OpenBrain/skills`) |
| `src/main.ts` | Load skills on startup, pass to view |
| `src/view.ts` | Pass skills to panel props |

## Future Extensions

- **Hooks/triggers**: Skills with `trigger: daily-note-created` fire automatically on Obsidian events
- **MCP server**: Vault-native tool access so Claude can search/read notes without passing context
- **Skill sharing**: Users share skill `.md` files like Obsidian templates
- **Chained skills**: One skill's output feeds into another (meeting -> task extraction -> daily note)
