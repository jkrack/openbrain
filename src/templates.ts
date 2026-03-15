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

const BUILT_IN_TEMPLATES: TemplateEntry[] = [
  { filename: "Daily Note.md", content: DAILY_NOTE_TEMPLATE },
  { filename: "Meeting.md", content: MEETING_TEMPLATE },
  { filename: "One on One.md", content: ONE_ON_ONE_TEMPLATE },
];

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
