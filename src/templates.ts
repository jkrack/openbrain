import { App, TFile, moment } from "obsidian";

const TEMPLATES_FOLDER = "OpenBrain/templates";

// ── Built-in templates ─────────────────────────────────────────────────

const DAILY_NOTE_TEMPLATE = `# {{date}} ({{day}})

## Focus
What must move today.
- [ ]

---

## Capture
Fast intake. Convert to tasks or notes later.

---

## Tasks due today
---
\`\`\`tasks
not done
due today
sort by priority
\`\`\`

## **Overdue**
---
\`\`\`tasks
not done
due before today
sort by due
\`\`\`

## **Notes**
---
(**Observations, context, fragments.**)

---

## **Decisions**
---
(**Anything that changes direction or closes a loop.**)

## **Context**
---
\`\`\`smart-connections
limit 7
\`\`\`

## **End of day**
---
(**What shipped. What didn't. What matters tomorrow.**)
`;

const MEETING_TEMPLATE = `# {{title}}

**Date:** {{date}}
**Attendees:**
-

---

## Agenda
-

---

## Notes

---

## Action Items
- [ ]

---

## Decisions

`;

const ONE_ON_ONE_TEMPLATE = `# 1:1 — {{title}}

**Date:** {{date}}
**With:**

---

## Check-in
How are things going?

---

## Their Topics
-

---

## My Topics
-

---

## Action Items
- [ ]

---

## Notes

`;

// ── Template registry ──────────────────────────────────────────────────

interface TemplateEntry {
  filename: string;
  content: string;
}

const PROJECT_TEMPLATE = `# {{title}}

**Status:** Active
**Owner:**
**Started:** {{date}}

---

## Overview
What is this project and why does it matter?

---

## Goals
- [ ]

---

## Key Decisions

---

## Open Questions
-

---

## Progress Log

### {{date}}
- Project created
`;

const BUILT_IN_TEMPLATES: TemplateEntry[] = [
  { filename: "Daily Note.md", content: DAILY_NOTE_TEMPLATE },
  { filename: "Meeting.md", content: MEETING_TEMPLATE },
  { filename: "One on One.md", content: ONE_ON_ONE_TEMPLATE },
  { filename: "Project.md", content: PROJECT_TEMPLATE },
];

// ── Getting Started Note ──────────────────────────────────────────────

const GETTING_STARTED_CONTENT = `# Getting Started with OpenBrain

OpenBrain is an AI assistant embedded in Obsidian. It connects Claude Code to your vault so you can chat, record voice notes, run structured workflows, and manage your daily work — all from a side panel.

## How to Chat

Open the panel from the ribbon icon (brain) or the command palette ("Open OpenBrain panel").

- **Type a message** and press Enter to talk with Claude
- **Type @** followed by a filename to attach a vault note as context
- **Type /** to see available skills (structured workflows)
- **Shift+Enter** for a new line without sending

## Chat Modes

- **Vault mode** (default) — Claude can read your vault, run commands, and edit files (with permission)
- **Chat mode** — direct conversation with Claude, supports pasting images, no vault access

Toggle between modes with the button in the header.

## Skills (/commands)

Skills are specialized workflows. Type / in the input to activate one:

- **Meeting Notes** — transcribe and structure meeting notes
- **1:1** — prepare for and run one-on-one meetings with auto-loaded context
- **Morning Briefing** — review your day, tasks, and priorities
- **End of Day** — summarize what happened, capture loose ends
- **Weekly Review** — reflect on the week, plan ahead
- **Monthly Review** — higher-level reflection and goal tracking
- **Vault Health** — audit your vault for orphans, broken links, stale notes
- **Note Organizer** — restructure and clean up notes
- **Project Tracker** — check in on project status and next steps

Skills can also be selected from the dropdown in the header.

### Creating your own skills

**Option 1: Use /Create Skill** — describe what you want in conversation and OpenBrain generates the skill file for you.

**Option 2: Use a template** — copy a skill template from \`OpenBrain/templates/\` (files starting with "Skill -") into \`OpenBrain/skills/\` and customize it.

**Option 3: Write from scratch** — create a \`.md\` file in \`OpenBrain/skills/\` with YAML frontmatter (name, description, tools) and a system prompt body.

## Voice Recording

Click the mic button (or use the "Start/stop voice recording" hotkey) to record audio.

- Audio is transcribed automatically when you stop recording
- Use local transcription (free, private) or the Anthropic API
- Configure in Settings > OpenBrain > Local Speech-to-Text

## Daily Note Integration

OpenBrain links into your daily notes automatically:

- **Chat links** appear under a "Capture" section when you start a new conversation
- **Meeting links** appear under a "Meetings" section
- **Action items** found in conversations are extracted to your daily note
- **Quick capture** (command palette) adds bullets directly to today's note

Configure the daily note folder and format in Settings > OpenBrain > Folders.

## 1:1 Meetings

1. Create a person profile in \`OpenBrain/people/\` (one .md file per person)
2. Include their name, role, domain, and any standing topics
3. Activate the /1:1 skill — it will ask you to pick a person
4. OpenBrain loads their profile and recent meeting notes as context
5. A new meeting note is created from template and linked in your daily note

## Quick Capture

Open the command palette and run "Quick capture to daily note" to jot down a thought, task, or note without leaving your current context. It appends to the Capture section of today's daily note.

## Permissions

Two toggles in the header control what Claude can do per-conversation:

- **write** — allow Claude to create and edit files in your vault
- **cli** — allow Claude to run shell commands (vault search, Obsidian CLI)

Both start OFF by default. Enable them as needed, or configure defaults in settings.

## Key Settings

Open Settings > OpenBrain to configure:

- **Claude Code CLI path** — where the CLI binary lives (required)
- **Anthropic API key** — only needed for voice via API or chat mode
- **System prompt** — custom instructions applied to every conversation
- **Skills folder** — where skill definitions are stored
- **Daily note folder** — supports date variables like \`{{YYYY}}/{{MM}}\`
- **Chat folder** — where conversation history is saved

## Folder Structure

OpenBrain creates these folders in your vault:

\`\`\`
OpenBrain/
  chats/          — saved conversations
  skills/         — skill definitions (.md files)
  templates/      — note templates (daily, meeting, 1:1, project)
  people/         — person profiles for 1:1s
\`\`\`

All folders are created automatically on first run. You can customize the chat and skills folder paths in settings.
`;

/**
 * Create the Getting Started note in the vault (only if it doesn't exist).
 */
export async function createGettingStartedNote(app: App): Promise<void> {
  const path = "OpenBrain/Getting Started.md";
  if (app.vault.getAbstractFileByPath(path)) return;

  // Ensure OpenBrain folder exists
  if (!app.vault.getAbstractFileByPath("OpenBrain")) {
    await app.vault.createFolder("OpenBrain");
  }

  await app.vault.create(path, GETTING_STARTED_CONTENT);
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Create the templates folder and seed built-in templates.
 * Never overwrites existing templates — user customizations are preserved.
 */
export async function initTemplates(app: App): Promise<void> {
  // Create folder if missing
  if (!app.vault.getAbstractFileByPath(TEMPLATES_FOLDER)) {
    const parts = TEMPLATES_FOLDER.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) {
        await app.vault.createFolder(current);
      }
    }
  }

  // Seed built-in templates (don't overwrite existing)
  for (const tpl of BUILT_IN_TEMPLATES) {
    const path = `${TEMPLATES_FOLDER}/${tpl.filename}`;
    if (!app.vault.getAbstractFileByPath(path)) {
      await app.vault.create(path, tpl.content);
    }
  }
}

/**
 * Read a template from the templates folder and apply variable substitutions.
 * Returns null if the template doesn't exist.
 */
export async function renderTemplate(
  app: App,
  templateName: string,
  vars: Record<string, string> = {}
): Promise<string | null> {
  const path = `${TEMPLATES_FOLDER}/${templateName}`;
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;

  let content = await app.vault.read(file);

  // Apply date variables by default
  const now = moment();
  const defaults: Record<string, string> = {
    date: now.format("YYYY-MM-DD"),
    day: now.format("dddd"),
    time: now.format("HH:mm"),
    title: "",
  };

  const allVars = { ...defaults, ...vars };
  for (const [key, value] of Object.entries(allVars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }

  return content;
}

/**
 * Create a new note from a template.
 * Returns the vault path of the created file, or null on failure.
 */
export async function createFromTemplate(
  app: App,
  templateName: string,
  outputPath: string,
  vars: Record<string, string> = {}
): Promise<string | null> {
  const content = await renderTemplate(app, templateName, vars);
  if (!content) return null;

  // Create parent folders if needed
  const folderPath = outputPath.substring(0, outputPath.lastIndexOf("/"));
  if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) {
        await app.vault.createFolder(current);
      }
    }
  }

  // Don't overwrite existing files
  if (app.vault.getAbstractFileByPath(outputPath)) return outputPath;

  await app.vault.create(outputPath, content);
  return outputPath;
}
