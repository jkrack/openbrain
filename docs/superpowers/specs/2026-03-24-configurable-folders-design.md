# Configurable Folder Structure Design Spec

## Problem

OpenBrain's folder paths are split between settings (4 configurable) and hardcoded values scattered across source code and skill YAML files. This creates a disjointed vault hierarchy with folders at multiple levels (`Daily/`, `Meetings/`, `Projects/`, `OpenBrain/`). Users cannot consolidate everything under a single tree without editing source code.

## Goals

1. Make all folder paths configurable from settings with sensible defaults
2. Default new installs to a clean `OpenBrain/` tree
3. Existing installs keep their current paths (no breaking changes)
4. Skills use folder variables instead of hardcoded paths
5. `initVault` creates all configured folders on first run

## Non-Goals

- Auto-migrating existing files when settings change
- Renaming or restructuring the plugin's internal code folders
- Changing the chat or skill folder settings (already configurable)

---

## New Settings

6 new fields added to `OpenBrainSettings` in `src/settings.ts`:

| Setting | Default | Currently |
|---------|---------|-----------|
| `meetingsFolder` | `"OpenBrain/meetings"` | Hardcoded `"Meetings/"` in skill YAML |
| `oneOnOneFolder` | `"OpenBrain/meetings/1-on-1"` | Hardcoded in `people.ts` |
| `reviewsFolder` | `"OpenBrain/reviews"` | Hardcoded `"Reviews/"` in skill YAML |
| `projectsFolder` | `"OpenBrain/projects"` | Hardcoded `"Projects/"` in skill/template |
| `peopleFolder` | `"OpenBrain/people"` | Hardcoded in `people.ts` |
| `templatesFolder` | `"OpenBrain/templates"` | Hardcoded in `templates.ts` |

Also update the existing `dailyNoteFolder` default from `"Daily/{{YYYY}}/{{MM}}"` to `"OpenBrain/daily/{{YYYY}}/{{MM}}"`.

**Important:** The default change for `dailyNoteFolder` only affects new installs. Existing installs already have a saved value that won't be overwritten by `Object.assign({}, DEFAULT_SETTINGS, data)`.

---

## Default Folder Tree

```
OpenBrain/
├── daily/{{YYYY}}/{{MM}}/    ← daily notes
├── meetings/                  ← meeting notes
│   └── 1-on-1/              ← per-person 1:1 folders
├── reviews/                   ← weekly + monthly reviews
├── projects/                  ← project notes
├── people/                    ← person profiles
├── chats/                     ← chat history + assets
├── recordings/                ← floating recorder output
├── skills/                    ← skill definitions
└── templates/                 ← note templates
```

---

## Source Code Changes

### settings.ts

Add 6 new fields to `OpenBrainSettings` interface and `DEFAULT_SETTINGS`.

Add a "Folders" section in the settings UI that groups all 9 folder paths:
- Daily notes folder (existing)
- Meetings folder (new)
- 1:1 folder (new)
- Reviews folder (new)
- Projects folder (new)
- People folder (new)
- Templates folder (new)
- Chat folder (existing)
- Skills folder (existing)

Move the existing daily note folder, chat folder, and skills folder settings into this grouped section (remove from their current locations to avoid duplication).

### people.ts

Currently hardcodes `"OpenBrain/people/"` for loading profiles and `"Meetings/1-on-1/<name>/"` for 1:1 meeting folders.

Change `loadPeople()` to accept `peopleFolder` parameter (from settings).
Change `getPersonMeetingFolder()` to accept `oneOnOneFolder` parameter.

### templates.ts

Currently hardcodes `"OpenBrain/templates/"` via the `TEMPLATES_FOLDER` constant.

Change `initTemplates()` and `renderTemplate()` to accept `templatesFolder` parameter (not `createFromTemplate()` — that function already accepts a full path and doesn't use the constant).

### initVault.ts

Currently creates `OpenBrain/`, `OpenBrain/skills/`, `OpenBrain/templates/`, `OpenBrain/people/`, `OpenBrain/chats/`.

Update to create all configured folders from settings: daily note folder (base, without date variables), meetings, 1:1, reviews, projects, people, chats, recordings, skills, templates.

### skills.ts

`executePostActions()` already receives `settings`. Add new template variables to the `vars` object:

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

### notifications.ts

Line 30 independently hardcodes `Meetings/1-on-1/${person.name}` for stale 1:1 detection. Update to call `getPersonMeetingFolder()` with the settings-sourced `oneOnOneFolder`, or accept the folder path as a parameter.

### smartContext.ts

Line 73 hardcodes `"OpenBrain/templates/"` as an exclusion filter for smart context results. Update to use `settings.templatesFolder` so template files are excluded regardless of configured path.

### embeddingIndexer.ts

Line 122 hardcodes `"OpenBrain/templates/"` as an exclusion filter for embedding indexing. Update to use the configured `templatesFolder` setting.

### panel.tsx

Update calls to `loadPeople()` to pass folder settings. Pass folder settings to `selectPerson` for 1:1 note creation.

### main.ts

Update `initVault()` call to pass all folder settings.

### skills.ts — runSkillInBackground()

`runSkillInBackground()` (line 292+) constructs its own system prompt independently of `panel.tsx`. Add the same folder variable injection there so background-triggered skills (if any use folder paths) receive the correct configured folders.

---

## Skill YAML Updates

### meeting-agent.md
```yaml
post_actions:
  - create_note:
      path: "{{meetings_folder}}/{{date}}-{{title}}.md"
  - append_to_daily:
      section: "## Meetings"
      content: "- [[{{note_path}}]]"
```

### weekly-review.md
```yaml
post_actions:
  - create_note:
      path: "{{reviews_folder}}/Week of {{date}}.md"
  - append_to_daily:
      section: "## Notes"
      content: "- [[{{note_path}}]]"
```

### monthly-review.md
```yaml
post_actions:
  - create_note:
      path: "{{reviews_folder}}/Month of {{date}}.md"
  - append_to_daily:
      section: "## Notes"
      content: "- [[{{note_path}}]]"
```

### project-setup.md
System prompt updated to use `{{projects_folder}}` variable. The skill receives folder paths via the system prompt injection (settings are available to the skill system prompt via variable substitution).

### project-tracker.md
System prompt references to `Projects/` updated to use a configurable reference.

### person-setup.md
System prompt references to `OpenBrain/people/` updated.

---

## Skill System Prompt Variable Injection

Skills need access to folder paths in their system prompts (not just post_actions). Add folder variables to the system prompt context that gets injected when a skill activates:

In `panel.tsx`, when building `effectiveSystemPrompt`, append a block with the resolved folder paths (actual values from settings, not template variables):

```typescript
const folderContext = [
  `\nConfigured vault folders:`,
  `- Meetings: ${settings.meetingsFolder}`,
  `- 1:1s: ${settings.oneOnOneFolder}`,
  `- Reviews: ${settings.reviewsFolder}`,
  `- Projects: ${settings.projectsFolder}`,
  `- People: ${settings.peopleFolder}`,
].join("\n");
```

This is appended to the system prompt so skills like project-setup and person-setup use the correct configured folders. The same injection must also be applied in `runSkillInBackground()` in `skills.ts` for background-triggered skills.

---

## Migration Strategy

- **New installs:** Get all defaults under `OpenBrain/`. Clean tree from day one.
- **Existing installs:** Keep current saved values. `Object.assign({}, DEFAULT_SETTINGS, data)` means new settings get defaults, existing settings keep their values.
- **No auto-move:** Files are never moved when settings change. The user changes the setting, creates new files in the new location, and manually moves old files if desired.
- **Stale references:** If a user changes `meetingsFolder` but has old meeting notes in `Meetings/`, those notes are still in the vault — just not where the skill creates new ones. Vault search still finds them.

---

## Files Modified

| File | Change |
|------|--------|
| `src/settings.ts` | Add 6 settings, update defaults, reorganize Folders UI section |
| `src/people.ts` | Accept folder params instead of hardcoded paths |
| `src/templates.ts` | Accept folder param in `initTemplates()` and `renderTemplate()` |
| `src/initVault.ts` | Create all configured folders from settings |
| `src/skills.ts` | Add folder variables to post_action template vars + folder injection in `runSkillInBackground()` |
| `src/panel.tsx` | Pass folder settings to people calls, inject folder context into skill prompts |
| `src/main.ts` | Pass settings to initVault |
| `src/notifications.ts` | Use `getPersonMeetingFolder()` with settings instead of hardcoded 1:1 path |
| `src/smartContext.ts` | Use `settings.templatesFolder` for exclusion filter |
| `src/embeddingIndexer.ts` | Use configured `templatesFolder` for exclusion filter |
| `OpenBrain/skills/meeting-agent.md` | Use `{{meetings_folder}}` in post_actions |
| `OpenBrain/skills/weekly-review.md` | Use `{{reviews_folder}}` in post_actions |
| `OpenBrain/skills/monthly-review.md` | Use `{{reviews_folder}}` in post_actions + update system prompt `Meetings/` reference |
| `OpenBrain/skills/project-setup.md` | Reference configurable projects folder |
| `OpenBrain/skills/project-tracker.md` | Reference configurable projects folder |
| `OpenBrain/skills/person-setup.md` | Reference configurable people folder |
| `OpenBrain/skills/note-organizer.md` | Update hardcoded filing table (`Meetings/`, `Projects/`, etc.) |
| `OpenBrain/skills/vault-health.md` | Update hardcoded folder references in audit instructions |
| `OpenBrain/skills/meeting-prep.md` | Update hardcoded `OpenBrain/people/` reference |

## Files Not Modified

- `src/chatEngine.ts` — no folder references
- `src/providers/*` — no folder references
- `src/chatHistory.ts` — uses `chatFolder` setting (already configurable)
- `src/attachmentManager.ts` — uses `chatFolder` for assets (already configurable)
