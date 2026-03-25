# Work Day / Weekend Awareness

## Problem

OpenBrain treats every day the same. It nags about tasks, suggests meeting prep, and fires work-oriented skills on Saturday morning. Users who use OpenBrain for both work and personal note-taking want the assistant to adapt its personality and behavior to the kind of day it is.

## Solution

OpenBrain detects whether today is a work day or weekend based on a configurable `workDays` setting. It swaps the system prompt (professional vs casual) and gates skill auto-scheduling so work skills don't fire on weekends. Work skills remain manually available on weekends — just not pushed.

## Day Mode Detection

A `getDayMode(settings)` utility returns `"work"` or `"weekend"` based on the current day-of-week and the user's `workDays` array.

```typescript
// src/dayMode.ts
export function getDayMode(workDays: number[]): "work" | "weekend" {
  const today = new Date().getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  return workDays.includes(today) ? "work" : "weekend";
}
```

Default `workDays`: `[1, 2, 3, 4, 5]` (Monday through Friday).

## System Prompt Switching

Two system prompt files in the vault:

- `OpenBrain/system-prompt-work.md` — professional, task-oriented. Seeded from the current `system-prompt.md` content on first run (or migration).
- `OpenBrain/system-prompt-weekend.md` — warm, casual, exploratory. Seeded with a distinct personality that avoids work-oriented phrasing.

**Weekend prompt personality (seed content):**
```
You are OpenBrain, an AI assistant embedded in Obsidian. It's your user's day off.
Be warm, casual, and exploratory. Don't push tasks, meetings, or deadlines unless
asked. Suggest creative ideas, help with personal projects, or just have a
conversation. Use [[wikilinks]] when referencing notes. Use vault-relative paths only.
Search the vault before answering questions about it. Read files before editing them.
```

**Loading logic:** `loadSystemPrompt()` in `main.ts` currently reads `OpenBrain/system-prompt.md`. Change it to:

1. Call `getDayMode(settings.workDays)`
2. If `"work"` → read `OpenBrain/system-prompt-work.md`
3. If `"weekend"` → read `OpenBrain/system-prompt-weekend.md`
4. Fallback: if the day-specific file doesn't exist, read `OpenBrain/system-prompt.md` (backwards compatibility)

**Migration:** On first run after this feature ships, if `system-prompt.md` exists but `system-prompt-work.md` does not, copy `system-prompt.md` → `system-prompt-work.md` and create `system-prompt-weekend.md` with the seed content. Leave the original `system-prompt.md` in place as a fallback.

**Day change:** The system prompt is loaded once on plugin load. If the user leaves Obsidian open past midnight and the day mode changes, the prompt won't update until restart. This is acceptable — most users restart Obsidian daily.

## Scheduler Gating

Each `ScheduleConfig` gains an optional `dayMode` field:

```typescript
interface ScheduleConfig {
  skillName: string;
  schedule: string;
  action: "notify" | "run";
  requiresSetting?: keyof OpenBrainSettings;
  dayMode?: "work" | "weekend"; // only fire on matching day mode
}
```

During `checkSchedules()`, skip any config whose `dayMode` doesn't match `getDayMode(settings.workDays)`.

Default schedule gating:
- `Morning Briefing` → `dayMode: "work"`
- `End of Day` → `dayMode: "work"`
- `Graph Enrichment` → no gate (runs regardless)
- `Graph Health` → no gate (runs regardless)
- `Weekly Review` → no gate (runs regardless)

## Skill Frontmatter

Skills can declare `day_mode` in their YAML frontmatter:

```yaml
---
name: Meeting Agent
day_mode: work
---
```

Valid values: `"work"`, `"weekend"`, or omitted (no restriction).

**Effect of `day_mode`:**
- Skills with a `day_mode` that doesn't match the current day still appear in the skill list and can be manually activated
- They will NOT auto-trigger (if they have a `trigger` field) on non-matching days
- They will NOT auto-schedule on non-matching days

**Gating in the `daily-note-created` trigger hook:** The existing trigger handler in `main.ts` (lines 462-475) fires skills with `trigger: "daily-note-created"` when a daily note is created. This runs outside the scheduler — it must also check `skill.dayMode` against `getDayMode()` and skip skills that don't match. Without this, `morning-briefing.md` (which fires via this trigger, not the scheduler) would still run on weekends.

**Dual-gate combination rule:** When both `ScheduleConfig.dayMode` and `skill.dayMode` exist, either gate can block firing. If `ScheduleConfig.dayMode` is set and doesn't match → skip. If the matched skill's `dayMode` is set and doesn't match → skip. If neither is set → always fire. In other words: both must pass (or be absent) for the skill to fire.

**Parsing:** `parseSkillFile()` in `skills.ts` reads `frontmatter.day_mode` and stores it as `skill.dayMode: "work" | "weekend" | undefined`.

## Settings

Add to `OpenBrainSettings` interface:

```typescript
workDays: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
```

Default: `[1, 2, 3, 4, 5]`

### Settings UI

In the Advanced tab, add a "Schedule" section before "Knowledge graph":

**Work days** — Seven small toggle buttons (S M T W T F S), each representing a day. Pressed/highlighted = work day. Default: Mon-Fri highlighted.

Description: "OpenBrain adapts its personality and skill scheduling based on whether today is a work day. Work skills won't auto-trigger on your days off."

## Onboarding

The existing onboarding flow in `panel.tsx` has 3 steps. Add a 4th step:

**Step 4: "Which days are your work days?"**

Seven day-of-week checkboxes (Mon-Fri pre-checked). Single tap to toggle. Written to `settings.workDays` immediately. Brief explanation: "OpenBrain will adjust its tone and suggestions based on your schedule."

This step appears after the existing onboarding steps (API key, permissions, etc.). Note: the `onboardingStep` type in `panel.tsx` must be widened from `1 | 2 | 3` to `1 | 2 | 3 | 4`.

## Existing Skill Updates

Add `day_mode: work` to the frontmatter of these existing skills:
- `meeting-agent.md`
- `meeting-prep.md`
- `one-on-one.md`
- `end-of-day.md`
- `morning-briefing.md`
- `project-tracker.md`

Leave these without a day_mode (run any day):
- `weekly-review.md`
- `monthly-review.md`
- `vault-health.md`
- `graph-enrichment.md`
- `graph-health.md`
- `note-organizer.md`
- `person-setup.md`
- `project-setup.md`
- `create-skill.md`

## New Files

| File | Purpose |
|------|---------|
| `src/dayMode.ts` | `getDayMode(workDays): "work" \| "weekend"` utility function |
| `OpenBrain/system-prompt-weekend.md` | Weekend personality system prompt (seeded on first run) |

## Modified Files

| File | Change |
|------|--------|
| `src/settings.ts` | Add `workDays: number[]` to interface + defaults. Add "Schedule" section in Advanced tab with day toggle buttons. |
| `src/main.ts` | Update `loadSystemPrompt()` to pick work/weekend file. Migrate existing `system-prompt.md` to `system-prompt-work.md` on first run. Gate `daily-note-created` trigger handler by `skill.dayMode`. Update "Open system prompt" settings button to open the day-appropriate file. |
| `src/scheduler.ts` | Add `dayMode` to `ScheduleConfig`. Check day mode in `checkSchedules()`. Gate work skills. |
| `src/skills.ts` | Parse `day_mode` from frontmatter. Add `dayMode` to `Skill` interface. |
| `src/panel.tsx` | Add onboarding step 4: work days picker. |
| `src/initVault.ts` | Create `system-prompt-weekend.md` during vault initialization if it doesn't exist. |

## What This Does NOT Include

- No per-hour personality shifts (morning vs evening) — keep it simple
- No weekend-specific skills — just suppress work skills
- No automatic day-change detection while running — requires restart
- No "vacation mode" or custom modes beyond work/weekend
