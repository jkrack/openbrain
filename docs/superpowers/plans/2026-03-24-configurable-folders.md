# Configurable Folder Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all OpenBrain folder paths configurable from settings, defaulting to a clean `OpenBrain/` tree.

**Architecture:** Add 6 new folder settings to `OpenBrainSettings`. Update all source files and skills that hardcode folder paths to read from settings. Add folder template variables to skill post_actions and system prompt injection.

**Tech Stack:** TypeScript, Obsidian API, skill YAML frontmatter.

**Spec:** `docs/superpowers/specs/2026-03-24-configurable-folders-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/settings.ts` | Modify | Add 6 new folder settings + Folders UI section |
| `src/initVault.ts` | Modify | Create all configured folders on first run |
| `src/people.ts` | Modify | Accept folder params instead of hardcoded `PEOPLE_FOLDER` |
| `src/templates.ts` | Modify | Accept folder param in `initTemplates()` and `renderTemplate()` |
| `src/notifications.ts` | Modify | Use settings for 1:1 folder path |
| `src/skills.ts` | Modify | Add folder vars to post_action substitution + background skill prompts |
| `src/smartContext.ts` | Modify | Use settings for template exclusion filter |
| `src/embeddingIndexer.ts` | Modify | Use settings for template exclusion filter |
| `src/panel.tsx` | Modify | Inject folder context into skill prompts, pass folder settings to people calls |
| `src/main.ts` | Modify | Pass settings to initVault, initTemplates, initPeopleFolder |
| 10 skill files | Modify | Use `{{folder_var}}` in post_actions and system prompts |

---

### Task 1: Add Folder Settings to OpenBrainSettings

**Files:**
- Modify: `src/settings.ts:12-54` (interface), `src/settings.ts:56-96` (defaults)

- [ ] **Step 1: Add 6 new fields to `OpenBrainSettings` interface**

After line 53 (`embeddingsDownloadedModels: string[];`), add:

```typescript
  // Folder structure
  meetingsFolder: string;
  oneOnOneFolder: string;
  reviewsFolder: string;
  projectsFolder: string;
  peopleFolder: string;
  templatesFolder: string;
```

- [ ] **Step 2: Add defaults in `DEFAULT_SETTINGS`**

After `embeddingsDownloadedModels: [],` add:

```typescript
  meetingsFolder: "OpenBrain/meetings",
  oneOnOneFolder: "OpenBrain/meetings/1-on-1",
  reviewsFolder: "OpenBrain/reviews",
  projectsFolder: "OpenBrain/projects",
  peopleFolder: "OpenBrain/people",
  templatesFolder: "OpenBrain/templates",
```

Also update the existing `dailyNoteFolder` default from `"Daily/{{YYYY}}/{{MM}}"` to `"OpenBrain/daily/{{YYYY}}/{{MM}}"`.

- [ ] **Step 3: Add Folders section to settings UI**

In the `display()` method, find the existing "Folders" heading (around line 369). Replace the existing folder settings (skills folder, daily note folder, daily note format) with a consolidated section containing all 9 folder paths plus the daily note format:

```typescript
// ── Folders ──
new Setting(containerEl).setName("Folders").setHeading();

new Setting(containerEl)
  .setName("Daily notes")
  .setDesc("Supports {{YYYY}}, {{MM}}, {{DD}} date variables.")
  .addText((text) =>
    text.setPlaceholder("OpenBrain/daily/{{YYYY}}/{{MM}}")
      .setValue(this.plugin.settings.dailyNoteFolder)
      .onChange((value) => { void (async () => {
        this.plugin.settings.dailyNoteFolder = value;
        await this.plugin.saveSettings();
      })(); })
  );

new Setting(containerEl)
  .setName("Daily note filename format")
  .setDesc("Date format for filename (without .md). Uses moment.js tokens.")
  .addText((text) =>
    text.setPlaceholder("YYYY-MM-DD")
      .setValue(this.plugin.settings.dailyNoteFormat)
      .onChange((value) => { void (async () => {
        this.plugin.settings.dailyNoteFormat = value;
        await this.plugin.saveSettings();
      })(); })
  );

new Setting(containerEl)
  .setName("Meetings")
  .setDesc("Where meeting notes are created by skills.")
  .addText((text) =>
    text.setPlaceholder("OpenBrain/meetings")
      .setValue(this.plugin.settings.meetingsFolder)
      .onChange((value) => { void (async () => {
        this.plugin.settings.meetingsFolder = value;
        await this.plugin.saveSettings();
      })(); })
  );

new Setting(containerEl)
  .setName("1:1 meetings")
  .setDesc("Per-person 1:1 note subfolders.")
  .addText((text) =>
    text.setPlaceholder("OpenBrain/meetings/1-on-1")
      .setValue(this.plugin.settings.oneOnOneFolder)
      .onChange((value) => { void (async () => {
        this.plugin.settings.oneOnOneFolder = value;
        await this.plugin.saveSettings();
      })(); })
  );

new Setting(containerEl)
  .setName("Reviews")
  .setDesc("Weekly and monthly review notes.")
  .addText((text) =>
    text.setPlaceholder("OpenBrain/reviews")
      .setValue(this.plugin.settings.reviewsFolder)
      .onChange((value) => { void (async () => {
        this.plugin.settings.reviewsFolder = value;
        await this.plugin.saveSettings();
      })(); })
  );

new Setting(containerEl)
  .setName("Projects")
  .setDesc("Project notes created by Project Setup.")
  .addText((text) =>
    text.setPlaceholder("OpenBrain/projects")
      .setValue(this.plugin.settings.projectsFolder)
      .onChange((value) => { void (async () => {
        this.plugin.settings.projectsFolder = value;
        await this.plugin.saveSettings();
      })(); })
  );

new Setting(containerEl)
  .setName("People")
  .setDesc("Person profiles used by Meeting Prep and 1:1 skills.")
  .addText((text) =>
    text.setPlaceholder("OpenBrain/people")
      .setValue(this.plugin.settings.peopleFolder)
      .onChange((value) => { void (async () => {
        this.plugin.settings.peopleFolder = value;
        await this.plugin.saveSettings();
      })(); })
  );

new Setting(containerEl)
  .setName("Templates")
  .setDesc("Note templates for meetings, projects, etc.")
  .addText((text) =>
    text.setPlaceholder("OpenBrain/templates")
      .setValue(this.plugin.settings.templatesFolder)
      .onChange((value) => { void (async () => {
        this.plugin.settings.templatesFolder = value;
        await this.plugin.saveSettings();
      })(); })
  );

new Setting(containerEl)
  .setName("Chat history")
  .setDesc("Where chat files are saved.")
  .addText((text) =>
    text.setPlaceholder("OpenBrain/chats")
      .setValue(this.plugin.settings.chatFolder)
      .onChange((value) => { void (async () => {
        this.plugin.settings.chatFolder = value || "OpenBrain/chats";
        await this.plugin.saveSettings();
      })(); })
  );

new Setting(containerEl)
  .setName("Skills")
  .setDesc("Skill definition files.")
  .addText((text) =>
    text.setPlaceholder("OpenBrain/skills")
      .setValue(this.plugin.settings.skillsFolder)
      .onChange((value) => { void (async () => {
        this.plugin.settings.skillsFolder = value;
        await this.plugin.saveSettings();
      })(); })
  );
```

Remove the old duplicate folder settings from the "Folders" and "Chat history" sections to avoid showing them twice.

- [ ] **Step 4: Build and test**

Run: `npm run build && npm run test`
Expected: Clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts
git commit -m "feat: add 6 configurable folder settings with consolidated UI section"
```

---

### Task 2: Update people.ts to Accept Folder Settings

**Files:**
- Modify: `src/people.ts` (constant, initPeopleFolder, loadPeople, getPersonMeetingFolder, getRecentOneOnOnes)
- Modify: `src/notifications.ts:28-30`

- [ ] **Step 1: Remove hardcoded constant and add folder parameters**

Remove `const PEOPLE_FOLDER = "OpenBrain/people";` (line 3).

Add folder parameters with defaults to ALL functions that use folder paths:
- `initPeopleFolder(app, peopleFolder = "OpenBrain/people")`
- `loadPeople(app, peopleFolder = "OpenBrain/people")`
- `getPersonMeetingFolder(name, oneOnOneFolder = "OpenBrain/meetings/1-on-1")` — returns `${oneOnOneFolder}/${name}`
- `getRecentOneOnOnes(app, name, oneOnOneFolder = "OpenBrain/meetings/1-on-1")` — must also pass `oneOnOneFolder` through its internal call to `getPersonMeetingFolder`

Replace all `PEOPLE_FOLDER` references with the `peopleFolder` parameter.

- [ ] **Step 2: Update notifications.ts**

Line 28: `loadPeople(app)` → `loadPeople(app, settings.peopleFolder)`
Line 30: `const folder = \`Meetings/1-on-1/${person.name}\`` → `const folder = getPersonMeetingFolder(person.name, settings.oneOnOneFolder || "OpenBrain/meetings/1-on-1")`

Import `getPersonMeetingFolder` from `"./people"`.

- [ ] **Step 3: Build** (will fail until templates.ts is updated in Task 3 — that's OK, don't commit yet)

---

### Task 3: Update templates.ts to Accept Folder Settings

**Files:**
- Modify: `src/templates.ts` (constant, initTemplates, renderTemplate, createFromTemplate)

- [ ] **Step 1: Remove hardcoded constant and thread folder parameter**

Remove `const TEMPLATES_FOLDER = "OpenBrain/templates";` (line 3).

Update signatures:
- `initTemplates(app, templatesFolder = "OpenBrain/templates")`
- `renderTemplate(app, templateName, vars, templatesFolder = "OpenBrain/templates")`
- `createFromTemplate(app, templateName, outputPath, vars, templatesFolder = "OpenBrain/templates")` — passes through to `renderTemplate`

Note: The spec says `createFromTemplate` doesn't need changes, but it calls `renderTemplate` internally and must thread the parameter.

- [ ] **Step 2: Build** (should now pass with Tasks 2+3 together)

---

### Task 4: Update initVault to Use Settings + Atomic Commit

**Files:**
- Modify: `src/initVault.ts:34-64`

- [ ] **Step 1: Update initVault to create all configured folders**

Replace the hardcoded `folders` array in `initVault()`. Include `recordings` folder:

```typescript
const folders = [
  settings.chatFolder || "OpenBrain/chats",
  settings.skillsFolder || "OpenBrain/skills",
  settings.templatesFolder || "OpenBrain/templates",
  settings.peopleFolder || "OpenBrain/people",
  settings.meetingsFolder || "OpenBrain/meetings",
  settings.oneOnOneFolder || "OpenBrain/meetings/1-on-1",
  settings.reviewsFolder || "OpenBrain/reviews",
  settings.projectsFolder || "OpenBrain/projects",
  settings.floatingRecorderOutputFolder || "OpenBrain/recordings",
];
```

- [ ] **Step 2: Update initTemplates and initPeopleFolder calls to pass settings**

```typescript
initTemplates(app, settings.templatesFolder || "OpenBrain/templates"),
initPeopleFolder(app, settings.peopleFolder || "OpenBrain/people"),
```

- [ ] **Step 3: Build and test — MUST pass** (people.ts and templates.ts already updated in Tasks 2-3)

Run: `npm run build && npm run test`
Expected: Clean build, all tests pass.

- [ ] **Step 4: Commit all source changes from Tasks 2-4 atomically**

```bash
git add src/people.ts src/notifications.ts src/templates.ts src/initVault.ts
git commit -m "feat: configurable folder paths in people, templates, and initVault"
```

---

### Task 5: Add Folder Variables to Skill Post-Actions and Background Prompts

**Files:**
- Modify: `src/skills.ts:216-220` (vars in executePostActions), `src/skills.ts:292-344` (runSkillInBackground)

- [ ] **Step 1: Add folder variables to executePostActions**

In `executePostActions`, update the `vars` object (around line 216):

```typescript
const vars: Record<string, string> = {
  date,
  title,
  response,
  note_path: "",
  meetings_folder: settings?.meetingsFolder || "OpenBrain/meetings",
  reviews_folder: settings?.reviewsFolder || "OpenBrain/reviews",
  projects_folder: settings?.projectsFolder || "OpenBrain/projects",
  people_folder: settings?.peopleFolder || "OpenBrain/people",
};
```

- [ ] **Step 2: Add folder injection to runSkillInBackground**

In `runSkillInBackground`, the existing `systemPrompt` is built on line 313 as a `const`. Append folder context by modifying that line directly (do NOT redeclare `const systemPrompt`):

```typescript
const folderContext = [
  `\nConfigured vault folders:`,
  `- Meetings: ${settings.meetingsFolder || "OpenBrain/meetings"}`,
  `- 1:1s: ${settings.oneOnOneFolder || "OpenBrain/meetings/1-on-1"}`,
  `- Reviews: ${settings.reviewsFolder || "OpenBrain/reviews"}`,
  `- Projects: ${settings.projectsFolder || "OpenBrain/projects"}`,
  `- People: ${settings.peopleFolder || "OpenBrain/people"}`,
].join("\n");

// Modify line 313 to include folderContext:
const systemPrompt = skill.systemPrompt + (fullContext ? `\n\n---\nContext:\n${fullContext}` : "") + folderContext;
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm run test`
Expected: Clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/skills.ts
git commit -m "feat: add folder variables to post_action substitution and background skill prompts"
```

---

### Task 6: Inject Folder Context into Skill System Prompts in Panel

**Files:**
- Modify: `src/panel.tsx` (effectiveSystemPrompt area)

- [ ] **Step 1: Append folder context to effectiveSystemPrompt**

Find where `effectiveSystemPrompt` is built (around line 123-125). After the person context injection, add:

```typescript
const folderContext = [
  `\nConfigured vault folders:`,
  `- Meetings: ${settings.meetingsFolder}`,
  `- 1:1s: ${settings.oneOnOneFolder}`,
  `- Reviews: ${settings.reviewsFolder}`,
  `- Projects: ${settings.projectsFolder}`,
  `- People: ${settings.peopleFolder}`,
].join("\n");

const effectiveSystemPrompt = selectedPerson
  ? `${baseSystemPrompt}\n\n--- Person Context ---\n${selectedPerson.fullContent}${folderContext}`
  : `${baseSystemPrompt}${folderContext}`;
```

- [ ] **Step 2: Build and test**

Run: `npm run build && npm run test`
Expected: Clean build, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/panel.tsx
git commit -m "feat: inject configured folder paths into skill system prompts"
```

---

### Task 7: Update Exclusion Filters in smartContext and embeddingIndexer

**Files:**
- Modify: `src/smartContext.ts:73`
- Modify: `src/embeddingIndexer.ts:122`

- [ ] **Step 1: Update smartContext.ts exclusion filter**

Line 73 currently reads:
```typescript
if (file.path.includes("OpenBrain/chats/") || file.path.includes("OpenBrain/templates/")) continue;
```

The function doesn't currently receive settings. Add settings as an optional parameter to the relevant function, or use a module-level setter similar to `setVaultIndex`. The simplest approach: the exclusion paths are already in the function's scope. Update the filter to use a passed-in exclusion list or accept settings.

Since `buildSmartContext` already accepts `app` and we added `attachmentManager`, the simplest fix is to add `settings` as a parameter:

```typescript
export async function buildSmartContext(
  app: App,
  message: string,
  existingFiles: string[] = [],
  embeddingSearch?: EmbeddingSearch | null,
  attachmentManager?: AttachmentManager | null,
  settings?: { chatFolder?: string; templatesFolder?: string } | null
): Promise<{ text: string; images: ImageAttachment[] }>
```

Then update line 73:
```typescript
const chatFolder = settings?.chatFolder || "OpenBrain/chats";
const templatesFolder = settings?.templatesFolder || "OpenBrain/templates";
if (file.path.includes(chatFolder + "/") || file.path.includes(templatesFolder + "/")) continue;
```

Update the caller in `panel.tsx` to pass settings.

- [ ] **Step 2: Update embeddingIndexer.ts exclusion filter**

Line 122 currently reads:
```typescript
if (file.path.startsWith("OpenBrain/chats/") || file.path.startsWith("OpenBrain/templates/")) continue;
```

The indexer is created in `main.ts` via `createEmbeddingIndexer(app, engine, index, modelId)`. Add a 5th parameter `excludeFolders?: { chatFolder: string; templatesFolder: string }` to the function signature. In `main.ts`, pass `{ chatFolder: this.settings.chatFolder, templatesFolder: this.settings.templatesFolder }`. Update the filter:

```typescript
const chatFolder = settings?.chatFolder || "OpenBrain/chats";
const templatesFolder = settings?.templatesFolder || "OpenBrain/templates";
if (file.path.startsWith(chatFolder + "/") || file.path.startsWith(templatesFolder + "/")) continue;
```

- [ ] **Step 3: Build and test**

Run: `npm run build && npm run test`
Expected: Clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/smartContext.ts src/embeddingIndexer.ts src/panel.tsx
git commit -m "feat: use configurable folder paths for exclusion filters"
```

---

### Task 8: Update Skill YAML Files — Post-Actions

**Files:**
- Modify: `OpenBrain/skills/meeting-agent.md`
- Modify: `OpenBrain/skills/weekly-review.md`
- Modify: `OpenBrain/skills/monthly-review.md`

These are in the vault at `/Users/jlane/GitHub/Obsidian/OpenBrain/skills/`.

- [ ] **Step 1: Update meeting-agent.md post_actions**

Change:
```yaml
post_actions:
  - create_note:
      path: "Meetings/{{date}}-{{title}}.md"
```
To:
```yaml
post_actions:
  - create_note:
      path: "{{meetings_folder}}/{{date}}-{{title}}.md"
```

- [ ] **Step 2: Update weekly-review.md post_actions**

Change:
```yaml
post_actions:
  - create_note:
      path: "Reviews/Week of {{date}}.md"
```
To:
```yaml
post_actions:
  - create_note:
      path: "{{reviews_folder}}/Week of {{date}}.md"
```

- [ ] **Step 3: Update monthly-review.md post_actions**

Change:
```yaml
post_actions:
  - create_note:
      path: "Reviews/Month of {{date}}.md"
```
To:
```yaml
post_actions:
  - create_note:
      path: "{{reviews_folder}}/Month of {{date}}.md"
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/jlane/GitHub/Obsidian add OpenBrain/skills/meeting-agent.md OpenBrain/skills/weekly-review.md OpenBrain/skills/monthly-review.md
git -C /Users/jlane/GitHub/Obsidian commit -m "feat: skill post_actions use configurable folder variables"
```

Note: These files live in the Obsidian vault, not the plugin repo. Commit to the vault repo if it's tracked, or just save them.

---

### Task 9: Update Skill System Prompts — Hardcoded Folder References

**Files (all in vault):**
- Modify: `OpenBrain/skills/project-setup.md`
- Modify: `OpenBrain/skills/project-tracker.md`
- Modify: `OpenBrain/skills/person-setup.md`
- Modify: `OpenBrain/skills/meeting-prep.md`
- Modify: `OpenBrain/skills/note-organizer.md`
- Modify: `OpenBrain/skills/vault-health.md`
- Modify: `OpenBrain/skills/monthly-review.md` (system prompt body, separate from post_actions)

For each skill, replace hardcoded folder paths in the system prompt body with a reference to the configured folders. Since the system prompt now has the folder context injected (from Task 6), skills can reference "the configured Meetings folder" etc. But for clarity, update the instructions to not hardcode paths:

- [ ] **Step 1: Update project-setup.md**

Replace `Projects/<Project Name>.md` with: "Use the configured Projects folder (shown in your context) to create the note at `<projects_folder>/<Project Name>.md`."

- [ ] **Step 2: Update project-tracker.md**

Replace references to `Projects/` folder with: "Search for project notes using `vault_search` for `type: project` in frontmatter. Use the configured Projects folder shown in your context."

- [ ] **Step 3: Update person-setup.md**

Replace `OpenBrain/people/<Full Name>.md` with: "Use the configured People folder to create the note."

- [ ] **Step 4: Update meeting-prep.md**

Replace `OpenBrain/people/` reference with: "Search for attendee profiles in the configured People folder."

- [ ] **Step 5: Update note-organizer.md**

Update the filing table to reference configured folders instead of hardcoded `Meetings/`, `Projects/`, `OpenBrain/people/`.

- [ ] **Step 6: Update vault-health.md**

Update audit instructions to reference configured folders instead of hardcoded paths.

- [ ] **Step 7: Update monthly-review.md system prompt**

Replace the hardcoded `Meetings/` reference in the system prompt body.

- [ ] **Step 8: Verify all skills load**

Restart Obsidian (or trigger a skill reload) and verify skills appear in the dropdown.

---

### Task 10: Build, Test, and Verify

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean build, no TypeScript errors.

- [ ] **Step 2: Full test suite**

Run: `npm run test`
Expected: All tests pass (87+).

- [ ] **Step 3: Copy to vault**

```bash
cp main.js manifest.json styles.css /Users/jlane/GitHub/Obsidian/.obsidian/plugins/open-brain/
```

- [ ] **Step 4: Commit all source changes**

```bash
git add src/settings.ts src/initVault.ts src/people.ts src/templates.ts src/notifications.ts src/skills.ts src/smartContext.ts src/embeddingIndexer.ts src/panel.tsx
git commit -m "feat: configurable folder structure — all paths driven by settings"
```

---

## Verification Checklist

After all tasks complete:

- [ ] Settings → Folders section shows all 9 folder paths
- [ ] New install creates all folders under `OpenBrain/`
- [ ] `/meeting-notes` creates note in configured meetings folder
- [ ] `/weekly-review` creates note in configured reviews folder
- [ ] `/project-setup` creates note in configured projects folder
- [ ] `/person-setup` creates note in configured people folder
- [ ] Smart context excludes configured templates folder
- [ ] Notification check uses configured 1:1 folder
- [ ] Changing a folder setting takes effect on next skill invocation
